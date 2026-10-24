"""Offline contracts for the private native bridge and its provider routing.

No processes are attached, no sockets are opened, and all fixture writes stay
under this repository's D: analysis directory.
"""
import copy
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))
sys.path.insert(0, str(ROOT))
import wb_trae as trae
import wb_trae_native as native
from test.test_trae_provider import FakeHTTP, TOKEN, fake_protect

BRIDGE_URL = "http://127.0.0.1:43219"
BRIDGE_TOKEN = "a1" * 32
UID = "fixture-user-a"
MID = "fixture-native-model-v9"
ACTUAL = "fixture/provider-model-20261020"


def catalog_value(*ids):
    return {"source": "native_client", "fetchedAt": 1700000000,
            "models": [{"upstreamId": mid, "name": "Native " + mid} for mid in (ids or (MID,))]}


def chat_value(**changes):
    return {"response": "native answer", "reasoning_content": "native reasoning", "model": MID,
            "upstreamModel": ACTUAL, "finish_reason": "stop",
            "usage": {"prompt_tokens": 7, "completion_tokens": 3, "total_tokens": 10}, **changes}


def messages():
    return [{"role": "system", "content": [{"type": "text", "text": "系统规则\n不得遗漏"}]},
            {"role": "user", "content": [{"type": "text", "text": '第一轮 "quote"'},
                                          {"type": "text", "text": "\\backslash"}]},
            {"role": "assistant", "content": [{"type": "text", "text": "previous answer"}]},
            {"role": "user", "content": [{"type": "text", "text": "最后的问题 😀"}]}]


class NativeClientTests(unittest.TestCase):
    def setUp(self):
        environment = mock.patch.dict(os.environ, {"WB_TRAE_BRIDGE_URL": "", "WB_TRAE_BRIDGE_TOKEN": ""})
        environment.start()
        self.addCleanup(environment.stop)
        self.http = FakeHTTP()
        self.client = native.NativeTraeClient(BRIDGE_URL, BRIDGE_TOKEN, opener=self.http)

    def assert_code(self, code, action):
        with self.assertRaises(native.NativeBridgeError) as raised:
            action()
        self.assertEqual(raised.exception.code, code)
        return raised.exception

    def test_configuration_requires_exact_loopback_http_and_64_lowercase_hex_bearer(self):
        self.assertTrue(self.client.configured)
        for url in ("", "https://127.0.0.1:43219", "http://localhost:43219", "http://[::1]:43219",
                    "http://0.0.0.0:43219", "http://127.0.0.1.evil.invalid:43219",
                    "http://user:password@127.0.0.1:43219", "http://127.0.0.1", "http://127.0.0.1:0",
                    "http://127.0.0.1:65536", BRIDGE_URL + "/catalog", BRIDGE_URL + "?token=secret",
                    BRIDGE_URL + "#fragment", "http://127.0.0.1:invalid"):
            with self.subTest(url=url):
                self.assertFalse(native.NativeTraeClient(url, BRIDGE_TOKEN, opener=self.http).configured)
        for token in ("", "a" * 63, "a" * 65, "A" * 64, "g" * 64, "a" * 63 + "\n", None, 42):
            with self.subTest(token_type=type(token).__name__):
                self.assertFalse(native.NativeTraeClient(BRIDGE_URL, token, opener=self.http).configured)
        self.assertEqual(self.http.requests, [])

    def test_environment_configuration_is_ephemeral_and_never_saves_a_trae_token(self):
        with mock.patch.dict(os.environ, {"WB_TRAE_BRIDGE_URL": BRIDGE_URL + "/", "WB_TRAE_BRIDGE_TOKEN": BRIDGE_TOKEN}):
            client = native.NativeTraeClient(opener=self.http)
        self.http.add(catalog_value())
        client.catalog(UID)
        request, timeout = self.http.requests[0]
        self.assertEqual(request.full_url, BRIDGE_URL + "/catalog")
        self.assertEqual(request.get_header("Authorization"), "Bearer " + BRIDGE_TOKEN)
        self.assertNotIn(TOKEN, repr(request.headers))
        self.assertEqual(json.loads(request.data), {"uid": UID, "timeoutMs": 45000})
        self.assertGreaterEqual(timeout, 45 + 25)

    def test_default_opener_explicitly_disables_proxies_and_redirects(self):
        real = urllib.request.build_opener
        with mock.patch.dict(os.environ, {"HTTP_PROXY": "http://proxy.invalid:80", "ALL_PROXY": "http://proxy.invalid:80"}), \
                mock.patch.object(native.urllib.request, "build_opener", wraps=real) as build:
            native.NativeTraeClient(BRIDGE_URL, BRIDGE_TOKEN)
        handlers = build.call_args.args
        self.assertIsInstance(handlers[0], urllib.request.ProxyHandler)
        self.assertEqual(handlers[0].proxies, {})
        redirect = next(handler for handler in handlers if isinstance(handler, urllib.request.HTTPRedirectHandler))
        self.assertIsInstance(redirect, native._NoRedirect)
        request = urllib.request.Request(BRIDGE_URL + "/catalog")
        self.assert_code("native_request_failed", lambda: redirect.redirect_request(
            request, None, 302, "secret", {}, "https://private.invalid/?signature=secret"))

    def test_unconfigured_client_or_invalid_uid_never_opens_any_connection(self):
        unavailable = native.NativeTraeClient("", "", opener=self.http)
        self.assert_code("native_bridge_unavailable", lambda: unavailable.catalog(UID))
        for uid in (None, 42, "", "bad uid", "bad\nuid", "../user", "a" * 161):
            with self.subTest(uid=uid):
                self.assert_code("native_uid_required", lambda uid=uid: self.client.catalog(uid))
        self.assertEqual(self.http.requests, [])

    def test_redirected_response_is_rejected_without_replay(self):
        self.http.add(catalog_value(), url="https://private.invalid/?signature=secret")
        error = self.assert_code("native_request_failed", lambda: self.client.catalog(UID))
        self.assertEqual(len(self.http.requests), 1)
        self.assertNotIn("private.invalid", str(error))
        self.assertNotIn("signature", str(error))

    def test_fixed_bridge_error_mapping_drops_all_upstream_error_details(self):
        cases = {
            "BUSY": (429, "native_busy"), "TIMEOUT": (504, "stream_timeout"),
            "UID_MISMATCH": (409, "wrong_current_account"), "STOP_FAILED": (502, "stop_failed"),
            "OUTPUT_LIMIT": (502, "output_limit"), "EVENT_LIMIT": (502, "response_too_large"),
            "TOOL_NOT_ALLOWED": (422, "unsupported_upstream_feature"),
            "UPSTREAM_MODEL_MISMATCH": (502, "upstream_model_mismatch"),
            "UPSTREAM_MODEL_UNCONFIRMED": (502, "upstream_model_unconfirmed"),
            "MODEL_UNAVAILABLE": (503, "model_unavailable"), "CATALOG_UNAVAILABLE": (503, "catalog_unavailable"),
            "INCOMPLETE_RESPONSE": (502, "incomplete_stream"), "EMPTY_RESPONSE": (502, "empty_stream"),
            "UPSTREAM_ERROR": (502, "upstream_error"), "INSPECTOR_CLEANUP_FAILED": (503, "native_cleanup_failed"),
            "UNRECOGNIZED_CODE": (502, "native_request_failed")
        }
        for bridge_code, (status, code) in cases.items():
            with self.subTest(bridge_code=bridge_code):
                self.http.add({"ok": False, "error": {"code": bridge_code,
                    "message": "secret-token " + UID + " https://private.invalid/?signature=secret"}}, status=502)
                error = self.assert_code(code, lambda: self.client.catalog(UID))
                self.assertEqual(error.status, status)
                for secret in ("secret-token", UID, "private.invalid", "signature=secret"):
                    self.assertNotIn(secret, str(error))
        self.assertEqual(len(self.http.requests), len(cases))

    def test_http_error_body_uses_only_fixed_code_and_never_retries(self):
        body = io.BytesIO(json.dumps({"error": {"code": "UID_MISMATCH", "message": UID + " secret-token"}}).encode())
        self.http.queue.append(urllib.error.HTTPError(BRIDGE_URL + "/catalog", 409, "private detail", {}, body))
        self.assert_code("wrong_current_account", lambda: self.client.catalog(UID))
        self.assertEqual(len(self.http.requests), 1)

    def test_network_and_invalid_json_failures_are_sanitized_and_not_replayed(self):
        for value in (OSError("secret-token signed-url " + UID), urllib.error.URLError("secret-token"),
                      b"invalid-json secret-token", b"[]", b"null", b'"secret-token"', b"\xff",
                      b"x" * (1024 * 1024 + 1)):
            with self.subTest(kind=type(value).__name__):
                http = FakeHTTP()
                client = native.NativeTraeClient(BRIDGE_URL, BRIDGE_TOKEN, opener=http)
                if isinstance(value, Exception):
                    http.queue.append(value)
                else:
                    http.add(value)
                with self.assertRaises(native.NativeBridgeError) as raised:
                    client.catalog(UID)
                self.assertEqual(len(http.requests), 1)
                for secret in (UID, "secret-token", "signed-url"):
                    self.assertNotIn(secret, str(raised.exception))

    def test_catalog_returns_only_sanitized_directory_fields(self):
        value = catalog_value()
        value.update(token="must-not-leak", uid=UID)
        value["models"][0].update(token="must-not-leak", custom_config={"apiKey": "secret"}, rawPayload="secret")
        self.http.add(value)
        result = self.client.catalog(UID)
        self.assertEqual(result, {"source": "native_client", "fetchedAt": 1700000000,
            "models": [{"upstreamId": MID, "name": "Native " + MID,
                        "route": "native_client", "source": "native_client"}]})
        self.assertNotIn(UID, json.dumps(result))
        self.assertNotIn("secret", json.dumps(result))

    def test_malformed_or_duplicate_catalog_fails_closed_with_fixed_error(self):
        invalid = [None, [], {}, {"source": "local_client_cache", "models": []},
                   {"source": "native_client", "models": []},
                   {"source": "native_client", "models": [{}]},
                   {"source": "native_client", "models": [{"upstreamId": 42, "name": "bad"}]},
                   {"source": "native_client", "models": [{"upstreamId": "../bad", "name": "bad"}]},
                   {"source": "native_client", "models": [{"upstreamId": MID, "name": 42}]},
                   {"source": "native_client", "models": [{"upstreamId": MID, "name": ""}]},
                   {"source": "native_client", "models": [{"upstreamId": MID, "name": "x" * 161}]},
                   {"source": "native_client", "models": catalog_value()["models"] * 2},
                   {"source": "native_client", "models": catalog_value()["models"] * 4097}]
        for value in invalid:
            with self.subTest(shape=repr(value)[:80]):
                self.http.add(value)
                with self.assertRaises(native.NativeBridgeError):
                    self.client.catalog(UID)

    def test_catalog_display_name_control_characters_and_padding_are_rejected(self):
        for name in ("line\nfeed", "zero\u200bwidth", " padded ", "tab\tname", "null\0name"):
            with self.subTest(name=name):
                value = catalog_value()
                value["models"][0]["name"] = name
                self.http.add(value)
                self.assert_code("catalog_unavailable", lambda: self.client.catalog(UID))

    def test_chat_preserves_full_history_as_json_and_returns_actual_upstream_model(self):
        raw = chat_value(token="must-not-leak", uid=UID, extra="must-not-leak")
        self.http.add(raw)
        history = messages()
        before = copy.deepcopy(history)
        result = self.client.chat(UID, MID, history, max_chars=256)
        request, timeout = self.http.requests[0]
        payload = json.loads(request.data)
        self.assertEqual(request.full_url, BRIDGE_URL + "/chat")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(payload["uid"], UID)
        self.assertEqual(payload["model"], MID)
        self.assertEqual(payload["maxChars"], 256)
        self.assertEqual(payload["timeoutMs"], 120000)
        self.assertGreaterEqual(timeout, 120 + 25)
        decoded = json.loads(payload["prompt"].split("\n", 1)[1])
        self.assertEqual(decoded, [{"role": row["role"], "content": "".join(block["text"] for block in row["content"])} for row in history])
        self.assertEqual(history, before)
        self.assertEqual(result["upstreamModel"], ACTUAL)
        self.assertEqual(result["model"], MID)
        self.assertEqual(set(result), {"response", "reasoning_content", "usage", "finish_reason", "upstreamModel", "model"})
        self.assertNotIn(UID, json.dumps(result))
        self.assertNotIn("must-not-leak", json.dumps(result))

    def test_chat_refuses_model_identity_missing_or_mismatch_and_incomplete_results(self):
        for changes in ({"model": "another-model"}, {"upstreamModel": None}, {"upstreamModel": ""},
                        {"upstreamModel": "bad model"}, {"upstreamModel": "x" * 257},
                        {"finish_reason": "length"}, {"response": " "}, {"response": 42},
                        {"reasoning_content": None}):
            with self.subTest(changes=changes):
                self.http.add(chat_value(**changes))
                self.assert_code("upstream_model_unconfirmed", lambda: self.client.chat(UID, MID, messages(), max_chars=256))
        self.assertEqual(len(self.http.requests), 9)

    def test_chat_enforces_separate_response_and_reasoning_limits_without_partial_success(self):
        # Response and reasoning each get the full character budget; neither
        # consumes the other's allowance.
        self.http.add(chat_value(response="ab", reasoning_content="cd"))
        self.assert_code("output_limit", lambda: self.client.chat(UID, MID, messages(), max_chars=1))
        self.http.add(chat_value(response="ab", reasoning_content="c" * 8))
        self.assert_code("output_limit", lambda: self.client.chat(UID, MID, messages(), max_chars=4))
        self.http.add(chat_value(response="ab", reasoning_content="cd"))
        self.assertEqual(self.client.chat(UID, MID, messages(), max_chars=4)["response"], "ab")
        self.assertEqual(len(self.http.requests), 3)

    def test_chat_estimates_when_usage_is_missing_or_invalid(self):
        for usage in ({"prompt_tokens": True, "completion_tokens": -1, "total_tokens": "4"},
                      {"prompt_tokens": 2**53, "completion_tokens": 1.5, "total_tokens": None}, [], None):
            with self.subTest(usage=usage):
                self.http.add(chat_value(usage=usage))
                result = self.client.chat(UID, MID, messages(), max_chars=256)
                self.assertTrue(result["usageEstimated"])
                self.assertGreater(result["usage"]["prompt_tokens"], 0)
                self.assertGreater(result["usage"]["completion_tokens"], 0)
                self.assertEqual(result["usage"]["total_tokens"],
                                 result["usage"]["prompt_tokens"] + result["usage"]["completion_tokens"])

    def test_chat_utf16_history_limit_fails_before_bridge_call(self):
        history = [{"role": "user", "content": [{"type": "text", "text": "😀" * 32768}]}]
        self.assert_code("request_too_large", lambda: self.client.chat(UID, MID, history, max_chars=256))
        self.assertEqual(self.http.requests, [])

    def test_chat_compacts_old_history_without_truncating_latest_turn(self):
        self.http.add(chat_value())
        history = [{"role": "system", "content": [{"type": "text", "text": "keep system"}]}]
        for index in range(20):
            history.append({"role": "user" if index % 2 == 0 else "assistant",
                            "content": [{"type": "text", "text": f"old-{index} " + "x" * 5000}]})
        history.append({"role": "user", "content": [{"type": "text", "text": "latest request"}]})
        self.client.chat(UID, MID, history, max_chars=256)
        payload = json.loads(self.http.requests[0][0].data)
        prompt = payload["prompt"]
        decoded = json.loads(prompt.split("\n", 1)[1])
        self.assertLessEqual(native._utf16_length(prompt), native._NATIVE_PROMPT_BUDGET)
        self.assertEqual(decoded[0], {"role": "system", "content": "Earlier conversation turns were omitted to fit the native TRAE context limit. Use the retained system instructions and latest user request."})
        self.assertEqual(decoded[-1], {"role": "user", "content": "latest request"})
        self.assertEqual(decoded[1], {"role": "system", "content": "keep system"})
        self.assertLess(len(decoded), len(history))

    def test_chat_middle_truncates_an_oversized_system_with_omission_marker(self):
        # A system prompt that fits the budget alone may be compacted (head +
        # omission marker + tail); the latest user turn stays untouched.
        self.http.add(chat_value())
        history = [{"role": "system", "content": [{"type": "text", "text": "😀" * 30000}]},
                   {"role": "user", "content": [{"type": "text", "text": "latest"}]}]
        result = self.client.chat(UID, MID, history, max_chars=256)
        payload = json.loads(self.http.requests[0][0].data)
        prompt = payload["prompt"]
        decoded = json.loads(prompt.split("\n", 1)[1])
        self.assertLessEqual(native._utf16_length(prompt), native._NATIVE_PROMPT_BUDGET)
        self.assertIn("系统提示中段已省略", decoded[0]["content"])
        self.assertLess(len(decoded[0]["content"]), len(history[0]["content"][0]["text"]))
        self.assertEqual(decoded[-1], {"role": "user", "content": "latest"})
        self.assertEqual(result["context_trim"], 3)
        self.assertEqual(len(self.http.requests), 1)

    def test_chat_still_refuses_a_system_larger_than_the_whole_budget_with_diagnostics(self):
        history = [{"role": "system", "content": [{"type": "text", "text": "x" * 210000}]},
                   {"role": "user", "content": [{"type": "text", "text": "latest"}]}]
        error = self.assert_code("request_too_large", lambda: self.client.chat(UID, MID, history, max_chars=256))
        self.assertIn("当前消息本身", error.message)
        self.assertEqual(error.extra["budget_chars"], 60000)
        self.assertGreaterEqual(error.extra["context_chars"], 210000)
        self.assertIn("60000", error.extra["suggest"])
        self.assertEqual(self.http.requests, [])


class FakeNative:
    def __init__(self):
        self.configured = True
        self.catalog_calls = []
        self.chat_calls = []
        self.catalog_error = None
        self.chat_error = None
        self.catalogs = {}
        self.result = chat_value()

    def catalog(self, uid):
        self.catalog_calls.append(uid)
        if self.catalog_error:
            raise self.catalog_error
        return copy.deepcopy(self.catalogs.get(uid, {**catalog_value(), "models": [
            {**row, "route": "native_client", "source": "native_client"} for row in catalog_value()["models"]]}))

    def chat(self, uid, model, history, *, max_chars):
        self.chat_calls.append({"uid": uid, "model": model, "messages": copy.deepcopy(history), "max_chars": max_chars})
        if self.chat_error:
            raise self.chat_error
        return copy.deepcopy(self.result)


class NativeProviderTests(unittest.TestCase):
    def setUp(self):
        folder = ROOT / "analysis"
        folder.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="trae-native-test-", dir=folder)
        self.addCleanup(self.temp.cleanup)
        self.assertEqual(Path(self.temp.name).drive.upper(), "D:")
        patch = mock.patch.object(trae.TraeProvider, "_client", return_value={"installed": False, "version": None})
        patch.start()
        self.addCleanup(patch.stop)
        self.http = FakeHTTP()
        self.native = FakeNative()
        self.cache = {}
        self.cache_calls = []

        def read_cache(uid):
            self.cache_calls.append(uid)
            return copy.deepcopy(self.cache.get(uid))

        self.provider = trae.TraeProvider(self.temp.name, opener=self.http, protector=fake_protect,
                                          native_client=self.native, catalog_reader=read_cache)
        self.payload = {"model": "trae/" + MID, "messages": [{"role": "user", "content": "fixture prompt"}]}

    def imported(self, uid=UID):
        return self.provider.import_account({"token": TOKEN, "account": {"uid": uid}})["accounts"][-1]["id"]

    def refresh(self, account_id):
        self.http.add({"user_entitlement_pack_list": [{
            "entitlement_base_info": {"quota": {"credits_limit": 100}}, "usage": {"credits_amount": 1}}]})
        return self.provider.refresh(account_id)

    def ready(self, uid=UID):
        existing = {row["id"] for row in self.provider._records()}
        self.imported(uid)
        account_id = next(row["id"] for row in self.provider._records() if row["id"] not in existing)
        self.refresh(account_id)
        return account_id

    def assert_code(self, code, action):
        with self.assertRaises(trae.TraeError) as raised:
            action()
        self.assertEqual(raised.exception.code, code)
        return raised.exception

    def test_native_catalog_precedes_legacy_and_cache_and_never_calls_old_model_endpoint(self):
        account_id = self.ready()
        status = self.provider.status()
        account = next(row for row in status["accounts"] if row["id"] == account_id)
        self.assertEqual(account["catalogSource"], "native_client")
        self.assertTrue(account["nativeConnected"])
        self.assertIsNone(account["nativeError"])
        self.assertEqual(account["status"], "ready")
        self.assertEqual(self.native.catalog_calls, [UID])
        self.assertEqual(self.cache_calls, [])
        self.assertEqual(len(self.http.requests), 1)
        self.assertIn("ide_user_ent_usage", self.http.requests[0][0].full_url)
        self.assertEqual(status["models"][0]["route"], "native_client")
        self.assertEqual(status["models"][0]["streaming"], "buffered")

    def test_cache_directory_is_explicitly_offline_and_never_fakes_native_connection(self):
        account_id = self.imported()
        self.native.catalog_error = native.NativeBridgeError(503, "trae_not_running", "TRAE is not running")
        self.cache[UID] = {**catalog_value(), "source": "local_client_cache", "fetchedAt": time.time() - 7200}
        status = self.refresh(account_id)
        account = status["accounts"][0]
        self.assertFalse(account["nativeConnected"])
        self.assertEqual(account["catalogSource"], "local_client_cache")
        self.assertEqual(account["status"], "partial")
        self.assertGreaterEqual(account["catalogAgeSeconds"], 7199)
        self.assertIsNotNone(account["nativeError"])
        self.assertIsNotNone(account["modelError"])
        self.assertEqual(status["models"][0]["source"], "local_client_cache")
        self.assertEqual(status["models"][0]["route"], "native_client")
        self.assertEqual(self.cache_calls, [UID])
        self.assertEqual(len(self.http.requests), 1)

    def test_disconnected_bridge_keeps_last_new_directory_without_old_endpoint_downgrade(self):
        account_id = self.ready()
        before = self.provider.status()["models"]
        self.native.catalog_error = native.NativeBridgeError(503, "native_bridge_unavailable", "bridge unavailable")
        status = self.refresh(account_id)
        self.assertEqual(status["models"], before)
        self.assertFalse(status["accounts"][0]["nativeConnected"])
        self.assertEqual(status["accounts"][0]["status"], "partial")
        self.assertEqual(len(self.http.requests), 2)
        self.assertTrue(all("ide_user_ent_usage" in req.full_url for req, _ in self.http.requests))

    def test_cache_new_model_requires_native_bridge_and_never_falls_back_to_legacy_http(self):
        account_id = self.imported()
        self.provider._native = native.NativeTraeClient("", "", opener=FakeHTTP())
        self.cache[UID] = {**catalog_value(), "source": "local_client_cache"}
        self.refresh(account_id)
        self.assert_code("native_bridge_unavailable", lambda: self.provider.chat(self.payload))
        self.assertEqual(len(self.http.requests), 1)
        self.assertEqual(self.http.queue, [])

    def test_native_failure_is_not_replayed_against_other_accounts_or_old_http(self):
        self.ready()
        self.ready("fixture-user-b")
        before_requests = len(self.http.requests)
        for code in ("wrong_current_account", "stream_timeout", "stop_failed", "output_limit",
                     "upstream_model_mismatch", "upstream_model_unconfirmed", "incomplete_stream"):
            with self.subTest(code=code):
                self.native.chat_error = native.NativeBridgeError(502, code, "fixed safe native failure")
                before = len(self.native.chat_calls)
                emitted = []
                with self.assertRaises(trae.TraeError) as raised:
                    for chunk in self.provider.stream(self.payload):
                        emitted.append(chunk)
                self.assertEqual(raised.exception.code, code)
                self.assertEqual(emitted, [])
                self.assertEqual(len(self.native.chat_calls), before + 1)
                self.assertEqual(len(self.http.requests), before_requests)

    def test_round_robin_sends_only_selected_account_uid_not_credential_tokens(self):
        self.ready()
        self.ready("fixture-user-b")
        for _ in range(4):
            self.provider.chat(self.payload)
        calls = self.native.chat_calls
        self.assertEqual({row["uid"] for row in calls}, {UID, "fixture-user-b"})
        self.assertNotEqual(calls[0]["uid"], calls[1]["uid"])
        self.assertEqual(calls[0]["uid"], calls[2]["uid"])
        self.assertEqual(calls[1]["uid"], calls[3]["uid"])
        self.assertTrue(all(row["model"] == MID for row in calls))
        self.assertNotIn(TOKEN, json.dumps(calls))
        self.assertEqual(set(self.native.catalog_calls), {UID, "fixture-user-b"})

    def test_buffered_sse_and_nonstream_response_retain_actual_upstream_identity(self):
        self.ready()
        stream = self.provider.stream(self.payload)
        self.assertEqual(self.native.chat_calls, [])
        chunks = list(stream)
        expected_metadata = {"route": "native_client", "streaming": "buffered", "upstream_model": ACTUAL}
        self.assertEqual(len(self.native.chat_calls), 1)
        self.assertEqual(len(chunks), 4)
        self.assertTrue(all(row["provider_metadata"] == expected_metadata for row in chunks))
        self.assertTrue(all(row["model"] == "trae/" + MID for row in chunks))
        self.assertEqual(chunks[0]["choices"][0]["delta"], {"role": "assistant"})
        self.assertEqual(chunks[1]["choices"][0]["delta"], {"reasoning_content": "native reasoning"})
        self.assertEqual(chunks[2]["choices"][0]["delta"], {"content": "native answer"})
        self.assertEqual(chunks[-1]["choices"][0]["finish_reason"], "stop")
        self.assertEqual(chunks[-1]["usage"]["total_tokens"], 10)
        completion = self.provider.chat(self.payload)
        self.assertEqual(completion["object"], "chat.completion")
        self.assertEqual(completion["provider_metadata"], expected_metadata)
        self.assertEqual(completion["choices"][0]["message"], {
            "role": "assistant", "content": "native answer", "reasoning_content": "native reasoning"})
        self.assertEqual(completion["choices"][0]["finish_reason"], "stop")
        self.assertEqual(completion["usage"]["total_tokens"], 10)
        self.assertNotIn(UID, json.dumps(completion))

    def test_missing_native_usage_is_estimated_and_marked_without_faking_upstream_billing(self):
        self.ready()
        self.native.result = chat_value(
            usage={"prompt_tokens": 11, "completion_tokens": 5, "total_tokens": 16},
            usageEstimated=True,
        )
        completion = self.provider.chat(self.payload)
        self.assertGreater(completion["usage"]["total_tokens"], 0)
        self.assertTrue(completion["provider_metadata"]["usage_estimated"])
        self.assertEqual(completion["provider_metadata"]["usage_source"], "estimated")
        analytics = self.provider.analytics()
        self.assertEqual(analytics["summary"]["estimatedRequests"], 1)
        self.assertGreater(analytics["summary"]["estimatedTokens"], 0)
        self.assertEqual(analytics["recent"][0]["usageSource"], "estimated")

    def test_native_temperature_and_top_p_rejected_before_chat_dispatch(self):
        self.ready()
        for parameter in ({"temperature": 0}, {"temperature": 1}, {"top_p": 0}, {"top_p": 1},
                          {"temperature": 0.5, "top_p": 0.9}):
            with self.subTest(parameter=parameter):
                error = self.assert_code("unsupported_feature", lambda: self.provider.chat({**self.payload, **parameter}))
                self.assertEqual(error.status, 422)
        self.assertEqual(self.native.chat_calls, [])
        self.assertEqual(len(self.http.requests), 1)

    def test_max_tokens_maps_to_bounded_native_character_budget_and_full_history(self):
        self.ready()
        history = [{"role": "system", "content": "rules"}, {"role": "user", "content": "first"},
                   {"role": "assistant", "content": "answer"}, {"role": "user", "content": "second"}]
        for tokens, expected in ((1, 8192), (32, 8192), (65536, 65536)):
            self.provider.chat({**self.payload, "messages": history, "max_tokens": tokens})
            call = self.native.chat_calls[-1]
            self.assertEqual(call["max_chars"], expected)
            self.assertEqual(call["messages"], [{"role": row["role"], "content": [{"type": "text", "text": row["content"]}]} for row in history])


if __name__ == "__main__":
    unittest.main()
