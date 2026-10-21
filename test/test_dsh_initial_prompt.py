"""DSH initial-instruction text handling; synthetic data, no real client files."""
import copy
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))
with patch.dict(os.environ, {
    "ACCOUNTS_DIR": str(ROOT / "analysis" / "initial-prompt-unused" / "accounts"),
    "WB_PROXY_USAGE_DIR": str(ROOT / "analysis" / "initial-prompt-unused" / "usage"),
}):
    import wb_proxy


IDENTITY = "You are an AI agent powered by DeepSeek Harness."
EXPECTED = "You are an AI agent powered by DeepSeek."


class InitialHarnessPromptTests(unittest.TestCase):
    def rewrite(self, messages):
        return wb_proxy.sanitize_initial_harness_prompt(messages)

    def test_initial_system_and_developer_strings_are_processed(self):
        messages = [{"role": "system", "content": IDENTITY},
                    {"role": "developer", "content": "DeepSeek Harness is the interface."},
                    {"role": "user", "content": "hello"}]
        result = self.rewrite(messages)
        self.assertEqual(result[0]["content"], EXPECTED)
        self.assertEqual(result[1]["content"], "DeepSeek is the interface.")
        self.assertEqual(result[2], messages[2])

    def test_case_spaces_tabs_multiple_occurrences_and_sentence_end(self):
        for source in ("DeepSeek Harness", "deepseek harness", "DEEPSEEK HARNESS",
                       "DeepSeek\tHarness", "DeepSeek \t Harness", "DeepSeek Harness."):
            with self.subTest(source=source):
                result = self.rewrite([{"role": "system", "content": source}])
                expected = "DeepSeek." if source.endswith(".") else "DeepSeek"
                self.assertEqual(result[0]["content"], expected)
        source = "Use DeepSeek Harness, then DeepSeek Harness!"
        self.assertEqual(self.rewrite([{"role": "system", "content": source}])[0]["content"],
                         "Use DeepSeek, then DeepSeek!")

    def test_only_text_and_input_text_blocks_are_processed(self):
        blocks = [{"type": "text", "text": IDENTITY, "id": "keep"},
                  {"type": "input_text", "text": "DeepSeek Harness", "custom": {"brand": "DeepSeek Harness"}},
                  {"type": "image_url", "image_url": {"url": "https://fixture.invalid/DeepSeek Harness.png"}},
                  {"type": "input_image", "image_url": "data:image/png;base64,fixture", "text": "DeepSeek Harness"},
                  {"type": "output_text", "text": "DeepSeek Harness"},
                  {"type": "text", "text": None}, "DeepSeek Harness", None]
        messages = [{"role": "system", "content": blocks}]
        before = copy.deepcopy(messages)
        result = self.rewrite(messages)
        expected = copy.deepcopy(messages)
        expected[0]["content"][0]["text"] = EXPECTED
        expected[0]["content"][1]["text"] = "DeepSeek"
        self.assertEqual(result, expected)
        self.assertEqual(messages, before)
        self.assertEqual(result[0]["content"][1]["custom"], blocks[1]["custom"])

    def test_first_noninstruction_message_stops_all_later_processing(self):
        for middle in ({"role": "user", "content": IDENTITY},
                       {"role": "assistant", "content": IDENTITY},
                       {"role": "tool", "content": IDENTITY},
                       {"role": "function", "content": IDENTITY},
                       {"role": "unknown", "content": IDENTITY},
                       {"content": IDENTITY}, "not a message dict", None):
            with self.subTest(middle=middle):
                messages = [{"role": "system", "content": IDENTITY}, middle,
                            {"role": "system", "content": IDENTITY},
                            {"role": "developer", "content": IDENTITY}]
                before = copy.deepcopy(messages)
                result = self.rewrite(messages)
                self.assertEqual(result[0]["content"], EXPECTED)
                self.assertEqual(result[1:], before[1:])
                self.assertEqual(messages, before)

    def test_no_initial_instruction_block_means_no_changes_or_copy(self):
        for first in ({"role": "user", "content": IDENTITY},
                      {"role": "assistant", "content": IDENTITY},
                      {"role": "tool", "content": IDENTITY}, None):
            with self.subTest(first=first):
                messages = [first, {"role": "system", "content": IDENTITY}]
                self.assertIs(self.rewrite(messages), messages)

    def test_noncontent_fields_and_all_history_are_untouched(self):
        fields = {
            "name": "DeepSeek Harness", "reasoning_content": IDENTITY,
            "tool_calls": [{"id": "call-1", "type": "function", "function": {
                "name": "DeepSeek Harness", "arguments": '{"brand":"DeepSeek Harness"}'}}],
            "metadata": {"brand": "DeepSeek Harness"},
            "tools": [{"function": {"description": IDENTITY}}],
        }
        initial = {"role": "system", "content": IDENTITY, **fields}
        history = [{"role": "user", "content": IDENTITY},
                   {"role": "assistant", "content": IDENTITY, **copy.deepcopy(fields)},
                   {"role": "tool", "content": '{"brand":"DeepSeek Harness"}', "tool_call_id": "call-1"},
                   {"role": "system", "content": IDENTITY}]
        messages = [initial, *history]
        before = copy.deepcopy(messages)
        result = self.rewrite(messages)
        expected = copy.deepcopy(before)
        expected[0]["content"] = EXPECTED
        self.assertEqual(result, expected)
        self.assertEqual(messages, before)

    def test_embedded_tokens_urls_and_common_paths_and_filenames_are_not_text_brands(self):
        protected = (
            "myDeepSeek Harness", "DeepSeek HarnessExtra", "DeepSeek Harness_foo",
            "DeepSeek Harness.py", "DeepSeek Harness.md", "DeepSeek Harness.json",
            "DeepSeek Harness.tar.gz", "DeepSeek Harness/README.md",
            "C:\\Tools\\DeepSeek Harness", "C:\\Tools\\DeepSeek Harness\\main.py",
            "/opt/DeepSeek Harness", "/opt/DeepSeek Harness/bin",
            "./DeepSeek Harness", "../DeepSeek Harness", "~/.local/DeepSeek Harness",
            "https://fixture.invalid/DeepSeek Harness", "https://DeepSeek Harness.invalid/a",
            "https://fixture.invalid/?name=DeepSeek Harness",
            "file:///C:/Tools/DeepSeek Harness", "DeepSeek\nHarness",
        )
        for source in protected:
            with self.subTest(source=source):
                messages = [{"role": "system", "content": source}]
                self.assertIs(self.rewrite(messages), messages)
                self.assertEqual(messages[0]["content"], source)

    def test_copy_on_write_changes_only_content_without_mutating_input(self):
        untouched = {"role": "system", "content": "Keep this instruction."}
        changed = {"role": "developer", "content": IDENTITY, "metadata": {"keep": True}}
        user = {"role": "user", "content": IDENTITY}
        messages = [untouched, changed, user]
        before = copy.deepcopy(messages)
        result = self.rewrite(messages)
        self.assertIsNot(result, messages)
        self.assertIsNot(result[1], changed)
        self.assertIs(result[0], untouched)
        self.assertIs(result[2], user)
        self.assertEqual(messages, before)

    def test_empty_no_match_and_already_rewritten_input_preserve_object_identity(self):
        for messages in ([], [{"role": "system", "content": "ordinary"}],
                         [{"role": "system", "content": EXPECTED}],
                         [{"role": "system", "content": None}],
                         [{"role": "system", "content": []}]):
            with self.subTest(messages=messages):
                self.assertIs(self.rewrite(messages), messages)

    def test_idempotent_and_repeated_calls_do_not_mutate_prior_results(self):
        original = [{"role": "system", "content": IDENTITY}]
        rewritten = self.rewrite(original)
        before = copy.deepcopy(rewritten)
        self.assertIs(self.rewrite(rewritten), rewritten)
        self.assertEqual(rewritten, before)
        self.assertEqual(original[0]["content"], IDENTITY)

    def test_build_upstream_body_normalizes_developer_and_preserves_other_fields(self):
        payload = {
            "model": "deepseek-v4.1-flash", "thinking": {"type": "disabled"}, "stream": True,
            "metadata": {"brand": "DeepSeek Harness"},
            "messages": [
                {"role": "developer", "content": IDENTITY, "name": "DeepSeek Harness"},
                {"role": "user", "content": "Explain DeepSeek Harness."},
                {"role": "assistant", "content": None, "tool_calls": [{
                    "id": "fixture-call", "type": "function", "function": {
                        "name": "fixture_echo", "arguments": '{"brand":"DeepSeek Harness"}'}}]},
                {"role": "tool", "tool_call_id": "fixture-call", "content": '{"brand":"DeepSeek Harness"}'},
                {"role": "user", "content": "continue"},
            ],
            "tools": [{"type": "function", "function": {"name": "fixture_echo", "description": "DeepSeek Harness",
                       "parameters": {"type": "object", "properties": {"brand": {"type": "string"}}}}}],
        }
        before = copy.deepcopy(payload)
        with patch.object(wb_proxy, "apply_prompt_mode", side_effect=lambda messages: messages), \
             patch.object(wb_proxy, "model_default_max_output_tokens", return_value=None):
            actual = wb_proxy.build_upstream_body(payload)
        self.assertEqual(actual["messages"][0]["role"], "system")
        self.assertEqual(actual["messages"][0]["content"], EXPECTED)
        self.assertEqual(actual["messages"][0]["name"], "DeepSeek Harness")
        self.assertEqual(actual["messages"][1]["content"], "Explain DeepSeek Harness.")
        self.assertEqual(actual["messages"][2]["tool_calls"][0]["function"]["arguments"],
                         '{"brand":"DeepSeek Harness"}')
        self.assertEqual(actual["messages"][3]["content"], '{"brand":"DeepSeek Harness"}')
        self.assertEqual(actual["tools"], payload["tools"])
        self.assertEqual(payload, before)


if __name__ == "__main__":
    unittest.main()
