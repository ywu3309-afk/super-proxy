"""Offline structured-text tool protocol tests; never starts TRAE or a socket."""
import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "hub"))
import wb_trae_tools as bridge


def tool(name="read_file", **extra):
    return {"type": "function", "function": {
        "name": name, "description": "Read a file without executing it.", "strict": True,
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}},
                       "required": ["path"], "additionalProperties": False}, **extra}}


def request(**extra):
    return {"model": "trae/fixture", "tools": [tool()],
            "messages": [{"role": "user", "content": "读取 文档😀.txt"}], **extra}


def output(plan, calls=None, content="done", **extra):
    return json.dumps({"bridge_nonce": plan.nonce, "content": content,
                       "tool_calls": calls or [], **extra}, ensure_ascii=False)


def history(call_id="call_previous", name="read_file", arguments='{"path":"文档😀.txt"}'):
    return [{"role": "assistant", "content": None, "tool_calls": [
        {"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}]},
        {"role": "tool", "tool_call_id": call_id, "content": "contents"}]


class ToolBridgeTests(unittest.TestCase):
    def assert_error(self, callback, code=None, status=None):
        with self.assertRaises(bridge.ToolBridgeError) as raised:
            callback()
        if code:
            self.assertEqual(raised.exception.code, code)
        if status:
            self.assertEqual(raised.exception.status, status)
        return raised.exception

    def test_plain_text_is_not_changed_or_wrapped(self):
        p = {"messages": [{"role": "user", "content": '{"tool_calls":[]}' }]}
        before = copy.deepcopy(p)
        self.assertIsNone(bridge.prepare(p))
        self.assertEqual(p, before)

    def test_empty_tools_validate_choice_and_parallel_without_bridge(self):
        for choice in ("none", "auto"):
            self.assertIsNone(bridge.prepare(request(tools=[], tool_choice=choice)))
        for value in (None, 1, "false", []):
            self.assert_error(lambda: bridge.prepare(request(tools=[], parallel_tool_calls=value)))
        self.assert_error(lambda: bridge.prepare(request(tools=[], tool_choice="required")))
        self.assert_error(lambda: bridge.prepare(request(tools=[], tool_choice={"type": "function", "function": {"name": "read_file"}})))

    def test_data_keeps_unicode_tool_definitions_and_all_roles_losslessly(self):
        p = request(messages=[{"role": "system", "content": "s"},
                              {"role": "developer", "content": "d"},
                              {"role": "user", "content": [{"type": "text", "text": "😀\n读"}]}] + history())
        before = copy.deepcopy(p)
        plan = bridge.prepare(p)
        data = json.loads(plan.messages[1]["content"][0]["text"])
        self.assertEqual(data["messages"], before["messages"])
        self.assertEqual(data["tools"], before["tools"])
        self.assertEqual(p, before)
        self.assertEqual(len(plan.nonce), 32)
        self.assertIn("does NOT execute tools", plan.messages[0]["content"][0]["text"])

    def test_final_answer_and_code_json_stay_content(self):
        plan = bridge.prepare(request())
        code = '{"tool_calls":["not an actual call"]}\n```py\nprint("你好")\n```'
        self.assertEqual(plan.parse(output(plan, content=code)),
                         {"content": code, "tool_calls": [], "finish_reason": "stop"})

    def test_tool_calls_have_local_unique_ids_and_json_arguments(self):
        plan = bridge.prepare(request())
        result = plan.parse(output(plan, [{"name": "read_file", "arguments": {"path": "文档😀.txt"}}], None))
        call = result["tool_calls"][0]
        self.assertRegex(call["id"], r"^call_[0-9a-f]{32}$")
        self.assertEqual(call["type"], "function")
        self.assertEqual(json.loads(call["function"]["arguments"]), {"path": "文档😀.txt"})
        self.assertEqual(result["finish_reason"], "tool_calls")
        again = plan.parse(output(plan, [{"name": "read_file", "arguments": {"path": "x"}}]))
        self.assertNotEqual(call["id"], again["tool_calls"][0]["id"])

    def test_parallel_and_multi_round_history(self):
        messages = [{"role": "user", "content": "read twice"}] + history("a") + history("b")
        plan = bridge.prepare(request(messages=messages))
        calls = [{"name": "read_file", "arguments": {"path": x}} for x in ("a", "b")]
        self.assertEqual(len(plan.parse(output(plan, calls))["tool_calls"]), 2)
        no_parallel = bridge.prepare(request(parallel_tool_calls=False))
        self.assert_error(lambda: no_parallel.parse(output(no_parallel, calls)), status=502)

    def test_forced_required_and_none_are_enforced(self):
        calls = [{"name": "read_file", "arguments": {"path": "x"}}]
        for choice in ("required", {"type": "function", "function": {"name": "read_file"}}):
            plan = bridge.prepare(request(tool_choice=choice))
            self.assertEqual(plan.parse(output(plan, calls))["finish_reason"], "tool_calls")
            self.assert_error(lambda: plan.parse(output(plan)), status=502)
        none = bridge.prepare(request(tool_choice="none"))
        self.assertEqual(none.parse(output(none))["finish_reason"], "stop")
        self.assert_error(lambda: none.parse(output(none, calls)), status=502)

    def test_forced_rejects_another_declared_tool(self):
        plan = bridge.prepare(request(tools=[tool(), tool("write_file")], tool_choice={
            "type": "function", "function": {"name": "read_file"}}))
        self.assert_error(lambda: plan.parse(output(plan, [{"name": "write_file", "arguments": {"path": "x"}}])), status=502)

    def test_invalid_tool_definitions_and_choices(self):
        invalid = [[], {"type": "computer"}, {"type": "function", "function": []}, tool("bad.name"),
                   tool(strict="true"), tool(description=5), tool(parameters={"type": "string"})]
        for value in invalid:
            self.assert_error(lambda: bridge.prepare(request(tools=[value])))
        self.assert_error(lambda: bridge.prepare(request(tools=[tool(), tool()])))
        for value in (None, True, "sometimes", {}, {"type": "function", "function": {"name": "missing"}}):
            self.assert_error(lambda: bridge.prepare(request(tool_choice=value)))
        for value in (None, {}, "functions"):
            self.assert_error(lambda: bridge.prepare(request(tools=value)))

    def test_legacy_function_protocol_and_multimodal_fail(self):
        self.assert_error(lambda: bridge.prepare(request(functions=[])), "unsupported_feature")
        self.assert_error(lambda: bridge.prepare(request(messages=[{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "https://fixture.invalid/image"}}]}])))

    def test_history_rejects_missing_duplicate_invalid_names_and_bad_json(self):
        bad = [history()[:1], history()[1:], history() + history(),
               history(name="bad.name"), history(name=None),
               history(arguments='{"path":"x","path":"y"}'),
               history(arguments='{"path":NaN}'), history(arguments='[]')]
        h = history(); h[-1]["tool_call_id"] = "unmatched"; bad.append(h)
        h = history(); h.append(dict(h[-1])); bad.append(h)
        h = history(); h.insert(1, {"role": "user", "content": "skip tools"}); bad.append(h)
        for messages in bad:
            self.assert_error(lambda: bridge.prepare(request(messages=messages)), "invalid_tool_history")

    def test_previous_tools_can_be_removed_and_previous_schemas_can_change(self):
        plan = bridge.prepare(request(tools=[], messages=history(), tool_choice="none"))
        self.assertEqual(plan.parse(output(plan, content="finished")),
                         {"content": "finished", "tool_calls": [], "finish_reason": "stop"})
        self.assertEqual(json.loads(plan.messages[1]["content"][0]["text"])["messages"], history())
        changed = bridge.prepare(request(messages=history(arguments='{"path":1}')))
        self.assertEqual(changed.parse(output(changed))["finish_reason"], "stop")
        # New calls still must use the current declared schema and names.
        self.assert_error(lambda: plan.parse(output(plan, [{"name": "read_file", "arguments": {"path": "x"}}])), status=502)

    def test_text_content_blocks_preserve_cache_metadata(self):
        p = request(messages=[{"role": "user", "content": [{
            "type": "text", "text": "hello", "cache_control": {"type": "ephemeral"}}]}])
        plan = bridge.prepare(p)
        data = json.loads(plan.messages[1]["content"][0]["text"])
        self.assertEqual(data["messages"], p["messages"])

    def test_parallel_history_results_may_arrive_out_of_order(self):
        h = history()
        second = copy.deepcopy(h[0]["tool_calls"][0]); second["id"] = "second"
        h[0]["tool_calls"].append(second)
        h.insert(1, {"role": "tool", "tool_call_id": "second", "content": "second result"})
        self.assertIsNotNone(bridge.prepare(request(messages=h)))

    def test_output_strict_structure_nonce_and_no_markdown(self):
        plan = bridge.prepare(request())
        invalid = ["tool_calls incomplete", "prefix ```json\n" + output(plan) + "\n```", "[]",
                   output(plan, extra=True), output(plan).replace(plan.nonce, "wrong"),
                   output(plan) + " trailing", output(plan, content=None), output(plan, content=[]),
                   '{"bridge_nonce":"' + plan.nonce + '","content":"x","content":"y","tool_calls":[]}',
                   '{"bridge_nonce":"' + plan.nonce + '","content":NaN,"tool_calls":[]}',
                   output(plan).replace('"tool_calls": []', '"tool_calls": {}')]
        for value in invalid:
            self.assert_error(lambda: plan.parse(value), "invalid_tool_response", 502)
        self.assert_error(lambda: plan.parse(" " * (bridge.MAX_OUTPUT_CHARS + 1)), status=502)

    def test_full_json_fence_preserves_strict_nonce_tools_and_parameters(self):
        plan = bridge.prepare(request())
        call = {"name": "read_file", "arguments": {"path": "x"}}
        for language in ("json", "JSON"):
            result = plan.parse(" \n```" + language + "\n" + output(plan, [call], None) + "\n```\n ")
            self.assertEqual(result["finish_reason"], "tool_calls")
            self.assertEqual(result["tool_calls"][0]["function"]["name"], "read_file")
            self.assertNotIn("response_format", result)
        invalid = [output(plan).replace(plan.nonce, "bad"), output(plan, [{"name": "missing", "arguments": {}}]),
                   output(plan, [{"name": "read_file", "arguments": {"path": 1}}]),
                   '{"bridge_nonce":"' + plan.nonce + '","content":"a","content":"b","tool_calls":[]}']
        for text in invalid:
            self.assert_error(lambda: plan.parse("```json\n" + text + "\n```"), status=502)
        for text in ("before\n```json\n" + output(plan) + "\n```", "```json\n" + output(plan) + "\n```\nafter",
                     "```python\n" + output(plan) + "\n```", "```json\nhello\n```",
                     "```json\n" + output(plan) + "\n```\n```json\n" + output(plan) + "\n```"):
            self.assert_error(lambda: plan.parse(text), status=502)

    def test_only_auto_none_can_use_obvious_plain_text_final(self):
        for choice in ("auto", "none"):
            plan = bridge.prepare(request(tool_choice=choice))
            for text in ("你好！有什么可以帮你？", "Hello! How can I help?", "  A final answer.\n谢谢！  ",
                         "A function accepts arguments and parameters. The tool_choice is auto.",
                         "Here is an array [] and an object {}.", "`code`", "<h1>Hello</h1>",
                         '```python\nprint({"hello": []})\n```', "Saved to D:\\example\\result.txt."):
                self.assertEqual(plan.parse(text), {"content": text, "tool_calls": [], "finish_reason": "stop",
                                                   "response_format": "plain_text_final"})
        for choice in ("required", {"type": "function", "function": {"name": "read_file"}}):
            plan = bridge.prepare(request(tool_choice=choice))
            self.assert_error(lambda: plan.parse("你好！"), status=502)

    def test_single_missing_outer_brace_is_only_a_marked_final_text(self):
        for choice in ("auto", "none"):
            plan = bridge.prepare(request(tool_choice=choice))
            text = '你好！代码示例 {"value": [1]} 不应被改动。'
            self.assertEqual(plan.parse(" \n" + output(plan, content=text)[:-1] + " \n"),
                             {"content": text, "tool_calls": [], "finish_reason": "stop",
                              "response_format": "single_outer_close_final"})
        for choice in ("required", {"type": "function", "function": {"name": "read_file"}}):
            plan = bridge.prepare(request(tool_choice=choice))
            self.assert_error(lambda: plan.parse(output(plan)[:-1]), status=502)

    def test_outer_brace_compat_never_repairs_calls_nonce_schema_or_other_syntax(self):
        plan = bridge.prepare(request())
        call = {"name": "read_file", "arguments": {"path": "x"}}
        invalid = [output(plan, [call], None)[:-1], output(plan, [call], "Calling tool")[:-1],
                   output(plan).replace(plan.nonce, "wrong")[:-1], output(plan, content=None)[:-1],
                   output(plan, content="")[:-1], output(plan, content="  ")[:-1],
                   output(plan, content=[])[:-1], output(plan, extra=True)[:-1], output(plan)[:-2],
                   output(plan).replace('"done"', '"unterminated')[:-1],
                   output(plan).replace('"done"', '"\\ud800"')[:-1],
                   '{"bridge_nonce":"' + plan.nonce + '","content":"a","content":"b","tool_calls":[]',
                   'prose ' + output(plan)[:-1], '```json\n' + output(plan)[:-1] + '\n```']
        for text in invalid:
            self.assert_error(lambda: plan.parse(text), "invalid_tool_response", 502)
        plan.max_output_chars = len(output(plan)) - 1
        self.assert_error(lambda: plan.parse(output(plan)[:-1]), status=502)

    def test_plain_text_fallback_never_repairs_suspected_protocol(self):
        plan = bridge.prepare(request())
        bad = ["", "   ", "{", "[", "<tool_call>read_file</tool_call>",
               "<｜tool▁calls▁begin｜>", "bridge_nonce: missing", 'Here is JSON: {"tool_calls":',
               "tool_calls: missing", "tool_call: missing", "function_call: missing", "call_deadbeef", "NaN", "Infinity",
               "undefined", "hello " + plan.nonce, "hello\ud800", "hello\x00", '"unterminated',
               "1e999", "true", "null", '"ordinary valid JSON string"']
        for text in bad:
            self.assert_error(lambda: plan.parse(text), "invalid_tool_response", 502)

    def test_trailing_format_reminder_uses_same_nonce_and_counts_toward_limit(self):
        plan = bridge.prepare(request())
        self.assertEqual([message["role"] for message in plan.messages], ["system", "user", "system"])
        reminder = plan.messages[-1]["content"][0]["text"]
        self.assertIn(plan.nonce, reminder)
        self.assertIn('"tool_calls":[]', reminder)
        self.assertIn("INSIDE content", reminder)
        self.assertIn("required/forced", reminder)
        self.assertIn("```json\n", reminder)
        self.assertIn("closing outer }", reminder)
        length = sum(len(message["content"][0]["text"].encode("utf-16-le")) // 2 for message in plan.messages)
        from unittest import mock
        with mock.patch.object(bridge, "MAX_PROMPT_UTF16", length - 1):
            self.assert_error(lambda: bridge.prepare(request()), "request_too_large", 413)

    def test_unknown_tools_arguments_extra_keys_and_calls_limit_fail(self):
        plan = bridge.prepare(request())
        invalid = [{"name": "read_file", "arguments": '{"path":"x"}'},
                   {"name": "read_file", "arguments": {"path": 1}},
                   {"name": "read_file", "arguments": {"path": "x", "secret": "y"}},
                   {"name": "read_file", "arguments": {}}, {"name": "unknown", "arguments": {}},
                   {"name": [], "arguments": {}}, {"name": "read_file", "arguments": {"path": "x"}, "id": "injected"}]
        for call in invalid:
            self.assert_error(lambda: plan.parse(output(plan, [call])), status=502)
        self.assert_error(lambda: plan.parse(output(plan, [{"name": "read_file", "arguments": {"path": "x"}}] * 65)), status=502)

    def test_schema_common_types_arrays_enum_anyof_and_additional_properties(self):
        schema = {"type": "object", "properties": {
            "path": {"anyOf": [{"type": "string", "enum": ["中文", "x"]}, {"type": "null"}]},
            "values": {"type": "array", "items": {"type": "integer"}, "minItems": 1, "maxItems": 2},
            "flag": {"type": "boolean"}}, "required": ["path", "values"], "additionalProperties": False}
        plan = bridge.prepare(request(tools=[tool(parameters=schema)]))
        def parse(args):
            return plan.parse(output(plan, [{"name": "read_file", "arguments": args}]))
        self.assertEqual(parse({"path": "中文", "values": [1, 2], "flag": False})["finish_reason"], "tool_calls")
        self.assertEqual(parse({"path": None, "values": [1]})["finish_reason"], "tool_calls")
        for args in ({"path": "wrong", "values": [1]}, {"path": "x", "values": []},
                     {"path": "x", "values": [True]}, {"path": "x", "values": [1], "flag": 1}):
            self.assert_error(lambda: parse(args), status=502)

    def test_schema_constraints_and_boolean_numeric_enum_are_distinct(self):
        schema = {"type": "object", "properties": {
            "num": {"type": "number", "minimum": 1, "exclusiveMaximum": 3},
            "s": {"type": "string", "minLength": 1, "maxLength": 3, "pattern": "^[a-z]+$"},
            "e": {"enum": [1]}}, "required": ["num", "s", "e"]}
        plan = bridge.prepare(request(tools=[tool(parameters=schema)]))
        def parse(args):
            return plan.parse(output(plan, [{"name": "read_file", "arguments": args}]))
        self.assertEqual(parse({"num": 2, "s": "abc", "e": 1})["finish_reason"], "tool_calls")
        for args in ({"num": 3, "s": "abc", "e": 1}, {"num": 1, "s": "AB", "e": 1},
                     {"num": 1, "s": "a", "e": True}):
            self.assert_error(lambda: parse(args), status=502)

    def test_bad_schema_and_unsupported_strict_keywords_fail_explicitly(self):
        bad = [{"type": "nonsense"}, {"type": "object", "properties": []},
               {"type": "object", "required": ["x", "x"]}, {"type": "object", "items": []},
               {"type": "object", "enum": []}, {"type": "object", "anyOf": []},
               {"type": "object", "minItems": True}, {"type": "object", "pattern": "["}]
        for schema in bad:
            self.assert_error(lambda: bridge.prepare(request(tools=[tool(parameters=schema)])))
        self.assert_error(lambda: bridge.prepare(request(tools=[tool(parameters={"type": "object", "$ref": "#/$defs/x"})])), "unsupported_tool_schema")

    def test_nonce_is_request_local_and_schema_is_snapshotted(self):
        p = request()
        a, b = bridge.prepare(p), bridge.prepare(p)
        self.assertNotEqual(a.nonce, b.nonce)
        self.assert_error(lambda: b.parse(output(a)), status=502)
        p["tools"][0]["function"]["parameters"]["properties"]["path"]["type"] = "number"
        self.assertEqual(a.parse(output(a, [{"name": "read_file", "arguments": {"path": "x"}}]))["finish_reason"], "tool_calls")

    def test_invalid_unicode_and_deep_json_are_controlled_errors(self):
        plan = bridge.prepare(request())
        self.assert_error(lambda: plan.parse(output(plan).replace('"done"', '"\\ud800"')), status=502)
        nested = "x"
        for _ in range(70):
            nested = [nested]
        self.assert_error(lambda: bridge.prepare(request(extra=nested)), "invalid_request", 400)
        self.assert_error(lambda: plan.parse(output(plan).replace('"done"', json.dumps(nested))), status=502)

    def test_integral_json_number_is_valid_integer_but_boolean_is_not(self):
        schema = {"type": "object", "properties": {"n": {"type": "integer"}}}
        plan = bridge.prepare(request(tools=[tool(parameters=schema)]))
        valid = [{"name": "read_file", "arguments": {"n": 1.0}}]
        self.assertEqual(plan.parse(output(plan, valid))["finish_reason"], "tool_calls")
        valid[0]["arguments"]["n"] = True
        self.assert_error(lambda: plan.parse(output(plan, valid)), status=502)

    def test_nonfinite_input_output_and_request_prompt_limits(self):
        self.assert_error(lambda: bridge.prepare(request(temperature=float("nan"))), "invalid_request", 400)
        plan = bridge.prepare(request())
        self.assert_error(lambda: plan.parse(output(plan, [{"name": "read_file", "arguments": {"path": 1e300}}]).replace("1e+300", "1e999")), status=502)
        self.assert_error(lambda: bridge.prepare(request(messages=[{"role": "user", "content": "😀" * 33000}])), "request_too_large", 413)
        self.assert_error(lambda: bridge.prepare(request(extra="x" * bridge.MAX_REQUEST_BYTES)), "request_too_large", 413)

    def test_long_history_is_compacted_without_changing_tool_definitions(self):
        messages = ([{"role": "system", "content": "keep system"}] +
                    [{"role": "user" if index % 2 == 0 else "assistant",
                      "content": f"old-{index} " + "x" * 5000} for index in range(20)] +
                    [{"role": "user", "content": "latest request"}])
        original = copy.deepcopy(messages)
        plan = bridge.prepare(request(messages=messages))
        data = json.loads(plan.messages[1]["content"][0]["text"])
        combined = "".join(message["content"][0]["text"] for message in plan.messages)
        self.assertLessEqual(bridge._utf16_length(combined), bridge.PROMPT_BUDGET_UTF16)
        self.assertEqual(data["tools"], request()["tools"])
        self.assertEqual(data["messages"][0], {"role": "system", "content": bridge.HISTORY_NOTICE})
        self.assertEqual(data["messages"][-1], {"role": "user", "content": "latest request"})
        self.assertLess(len(data["messages"]), len(messages))
        self.assertEqual(messages, original)

    def test_oversized_current_tool_history_message_is_rejected_not_sliced(self):
        messages = [{"role": "system", "content": "keep system"},
                    {"role": "user", "content": "😀" * 33000}]
        self.assert_error(lambda: bridge.prepare(request(messages=messages)), "request_too_large", 413)

    def test_huge_permission_set_falls_back_to_tool_index_instead_of_413(self):
        tools = []
        for index in range(128):
            properties = {
                "value_%03d" % field: {"type": "string"}
                for field in range(20)
            }
            tools.append(tool(
                "tool_%d" % index,
                parameters={"type": "object", "properties": properties,
                            "required": list(properties)}))
        plan = bridge.prepare(request(tools=tools))
        data = json.loads(plan.messages[1]["content"][0]["text"])
        self.assertEqual(len(data["tools"]), 128)
        self.assertEqual(data["tools"][0]["name"], "tool_0")
        self.assertLessEqual(bridge._utf16_length("".join(
            item["content"][0]["text"] for item in plan.messages)),
            bridge.PROMPT_BUDGET_UTF16)
        # Local validation still uses the original complete schema snapshot.
        self.assertEqual(plan.parse(output(plan, content="你好"))["finish_reason"], "stop")


if __name__ == "__main__":
    unittest.main()
