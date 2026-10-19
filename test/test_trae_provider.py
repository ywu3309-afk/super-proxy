"""Offline TRAE contract tests. No real credentials or upstream chat requests."""
import base64
import io
import http.client
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))
import wb_trae as trae

TOKEN = "not-a-real-token-test-0123456789"
MODEL = "trae/test-model-v1"
FIXTURES = (
    "dGMFEAAAEREREREREREREREREREREREREREREREREREREREREREXT7J7GhSe22pOYWi6mLtkWOHILDwRHoppXdplbiIu2Cv6mSxxtFsh5NOx5uaIe3K05Czk9oL3ZLwooT7YCI8LZ/duy6TOMeMM53Hh3sz52mRZUORpxBewbnhkuNjH39r9es7sY11g6GGRvvPJJSU8EA8sxmpBtbZ4WFGur7tlOpiY5zEWpDCN/uMw0NTbDRNmVEoVCRQSvtKUWcMTphkkTGcsgJwjjJ1hfWecqHcpM1c0bSbwkvL249jua3Li7fFOQqyRQzwkb/D4Vd57YpvD",
    "EjkgIAIDERERERERERERERERERERERERERERERERERERERERERHaNLyIOUumUhm7ZDHlBXmZDi1EdpoFxh02NHFaqA2p7+CAVd4ZS6Y7QS5GXm4KMd93r2HUOwCxFE2xdY3QqUZwZHTYE2Z8CZptyW6rFWrCrvVlp3C7qD6wH7aSTyzUNxWchsmVEWEbSsbrfESl+O1gLtvEvNJecpscnakzW3lRGZgqCF35dKUxWV5Sf3QK8oiyEX5xVi6DeI2Y3X8wDeN9Fm6DDY50UJTxYldxKC9FwFsW0GAH6drDup+RxAXHIw721pKuHLFZRUK+r9D8LJ2Q",
)


def fake_protect(data, decrypt=False):
    """Test injection only, deliberately not the production credential codec."""
    if decrypt:
        return bytes(x ^ 0xa5 for x in data)
    return bytes(x ^ 0xa5 for x in data)


def sse(events):
    return "".join("event: " + name + "\r\ndata: " + json.dumps(value, ensure_ascii=False) + "\r\n\r\n"
                   for name, value in events).encode("utf-8")


class Response(io.BytesIO):
    def __init__(self, body=b"", ctype="application/json", status=200, url=None):
        super().__init__(body)
        self.headers = {"Content-Type": ctype}
        self.status = status
        self.url = url

    def getcode(self):
        return self.status

    def geturl(self):
        return self.url


class FakeHTTP:
    def __init__(self):
        self.queue = []
        self.requests = []

    def add(self, value, ctype="application/json", status=200, url=None):
        if not isinstance(value, bytes):
            value = json.dumps(value).encode()
        self.queue.append(Response(value, ctype, status, url))

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        if not self.queue:
            raise AssertionError("Unexpected request or replay")
        value = self.queue.pop(0)
        if isinstance(value, Exception):
            raise value
        if value.url is None:
            value.url = request.full_url
        return value


class ProviderTests(unittest.TestCase):
    def setUp(self):
        folder = ROOT / "analysis/trae-integration-20261019"
        folder.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="provider-test-", dir=folder)
        self.addCleanup(self.temp.cleanup)
        self.http = FakeHTTP()
        self.provider = trae.TraeProvider(self.temp.name, opener=self.http, protector=fake_protect)
        self.payload = {"model": MODEL, "messages": [{"role": "user", "content": "你好"}]}

    def imported(self, **kwargs):
        result = self.provider.import_account({"token": TOKEN, "account": {"uid": "test-user"}, **kwargs})
        return result["accounts"][0]["id"]

    def ready(self):
        account_id = self.imported()
        self.http.add({"user_entitlement_pack_list": [
            {"entitlement_base_info": {"quota": {"credits_limit": 4000}}, "usage": {}},
            {"entitlement_base_info": {"quota": {"credits_limit": 500}}, "usage": {}},
            {"entitlement_base_info": {"quota": {"credits_limit": 100}}, "usage": {"credits_amount": 59.666}},
            {"entitlement_base_info": {"quota": {"other_limit": 20}}, "usage": {}},
        ]})
        self.http.add({"model_configs": [{"name": "test-model-v1", "display_name": "Test Model", "is_preset": True, "status": True, "client_connect": False, "custom_config": ""}]})
        self.provider.refresh(account_id)
        return account_id

    def assertCode(self, code, callback):
        with self.assertRaises(trae.TraeError) as raised:
            callback()
        self.assertEqual(raised.exception.code, code)
        return raised.exception

    def test_import_status_never_contains_credentials_and_keeps_workbuddy_untouched(self):
        marker = Path(self.temp.name) / "accounts/workbuddy.json"
        marker.parent.mkdir()
        marker.write_text("unchanged")
        account_id = self.imported(auth={"accessToken": TOKEN, "refreshToken": "must-not-store-refresh"})
        status = self.provider.status()
        text = json.dumps(status)
        self.assertNotIn(TOKEN, text)
        stored = (self.provider.root / (account_id + ".json")).read_text()
        self.assertNotIn(TOKEN, stored)
        self.assertNotIn("refresh", json.dumps(self.provider._credentials(self.provider._get(account_id))))
        self.assertEqual(marker.read_text(), "unchanged")

    def test_enable_disable_remove_has_recoverable_encrypted_backup(self):
        account_id = self.imported()
        self.assertFalse(self.provider.set_enabled(account_id, False)["accounts"][0]["enabled"])
        self.assertEqual(self.provider.remove_account(account_id)["accounts"], [])
        self.assertEqual(len(list((self.provider.root / "removed").glob("*.json"))), 1)

    def test_account_path_and_uid_injection_are_rejected(self):
        self.assertCode("invalid_account", lambda: self.provider.remove_account("../../bad"))
        self.assertCode("invalid_import", lambda: self.imported(account={"uid": "x\r\nInjected: y"}))

    def test_untrusted_hosts_and_international_regions_rejected_before_storage_or_network(self):
        for host in ("https://evil.test", "https://api.trae.cn.evil.test", "http://api.trae.cn",
                     "https://evil.mchost.guru", "https://api.trae.cn@evil.test", "https://api.trae.cn:1234",
                     "https://api.trae.cn:bad", "https://api.trae.cn/#x"):
            self.assertCode("untrusted_host", lambda: self.imported(apiHost=host))
        self.assertCode("unsupported_region", lambda: self.imported(region="intl"))
        self.assertEqual(self.http.requests, [])
        self.assertEqual(self.provider.status()["accounts"], [])

    def test_invalid_header_tokens_rejected(self):
        self.assertCode("invalid_token", lambda: self.imported(token=TOKEN + "\r\nx: y"))

    def test_refresh_exact_official_request_shapes_and_fractional_credits(self):
        self.ready()
        status = self.provider.status()
        self.assertAlmostEqual(status["accounts"][0]["credits"], 4540.334)
        self.assertEqual(status["accounts"][0]["status"], "ready")
        self.assertEqual(status["models"], [{"id": MODEL, "name": "Test Model"}])
        quota, models = [x[0] for x in self.http.requests]
        self.assertEqual(quota.full_url, "https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage")
        self.assertEqual(json.loads(quota.data), {"require_usage": True, "req_source": 1})
        self.assertEqual(models.full_url, trae._AGENT + "/api/ide/v1/model_list?type=chat")
        self.assertEqual(models.get_method(), "GET")
        self.assertIsNone(models.data)
        self.assertEqual(quota.get_header("Authorization"), "Cloud-IDE-JWT " + TOKEN)
        self.assertEqual(models.get_header("Connection"), "keep-alive")
        self.assertTrue(models.headers.get("X-request-id"))
        self.assertTrue(models.headers.get("X-custom-trace-id"))
        flow_trace = models.headers.get("X-flow-traceparent")
        self.assertRegex(flow_trace, r"^00-[0-9a-f]{32}-[0-9a-f]{16}-01$")
        self.assertNotIn("X-app-function", models.headers)
        self.assertNotIn("X-ide-function", models.headers)
        self.assertTrue(all(timeout == 45 for _, timeout in self.http.requests))

    def test_empty_model_table_is_partial_not_fake_success(self):
        account_id = self.imported()
        self.http.add({"user_entitlement_pack_list": []})
        self.http.add({"model_configs": []})
        result = self.provider.refresh(account_id)
        self.assertEqual(result["accounts"][0]["status"], "partial")
        self.assertIsNone(result["accounts"][0]["credits"])
        self.assertEqual(result["models"], [])

    def test_model_discovery_filters_custom_secrets_but_not_public_icons(self):
        account_id = self.imported()
        self.http.add({"user_entitlement_pack_list": []})
        common = {"is_preset": True, "status": True, "client_connect": False}
        self.http.add({"model_configs": [
            {**common, "name": "official", "icon": {"url": "https://example.test/icon.png"}, "custom_config": ""},
            {**common, "name": "external", "custom_config": '{"base_url":"https://evil.test","ak":"secret"}'},
            {**common, "name": "custom", "is_preset": False},
            {**common, "name": "offline", "status": False},
            {**common, "name": "local", "client_connect": True},
        ]})
        result = self.provider.refresh(account_id)
        self.assertEqual([item["id"] for item in result["models"]], ["trae/official"])
        self.assertNotIn("secret", json.dumps(result))

    def test_credentials_never_allowed_in_get_url(self):
        self.assertCode("invalid_request", lambda: self.provider._json("https://api.trae.cn/?token=" + TOKEN,
            {"token": TOKEN}, None, method="GET"))
        self.assertEqual(self.http.requests, [])

    def test_selection_skips_expired_invalid_session_and_cooling_accounts(self):
        account_id = self.ready()
        row = self.provider._get(account_id)
        for changes in ({"expiresAt": int(time.time()) - 1}, {"status": "login_expired"},
                        {"cooldownUntil": int(time.time()) + 60}):
            changed = dict(row, **changes)
            self.provider._save(changed)
            self.assertCode("no_available_account", lambda: self.provider.chat(self.payload))
        self.assertEqual(len(self.http.requests), 2)
        self.provider._save(row)
        self.provider._mark_error(row, trae.TraeError(502, "static error", "network_error"))
        self.assertEqual(self.provider._choose(MODEL)["id"], account_id)

    def test_rate_limit_retry_after_is_bounded_and_chat_not_replayed(self):
        account_id = self.ready()
        self.http.queue.append(urllib.error.HTTPError(trae._AGENT, 429, "", {"Retry-After": "999999"}, io.BytesIO(b"{}")))
        before = int(time.time())
        self.assertCode("rate_limited", lambda: self.provider.chat(self.payload))
        self.assertEqual(len(self.http.requests), 3)
        row = self.provider._get(account_id)
        self.assertTrue(before + 299 <= row["cooldownUntil"] <= before + 301)
        self.assertCode("no_available_account", lambda: self.provider.chat(self.payload))
        self.assertEqual(len(self.http.requests), 3)

    def test_historical_transient_error_does_not_permanently_disable_account(self):
        self.ready()
        self.http.queue.append(urllib.error.HTTPError(trae._AGENT, 503, "", {}, io.BytesIO(b"{}")))
        self.assertCode("upstream_error", lambda: self.provider.chat(self.payload))
        self.assertEqual(len(self.http.requests), 3)
        self.http.add(sse([("output", {"response": "retry is an explicit new request"}), ("done", {})]), "text/event-stream")
        self.assertEqual(self.provider.chat(self.payload)["choices"][0]["message"]["content"], "retry is an explicit new request")
        self.assertEqual(len(self.http.requests), 4)

    def test_malformed_or_future_account_schema_does_not_break_status(self):
        self.imported()
        row = self.provider._records()[0]
        for change in ({"expiresAt": "bad"}, {"models": ["bad"]}, {"schemaVersion": 999}, {"credits": "bad"}):
            self.provider._save(dict(row, **change))
            self.assertEqual(self.provider.status()["accounts"], [])
        self.provider._save(row)
        self.assertEqual(len(self.provider.status()["accounts"]), 1)

    def test_huge_json_integer_record_is_isolated_and_other_account_survives(self):
        account_id = self.ready()
        row = self.provider._get(account_id)
        corrupt = dict(row, id="b" * 24, expiresAt=10 ** 400)
        self.provider._save(corrupt)
        self.assertEqual([r["id"] for r in self.provider.status()["accounts"]], [account_id])
        corrupt["expiresAt"] = 0
        corrupt["credits"] = 10 ** 400
        self.provider._save(corrupt)
        self.assertEqual(len(self.provider.models()), 1)

    def test_huge_payload_numbers_and_expiry_fail_without_overflow(self):
        for key in ("temperature", "top_p", "max_tokens"):
            self.assertCode("invalid_request", lambda: self.provider.chat(dict(self.payload, **{key: 10 ** 400})))
        self.assertEqual(trae._expires(10 ** 400), 0)
        self.assertFalse(trae._finite_number(10 ** 400))
        self.assertEqual(self.http.requests, [])

    def test_null_or_oversized_quota_does_not_break_valid_pack_aggregation(self):
        value = {"user_entitlement_pack_list": [
            {"entitlement_base_info": {"quota": None}, "usage": {}},
            {"entitlement_base_info": {"quota": [1]}, "usage": {}},
            {"entitlement_base_info": {"quota": {"credits_limit": 10 ** 400}}, "usage": {}},
            {"entitlement_base_info": {"quota": {"credits_limit": 500}}, "usage": {"credits_amount": 0.25}},
        ]}
        credits, details = self.provider._parse_credits(value)
        self.assertEqual(credits, 499.75)
        self.assertEqual(len(details), 1)

    def test_json_body_read_failures_are_sanitized_and_response_closed(self):
        class BrokenResponse(Response):
            def read(self, *args):
                raise http.client.IncompleteRead(TOKEN.encode())
        response = BrokenResponse(url="https://api.trae.cn/test")
        self.http.queue.append(response)
        error = self.assertCode("network_error", lambda: self.provider._json("https://api.trae.cn/test", {"token": TOKEN}, {}))
        self.assertNotIn(TOKEN, str(error))
        self.assertTrue(response.closed)

    def test_model_candidate_revalidated_after_waiting_for_account_lock(self):
        account_id = self.ready()
        pending = self.provider.stream(self.payload)
        row = self.provider._get(account_id)
        row["models"] = []
        self.provider._save(row)
        self.assertCode("model_unavailable", lambda: list(pending))
        self.assertEqual(len(self.http.requests), 2)

    def test_cancelling_stream_closes_response_and_releases_account_lock(self):
        account_id = self.ready()
        response = Response(sse([("output", {"response": "x"}), ("done", {})]), "text/event-stream")
        self.http.queue.append(response)
        pending = self.provider.stream(self.payload)
        next(pending)
        pending.close()
        self.assertTrue(response.closed)
        acquired = []
        def worker():
            lock = self.provider._account_lock(account_id)
            held = lock.acquire(timeout=0.5)
            acquired.append(held)
            if held:
                lock.release()
        thread = threading.Thread(target=worker)
        thread.start()
        thread.join(timeout=1)
        self.assertEqual(acquired, [True])

    def test_upstream_ignoring_max_tokens_is_locally_bounded_without_replay(self):
        self.ready()
        huge = "x" * 300
        self.http.add(sse([("output", {"response": huge}), ("done", {})]), "text/event-stream")
        payload = dict(self.payload, max_tokens=2)
        error = self.assertCode("output_limit", lambda: self.provider.chat(payload))
        self.assertNotIn("x" * 80, str(error))
        # Two refresh requests + exactly one chat request; no hidden replay.
        self.assertEqual(len(self.http.requests), 3)

    def test_disabled_accounts_do_not_contribute_models(self):
        account_id = self.ready()
        self.provider.set_enabled(account_id, False)
        self.assertEqual(self.provider.models(), [])
        self.assertCode("no_available_account", lambda: self.provider.chat(self.payload))

    def test_expired_snapshot_requires_client_resync_without_network_refresh(self):
        account_id = self.imported(expiresAt=int(time.time()) - 30)
        self.assertEqual(self.provider.status()["accounts"][0]["status"], "login_expired")
        self.assertCode("login_expired", lambda: self.provider.refresh(account_id))
        self.assertEqual(self.http.requests, [])

    def test_text_chat_and_solo_sse_aggregate_without_replay(self):
        self.ready()
        self.http.add(sse([("metadata", {"session_id": "not-exposed"}),
            ("output", {"response": "你", "reasoning_content": "r", "tool_calls": None}),
            ("output", {"response": "好"}),
            ("token_usage", {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5, "secret": TOKEN}),
            ("done", {"finish_reason": "stop"})]), "text/event-stream; charset=utf-8")
        result = self.provider.chat(self.payload)
        self.assertEqual(result["object"], "chat.completion")
        self.assertEqual(result["model"], MODEL)
        self.assertEqual(result["choices"][0]["message"], {"role": "assistant", "content": "你好", "reasoning_content": "r"})
        self.assertEqual(result["usage"], {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5})
        req = self.http.requests[-1][0]
        self.assertEqual(req.full_url, trae._AGENT + "/api/agent/v3/llm_utils_chat")
        self.assertEqual(json.loads(req.data), {"model": "test-model-v1",
            "function": "chat_v3", "stream": True, "max_tokens": 512,
            "messages": [{"role": "user", "content": [{"type": "text", "text": "你好"}]}]})
        self.assertEqual(req.headers.get("X-app-function"), "chat_v3")
        self.assertEqual(req.headers.get("X-ide-function"), "chat_v3")
        self.assertEqual(req.get_header("Connection"), "keep-alive")
        self.assertRegex(req.headers.get("X-flow-traceparent"), r"^00-[0-9a-f]{32}-[0-9a-f]{16}-01$")
        self.assertEqual(len(self.http.requests), 3)

    def test_stream_preserves_namespaced_model_and_finish_reason(self):
        self.ready()
        self.http.add(sse([("output", {"response": "x"}), ("done", {"finish_reason": "length"})]), "text/event-stream")
        chunks = list(self.provider.stream(self.payload))
        self.assertEqual(len(chunks), 3)
        self.assertTrue(all(c["model"] == MODEL for c in chunks))
        self.assertEqual(chunks[-1]["choices"][0]["finish_reason"], "length")

    def test_missing_terminal_event_cannot_return_partial_as_success(self):
        account_id = self.ready()
        self.http.add(sse([("output", {"response": "partial"})]), "text/event-stream")
        self.assertCode("incomplete_stream", lambda: self.provider.chat(self.payload))
        self.assertEqual(len(self.http.requests), 3)
        self.assertEqual(self.provider._get(account_id)["status"], "incomplete_stream")

    def test_sse_error_sanitized_and_not_replayed(self):
        self.ready()
        self.http.add(sse([("error", {"code": 1005, "message": "echo " + TOKEN})]), "text/event-stream")
        error = self.assertCode("credits_exhausted", lambda: self.provider.chat(self.payload))
        self.assertNotIn(TOKEN, str(error))
        self.assertNotIn(TOKEN, json.dumps(self.provider.status()))
        self.assertEqual(len(self.http.requests), 3)

    def test_http_error_body_never_exposes_secrets(self):
        account_id = self.imported()
        self.http.queue.append(urllib.error.HTTPError("https://api.trae.cn", 401, "bad", {}, io.BytesIO(TOKEN.encode())))
        self.http.add({"model_configs": []})
        error = self.assertCode("login_expired", lambda: self.provider.refresh(account_id))
        self.assertNotIn(TOKEN, str(error))

    def test_redirect_response_is_blocked_even_for_injected_transport(self):
        account_id = self.imported()
        self.http.add({}, url="https://evil.test")
        self.http.add({}, url="https://evil.test")
        self.assertCode("redirect_blocked", lambda: self.provider.refresh(account_id))

    def test_redirect_handler_never_forwards_authorization(self):
        handler = trae._NoRedirect()
        self.assertCode("redirect_blocked", lambda: handler.redirect_request(None, None, 302, "", {}, "https://evil.test"))

    def test_unsupported_tools_images_rejected_before_network(self):
        bad = [dict(self.payload, tools=[]), dict(self.payload, tool_choice="none"),
            dict(self.payload, messages=[{"role": "tool", "content": "x"}]),
            dict(self.payload, messages=[{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "https://x"}}]}])]
        for payload in bad:
            self.assertCode("unsupported_feature", lambda: self.provider.chat(payload))
        self.assertEqual(self.http.requests, [])

    def test_malformed_sse_and_oversized_json_fail_closed(self):
        self.assertCode("invalid_upstream_response", lambda: list(trae.iter_sse(io.BytesIO(b"event: output\ndata: not-json\n\n"))))
        self.assertCode("response_too_large", lambda: list(trae.iter_sse(io.BytesIO(b"x" * (trae._LINE_LIMIT + 1)))))
        account_id = self.imported()
        credentials = self.provider._credentials(self.provider._get(account_id))
        self.http.add(b"x" * (trae._JSON_LIMIT + 1))
        self.assertCode("response_too_large", lambda: self.provider._json("https://api.trae.cn/test", credentials, {}))

    def test_pure_decoder_both_format_headers_and_integrity(self):
        for fixture in FIXTURES:
            value = trae.decode_stored_user_info(fixture)
            self.assertEqual(value["token"], "fixture-token-only-123456789")
            damaged = bytearray(base64.b64decode(fixture))
            damaged[-1] ^= 1
            self.assertCode("local_storage_unsupported", lambda: trae.decode_stored_user_info(base64.b64encode(damaged).decode()))

    def test_aes128_cbc_nist_known_answer(self):
        key = bytes.fromhex("2b7e151628aed2a6abf7158809cf4f3c")
        iv = bytes.fromhex("000102030405060708090a0b0c0d0e0f")
        self.assertEqual(trae._aes128_cbc_decrypt(key, iv, bytes.fromhex("7649abac8119b246cee98e9b12e9197d")),
                         bytes.fromhex("6bc1bee22e409f96e93d7e117393172a"))

    def test_local_import_reads_target_key_only_and_does_not_write_client_storage(self):
        appdata = Path(self.temp.name) / "appdata"
        storage = appdata / "Trae CN/User/globalStorage/storage.json"
        storage.parent.mkdir(parents=True)
        document = {"iCubeAuthInfo://icube.cloudide": FIXTURES[0], "icube-dc:fixture-user": "must-not-read-or-copy-device-key"}
        storage.write_text(json.dumps(document), encoding="utf-8")
        before = storage.read_bytes()
        with mock.patch.dict(os.environ, {"APPDATA": str(appdata)}):
            result = self.provider.import_local()
        self.assertEqual(result["accounts"][0]["label"], "Fixture")
        self.assertEqual(storage.read_bytes(), before)
        account_id = result["accounts"][0]["id"]
        private = self.provider._credentials(self.provider._get(account_id))
        self.assertNotIn("must-not-read-or-copy-device-key", json.dumps(private))
        self.assertEqual(self.http.requests, [])

    @unittest.skipUnless(os.name == "nt", "Windows DPAPI")
    def test_real_windows_dpapi_roundtrip(self):
        data = b"fixture-not-an-actual-credential"
        encrypted = trae._dpapi(data)
        self.assertNotIn(data, encrypted)
        self.assertEqual(trae._dpapi(encrypted, True), data)


if __name__ == "__main__":
    unittest.main()
