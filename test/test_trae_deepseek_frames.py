"""Offline DeepSeek framed-v2 contracts; no native process, socket or model request."""
import copy
import json
from pathlib import Path
import re
import sys
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'hub'))
sys.path.insert(0, str(ROOT))
import wb_trae_tools as bridge
import wb_trae as trae
from test import test_trae_native as fixtures

UPSTREAMS = ('deepseek-v4.1-flash', 'DeepSeek-V4-Flash-Official', 'DeepSeek-V4-Pro-Official')
MODELS = tuple('trae/' + mid for mid in UPSTREAMS)
BEGIN = 'WB_TOOL_BRIDGE_V2 '
CONTENT = 'WB_CONTENT '
CALL = 'WB_CALL '
ARGS = 'WB_ARGS '
END = 'WB_END '
PAD = 'WB_PAD 0000000000000000'


def tool(name='read_file', schema=None):
    return {'type': 'function', 'function': {'name': name, 'strict': True,
        'parameters': copy.deepcopy(schema or {'type': 'object', 'properties': {'path': {'type': 'string'}},
                                             'required': ['path'], 'additionalProperties': False})}}


def payload(**changes):
    return {'model': MODELS[0], 'messages': [{'role': 'user', 'content': '读取 文档😀.txt'}],
            'tools': [tool()], **changes}


def compact(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':'))


def frames_for_nonce(nonce, content='done', calls=(), padding=True):
    lines = [BEGIN + nonce, CONTENT + compact(content)]
    for call in calls:
        lines += [CALL + call['name'], ARGS + compact(call['arguments'])]
    lines.append(END + nonce)
    if padding:
        lines.append(PAD)
    return '\n'.join(lines)


def frames(plan, content='done', calls=(), padding=True):
    return frames_for_nonce(plan.nonce, content, calls, padding)


def call(path='文档😀.txt', name='read_file'):
    return {'name': name, 'arguments': {'path': path}}


class DeepSeekFrameTests(unittest.TestCase):
    def plan(self, **changes):
        plan = bridge.prepare(payload(**changes))
        self.assertIsNotNone(plan)
        self.assertEqual(plan.protocol, 'framed_json_v2')
        return plan

    def invalid(self, plan, text):
        with self.assertRaises(bridge.ToolBridgeError) as error:
            plan.parse(text)
        self.assertEqual((error.exception.status, error.exception.code), (502, 'invalid_tool_response'))

    def test_exact_protocol_constants_and_three_exact_deepseek_routes(self):
        for name, value in [('FRAME_BEGIN', BEGIN), ('FRAME_CONTENT', CONTENT), ('FRAME_CALL', CALL),
                            ('FRAME_ARGS', ARGS), ('FRAME_END', END), ('FRAME_PADDING', PAD)]:
            self.assertEqual(getattr(bridge, name), value)
        for model in MODELS:
            with self.subTest(model=model):
                plan = self.plan(model=model)
                self.assertEqual(plan.parse(frames(plan))['response_format'], 'framed_json_v2')
        for model in ('trae/glm-5.3-flashx', MODELS[0] + '-other', 'deepseek-v4.1-flash', MODELS[1].lower()):
            with self.subTest(non_deepseek=model):
                self.assertEqual(bridge.prepare(payload(model=model)).protocol, 'json_envelope')

    def test_no_tools_plain_chat_is_wrapped_for_all_three_deepseek_models_only(self):
        for model in MODELS:
            request = payload(model=model)
            del request['tools']
            original = copy.deepcopy(request)
            plan = bridge.prepare(request)
            self.assertIsNotNone(plan)
            self.assertEqual(plan.protocol, 'framed_json_v2')
            self.assertEqual(plan.tool_names, ())
            self.assertEqual(plan.parse(frames(plan, '你好，完整结尾😀。')),
                {'content': '你好，完整结尾😀。', 'tool_calls': [], 'finish_reason': 'stop',
                 'response_format': 'framed_json_v2'})
            self.invalid(plan, frames(plan, None, [call()]))
            self.assertEqual(request, original)
        self.assertIsNone(bridge.prepare({'model': 'trae/glm-5.3-flashx', 'messages': [{'role': 'user', 'content': 'hello'}]}))

    def test_unicode_escapes_newlines_and_marker_looking_content_roundtrip_losslessly(self):
        plan = self.plan()
        text = '你好😀\n"quote"\\backslash\r\n' + BEGIN + plan.nonce + '\n' + END + plan.nonce + '\n' + PAD
        result = plan.parse(frames(plan, text, [call(text)]))
        self.assertEqual(result['content'], text)
        self.assertEqual(json.loads(result['tool_calls'][0]['function']['arguments']), {'path': text})
        self.assertEqual(result['finish_reason'], 'tool_calls')
        self.assertRegex(result['tool_calls'][0]['id'], r'^call_[0-9a-f]{32}$')

    def test_every_incomplete_data_prefix_is_rejected_without_repair(self):
        for calls, content in (([], '完整内容😀'), ([call('x')], None)):
            plan = self.plan()
            text = frames(plan, content, calls, padding=False)
            for length in range(len(text)):
                with self.subTest(calls=len(calls), length=length):
                    self.invalid(plan, text[:length])
            self.assertEqual(plan.parse(text)['response_format'], 'framed_json_v2')

    def test_fixed_padding_all_prefixes_are_accepted_only_after_complete_data_frame(self):
        plan = self.plan()
        data = frames(plan, 'exact final', padding=False)
        for length in range(len(PAD) + 1):
            with self.subTest(length=length):
                result = plan.parse(data + '\n' + PAD[:length])
                self.assertEqual(result['content'], 'exact final')
                self.assertEqual(result['response_format'], 'framed_json_v2')
        for data_length in (0, len(data) - 1, data.index(END), data.index(CONTENT) + len(CONTENT) + 3):
            for padding in (PAD, PAD[:4]):
                self.invalid(plan, data[:data_length] + '\n' + padding)

    def test_padding_never_accepts_arbitrary_prose_extra_lines_or_nonprefix_data(self):
        plan = self.plan()
        data = frames(plan, padding=False)
        for suffix in ('WB_PAD 1000000000000000', PAD + 'x', 'WB_PAD\t0000', PAD + '\n' + PAD,
                       PAD + '\nprose', 'prose', 'WB_PAQ', 'wb_pad 0000'):
            with self.subTest(suffix=suffix):
                self.invalid(plan, data + '\n' + suffix)

    def test_wrong_missing_or_duplicate_nonce_and_structural_lines_fail(self):
        plan = self.plan()
        data = frames(plan)
        wrong = 'f' * 32 if plan.nonce != 'f' * 32 else 'e' * 32
        invalid = [data.replace(BEGIN + plan.nonce, BEGIN + wrong), data.replace(END + plan.nonce, END + wrong),
                   data.replace(plan.nonce, wrong), data.replace(BEGIN + plan.nonce, BEGIN),
                   data.replace(END + plan.nonce, END), 'prose\n' + data, '```\n' + data + '\n```',
                   data.replace(CONTENT, CONTENT + 'null\n' + CONTENT, 1),
                   data.replace(END + plan.nonce, END + plan.nonce + '\n' + END + plan.nonce)]
        for text in invalid:
            self.invalid(plan, text)

    def test_old_envelope_plain_fallback_and_fences_are_never_used_for_v2(self):
        plan = self.plan()
        envelope = compact({'bridge_nonce': plan.nonce, 'content': 'hello', 'tool_calls': []})
        for text in ('Hello!', envelope, envelope[:-1], '```json\n' + envelope + '\n```',
                     '```\n' + frames(plan) + '\n```'):
            self.invalid(plan, text)

    def test_duplicate_argument_keys_nested_keys_and_incomplete_json_fail(self):
        plan = self.plan()
        template = frames(plan, None, [call('x')])
        for raw in ('{"path":"a","path":"b"}', '{"path":"a","extra":{"x":1,"x":2}}',
                    '{"path":"unterminated', '{"path":"x"', '{"path":NaN}', '{"path":1e999}',
                    '{"path":"\\ud800"}', '[]', '"quoted"', 'null'):
            text = template.replace(ARGS + compact({'path': 'x'}), ARGS + raw)
            self.invalid(plan, text)

    def test_content_types_and_missing_content_are_validated(self):
        plan = self.plan()
        for content in (None, {}, [], 1, True):
            self.invalid(plan, frames(plan, content))
        for raw in ('"unterminated', 'NaN', '"\\ud800"'):
            self.invalid(plan, frames(plan).replace(CONTENT + '"done"', CONTENT + raw))
        self.invalid(plan, frames(plan).replace(CONTENT + '"done"\n', ''))

    def test_unknown_tool_invalid_name_and_schema_constraints_fail(self):
        plan = self.plan()
        for item in (call(name='unknown'), call(name='bad.name'), call(name='read_file '),
                     {'name': 'read_file', 'arguments': {}}, {'name': 'read_file', 'arguments': {'path': 1}},
                     {'name': 'read_file', 'arguments': {'path': 'x', 'extra': True}}):
            self.invalid(plan, frames(plan, None, [item]))

    def test_nested_schema_still_applies_to_frames(self):
        schema = {'type': 'object', 'properties': {'items': {'type': 'array', 'minItems': 1,
            'items': {'type': 'object', 'properties': {'x': {'type': 'integer', 'minimum': 1}},
                      'required': ['x'], 'additionalProperties': False}}}, 'required': ['items'], 'additionalProperties': False}
        plan = self.plan(tools=[tool(schema=schema)])
        good = {'name': 'read_file', 'arguments': {'items': [{'x': 2}]}}
        self.assertEqual(plan.parse(frames(plan, None, [good]))['finish_reason'], 'tool_calls')
        for value in ([], [{'x': 0}], [{'x': True}], [{'x': 2, 'y': 3}]):
            self.invalid(plan, frames(plan, None, [{'name': 'read_file', 'arguments': {'items': value}}]))

    def test_none_required_forced_and_parallel_are_enforced(self):
        none = self.plan(tool_choice='none')
        self.assertEqual(none.parse(frames(none))['finish_reason'], 'stop')
        self.invalid(none, frames(none, None, [call()]))
        for choice in ('required', {'type': 'function', 'function': {'name': 'read_file'}}):
            plan = self.plan(tool_choice=choice, tools=[tool(), tool('write_file')])
            self.assertEqual(plan.parse(frames(plan, None, [call()]))['finish_reason'], 'tool_calls')
            self.invalid(plan, frames(plan))
            if isinstance(choice, dict):
                self.invalid(plan, frames(plan, None, [call(name='write_file')]))
        single = self.plan(parallel_tool_calls=False)
        self.invalid(single, frames(single, None, [call('a'), call('b')]))
        parallel = self.plan()
        result = parallel.parse(frames(parallel, None, [call('a'), call('b')]))
        self.assertEqual(len(result['tool_calls']), 2)
        self.assertEqual(len({c['id'] for c in result['tool_calls']}), 2)

    def test_at_most_64_calls_and_output_length_limit_are_enforced(self):
        plan = self.plan()
        self.assertEqual(len(plan.parse(frames(plan, None, [call('x')] * 64))['tool_calls']), 64)
        self.invalid(plan, frames(plan, None, [call('x')] * 65))
        text = frames(plan)
        plan.max_output_chars = len(text) - 1
        self.invalid(plan, text)
        self.invalid(plan, None)

    def test_crlf_and_outer_whitespace_are_supported_without_data_rewriting(self):
        plan = self.plan()
        result = plan.parse(' \r\n' + frames(plan, 'a\r\nb').replace('\n', '\r\n') + '\r\n ')
        self.assertEqual(result['content'], 'a\r\nb')

    def test_prompt_contains_nonce_data_and_padding_without_mutating_original_request(self):
        request = payload(messages=[{'role': 'system', 'content': 'rule'}, {'role': 'developer', 'content': 'dev'},
                                    {'role': 'user', 'content': '中文😀'}])
        before = copy.deepcopy(request)
        plan = bridge.prepare(request)
        self.assertEqual(json.loads(plan.messages[1]['content'][0]['text'])['messages'], before['messages'])
        for marker in (BEGIN + plan.nonce, END + plan.nonce, PAD):
            self.assertIn(marker, plan.messages[0]['content'][0]['text'])
        self.assertIn(END + plan.nonce, plan.messages[-1]['content'][0]['text'])
        self.assertIn(PAD, plan.messages[-1]['content'][0]['text'])
        self.assertEqual(request, before)
        with mock.patch.object(bridge, 'MAX_PROMPT_UTF16', 1):
            with self.assertRaises(bridge.ToolBridgeError) as error:
                bridge.prepare(request)
            self.assertEqual((error.exception.status, error.exception.code), (413, 'request_too_large'))


class DeepSeekFrameProviderTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.NativeProviderTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        catalog = fixtures.catalog_value(fixtures.MID, *UPSTREAMS)
        for item in catalog['models']:
            item.update(route='native_client', source='native_client')
        self.fixture.native.catalogs[fixtures.UID] = catalog
        self.fixture.ready()
        self.provider = self.fixture.provider
        self.payload = {**self.fixture.payload, 'model': MODELS[0], 'tools': [tool()], 'max_tokens': 2048}
        self.outputs = []
        def answer(uid, model, messages, *, max_chars):
            self.fixture.native.chat_calls.append({'model': model, 'messages': copy.deepcopy(messages), 'max_chars': max_chars})
            instruction = messages[0]['content'][0]['text']
            nonces = re.findall(re.escape(BEGIN) + r'([0-9a-f]{32})', instruction)
            self.assertTrue(nonces, 'production prompt did not use framed V2')
            self.assertEqual(len(set(nonces)), 1)
            value = self.outputs.pop(0)
            text = value(nonces[0]) if callable(value) else frames_for_nonce(nonces[0], value[0], value[1])
            return fixtures.chat_value(model=model, response=text, reasoning_content='')
        patch = mock.patch.object(self.fixture.native, 'chat', side_effect=answer)
        patch.start()
        self.addCleanup(patch.stop)

    def assert_metadata(self, metadata):
        self.assertEqual(metadata['route'], 'native_client')
        self.assertEqual(metadata['streaming'], 'buffered')
        self.assertEqual(metadata['upstream_model'], fixtures.ACTUAL)
        self.assertEqual(metadata['response_format'], 'framed_json_v2')
        self.assertEqual(metadata['tool_execution'], 'client')
        self.assertEqual(metadata['tool_calling'], 'structured_text')

    def test_nonstream_tool_call_result_history_then_final_preserve_metadata(self):
        self.outputs.append((None, [call()]))
        first = self.provider.chat(self.payload)
        choice = first['choices'][0]
        self.assertEqual(choice['finish_reason'], 'tool_calls')
        self.assertIsNone(choice['message']['content'])
        toolcall = choice['message']['tool_calls'][0]
        self.assertEqual(json.loads(toolcall['function']['arguments']), call()['arguments'])
        self.assert_metadata(first['provider_metadata'])
        self.outputs.append(('READ_VERIFIED😀', []))
        followup = {**self.payload, 'messages': [*self.payload['messages'], choice['message'],
                    {'role': 'tool', 'tool_call_id': toolcall['id'], 'content': '真实结果 fixture contents'}]}
        final = self.provider.chat(followup)
        self.assertEqual(final['choices'][0]['message']['content'], 'READ_VERIFIED😀')
        self.assertEqual(final['choices'][0]['finish_reason'], 'stop')
        self.assert_metadata(final['provider_metadata'])
        self.assertIn('真实结果 fixture contents', str(self.fixture.native.chat_calls[-1]['messages']))
        self.assertEqual(len(self.fixture.native.chat_calls), 2)
        self.assertEqual(self.outputs, [])

    def test_buffered_sse_parallel_calls_have_indexes_ids_and_metadata(self):
        self.outputs.append(('Read twice', [call('a'), call('b')]))
        chunks = list(self.provider.stream({**self.payload, 'stream': True}))
        calls = [call for row in chunks for call in row['choices'][0]['delta'].get('tool_calls', [])]
        self.assertEqual([call['index'] for call in calls], [0, 1])
        self.assertEqual(len({call['id'] for call in calls}), 2)
        self.assertEqual(chunks[-1]['choices'][0]['finish_reason'], 'tool_calls')
        for row in chunks:
            self.assert_metadata(row['provider_metadata'])
        self.assertEqual(len(self.fixture.native.chat_calls), 1)

    def test_no_tools_chat_nonstream_and_sse_use_v2_for_each_exact_model(self):
        for model in MODELS:
            for stream in (False, True):
                with self.subTest(model=model, stream=stream):
                    request = {'model': model, 'messages': self.payload['messages'], 'stream': stream}
                    self.outputs.append(('完整普通回答😀。', []))
                    if stream:
                        chunks = list(self.provider.stream(request))
                        self.assertEqual(''.join(row['choices'][0]['delta'].get('content', '') for row in chunks), '完整普通回答😀。')
                        self.assertTrue(all(not row['choices'][0]['delta'].get('tool_calls') for row in chunks))
                        self.assertEqual(chunks[-1]['choices'][0]['finish_reason'], 'stop')
                        for row in chunks:
                            self.assert_metadata(row['provider_metadata'])
                    else:
                        value = self.provider.chat(request)
                        self.assertEqual(value['choices'][0]['message']['content'], '完整普通回答😀。')
                        self.assert_metadata(value['provider_metadata'])
        self.assertEqual(len(self.fixture.native.chat_calls), 6)

    def test_invalid_or_incomplete_frame_fails_before_first_chunk_without_replay(self):
        for maker in (lambda n: frames_for_nonce(n, None, [call('x')], False)[:-1],
                      lambda n: frames_for_nonce(n, None, [call(name='unknown')]),
                      lambda n: frames_for_nonce(n, None, [call('x')]).replace('{"path":"x"}', '{"path":"a","path":"b"}')):
            self.outputs.append(maker)
            before = len(self.fixture.native.chat_calls)
            emitted = []
            with self.assertRaises(trae.TraeError) as error:
                for chunk in self.provider.stream({**self.payload, 'stream': True}):
                    emitted.append(chunk)
            self.assertEqual(error.exception.code, 'invalid_tool_response')
            self.assertEqual(emitted, [])
            self.assertEqual(len(self.fixture.native.chat_calls), before + 1)
        self.assertEqual(self.outputs, [])

    def test_complete_frame_with_partial_padding_is_not_partial_model_data(self):
        self.outputs.append(lambda n: frames_for_nonce(n, 'complete final', padding=False) + '\nWB_PA')
        value = self.provider.chat(self.payload)
        self.assertEqual(value['choices'][0]['message']['content'], 'complete final')
        self.assert_metadata(value['provider_metadata'])
        self.assertEqual(len(self.fixture.native.chat_calls), 1)


if __name__ == '__main__':
    unittest.main()
