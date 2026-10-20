"""Offline integration: native text envelope -> OpenAI tools -> result history."""
import copy
import json
from pathlib import Path
import sys
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'hub'))
sys.path.insert(0, str(ROOT))
import wb_trae as trae
from test import test_trae_native as fixtures

TOOL = {'type': 'function', 'function': {'name': 'write_file', 'parameters': {
    'type': 'object', 'properties': {'path': {'type': 'string'}, 'content': {'type': 'string'}},
    'required': ['path', 'content'], 'additionalProperties': False}}}


class ToolProviderTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.NativeProviderTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.ready()
        self.provider = self.fixture.provider
        self.payload = {**self.fixture.payload, 'tools': [copy.deepcopy(TOOL)],
                        'tool_choice': 'auto', 'max_tokens': 2048}
        self.outputs = []

        def native_answer(uid, model, messages, *, max_chars):
            self.fixture.native.chat_calls.append({'model': model, 'messages': copy.deepcopy(messages), 'max_chars': max_chars})
            instruction = messages[0]['content'][0]['text']
            nonce = instruction.split('bridge_nonce must equal ', 1)[1].split('. ', 1)[0]
            answer = self.outputs.pop(0)
            if isinstance(answer, str):
                text = answer
            else:
                content, calls = answer
                text = json.dumps({'bridge_nonce': json.loads(nonce), 'content': content, 'tool_calls': calls})
            return fixtures.chat_value(response=text, reasoning_content='')

        self.patch = mock.patch.object(self.fixture.native, 'chat', side_effect=native_answer)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def call(self):
        return {'name': 'write_file', 'arguments': {'path': 'D:/fixture.txt', 'content': 'hello'}}

    def test_nonstream_tool_call_and_followup_result_complete(self):
        self.outputs.append((None, [self.call()]))
        first = self.provider.chat(self.payload)
        choice = first['choices'][0]
        self.assertEqual(choice['finish_reason'], 'tool_calls')
        self.assertIsNone(choice['message']['content'])
        call = choice['message']['tool_calls'][0]
        self.assertEqual(call['function']['name'], 'write_file')
        self.assertEqual(json.loads(call['function']['arguments']), self.call()['arguments'])
        self.assertEqual(first['provider_metadata']['tool_calling'], 'structured_text')
        self.assertEqual(first['provider_metadata']['tool_execution'], 'client')
        self.outputs.append(('FILE_VERIFIED', []))
        followup = {**self.payload, 'messages': [*self.payload['messages'], choice['message'],
                    {'role': 'tool', 'tool_call_id': call['id'], 'content': 'written successfully'}]}
        last = self.provider.chat(followup)
        self.assertEqual(last['choices'][0]['finish_reason'], 'stop')
        self.assertEqual(last['choices'][0]['message']['content'], 'FILE_VERIFIED')
        self.assertIn('written successfully', str(self.fixture.native.chat_calls[-1]['messages']))
        self.assertEqual(len(self.fixture.native.chat_calls), 2)

    def test_stream_parallel_calls_have_index_id_and_terminal_reason(self):
        self.outputs.append(('Writing two files', [self.call(), self.call()]))
        chunks = list(self.provider.stream({**self.payload, 'stream': True}))
        calls = [c for row in chunks for c in row['choices'][0]['delta'].get('tool_calls', [])]
        self.assertEqual([c['index'] for c in calls], [0, 1])
        self.assertEqual(len({c['id'] for c in calls}), 2)
        self.assertEqual(chunks[-1]['choices'][0]['finish_reason'], 'tool_calls')

    def test_invalid_output_fails_before_first_chunk_without_replay(self):
        self.outputs.append((None, [{'name': 'undeclared_tool', 'arguments': {}}]))
        with self.assertRaises(trae.TraeError) as error:
            next(self.provider.stream(self.payload))
        self.assertEqual(error.exception.code, 'invalid_tool_response')
        self.assertEqual(len(self.fixture.native.chat_calls), 1)
        self.assertEqual(self.outputs, [])

    def test_tools_require_native_route(self):
        row = self.provider._records()[0]
        row['models'][0]['route'] = 'legacy_http'
        self.provider._save(row)
        with self.assertRaises(trae.TraeError) as error:
            self.provider.chat(self.payload)
        self.assertEqual(error.exception.code, 'tools_require_native_client')
        self.assertEqual(self.fixture.native.chat_calls, [])

    def test_plain_final_nonstream_has_explicit_metadata_and_no_replay(self):
        self.outputs.append('你好！有什么可以帮你？')
        answer = self.provider.chat(self.payload)
        self.assertEqual(answer['choices'][0]['message'], {'role': 'assistant', 'content': '你好！有什么可以帮你？'})
        self.assertEqual(answer['choices'][0]['finish_reason'], 'stop')
        self.assertEqual(answer['provider_metadata']['response_format'], 'plain_text_final')
        self.assertEqual(len(self.fixture.native.chat_calls), 1)
        self.assertEqual(self.outputs, [])

    def test_plain_final_sse_is_stop_without_tool_chunks_and_no_replay(self):
        self.outputs.append('Hello!')
        chunks = list(self.provider.stream({**self.payload, 'stream': True, 'tool_choice': 'none'}))
        self.assertEqual(chunks[-1]['choices'][0]['finish_reason'], 'stop')
        self.assertEqual(''.join(row['choices'][0]['delta'].get('content', '') for row in chunks), 'Hello!')
        self.assertTrue(all(not row['choices'][0]['delta'].get('tool_calls') for row in chunks))
        self.assertTrue(all(row['provider_metadata']['response_format'] == 'plain_text_final' for row in chunks))
        self.assertEqual(len(self.fixture.native.chat_calls), 1)

    def test_single_outer_close_final_is_marked_for_json_and_sse_without_replay(self):
        original = self.fixture.native.chat.side_effect

        def missing_brace(*args, **kwargs):
            value = original(*args, **kwargs)
            value['response'] = value['response'][:-1]
            return value

        self.fixture.native.chat.side_effect = missing_brace
        self.outputs.append(('你好！', []))
        answer = self.provider.chat(self.payload)
        self.assertEqual(answer['choices'][0]['message'], {'role': 'assistant', 'content': '你好！'})
        self.assertEqual(answer['provider_metadata']['response_format'], 'single_outer_close_final')
        self.outputs.append(('Hello!', []))
        chunks = list(self.provider.stream({**self.payload, 'stream': True}))
        self.assertEqual(chunks[-1]['choices'][0]['finish_reason'], 'stop')
        self.assertEqual(''.join(row['choices'][0]['delta'].get('content', '') for row in chunks), 'Hello!')
        self.assertTrue(all(not row['choices'][0]['delta'].get('tool_calls') for row in chunks))
        self.assertTrue(all(row['provider_metadata']['response_format'] == 'single_outer_close_final' for row in chunks))
        self.assertEqual(len(self.fixture.native.chat_calls), 2)
        self.assertEqual(self.outputs, [])

    def test_missing_brace_tool_call_is_rejected_before_first_chunk_without_replay(self):
        original = self.fixture.native.chat.side_effect

        def missing_brace(*args, **kwargs):
            value = original(*args, **kwargs)
            value['response'] = value['response'][:-1]
            return value

        self.fixture.native.chat.side_effect = missing_brace
        self.outputs.append((None, [self.call()]))
        with self.assertRaises(trae.TraeError) as error:
            next(self.provider.stream({**self.payload, 'stream': True}))
        self.assertEqual(error.exception.code, 'invalid_tool_response')
        self.assertEqual(len(self.fixture.native.chat_calls), 1)

    def test_forced_and_suspected_tool_json_fail_before_first_chunk_without_replay(self):
        cases = [('required', '你好！'),
                 ({'type': 'function', 'function': {'name': 'write_file'}}, 'Hello!'),
                 ('auto', 'Here is tool JSON: {"tool_calls":'),
                 ('none', '```json\n{"tool_calls":[]}\n```')]
        for choice, text in cases:
            self.outputs.append(text)
            before = len(self.fixture.native.chat_calls)
            with self.assertRaises(trae.TraeError) as error:
                next(self.provider.stream({**self.payload, 'stream': True, 'tool_choice': choice}))
            self.assertEqual(error.exception.code, 'invalid_tool_response')
            self.assertEqual(len(self.fixture.native.chat_calls), before + 1)
            self.assertEqual(self.outputs, [])

    def test_developer_role_and_max_completion_tokens_alias(self):
        payload = {**self.fixture.payload, 'messages': [{'role': 'developer', 'content': 'rule'},
                   {'role': 'user', 'content': 'question'}], 'max_completion_tokens': 128}
        _, body = self.provider._payload(payload)
        self.assertEqual(body['messages'][0]['role'], 'system')
        self.assertEqual(body['max_tokens'], 128)
        with self.assertRaises(trae.TraeError):
            self.provider._payload({**payload, 'max_tokens': 256})

    def test_stream_option_and_stream_types_are_validated(self):
        for fields in ({'stream': 'true'}, {'stream_options': []},
                       {'stream_options': {'include_usage': 1}}, {'stream_options': {'secret': True}}):
            with self.subTest(fields=fields), self.assertRaises(trae.TraeError):
                self.provider._payload({**self.fixture.payload, **fields})


if __name__ == '__main__':
    unittest.main()
