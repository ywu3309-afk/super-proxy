"""Exercise the real gateway handler with a local-only, fake TRAE transport."""
import http.client
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))
SANDBOX = Path(tempfile.mkdtemp(prefix="trae-http-test-", dir=ROOT / "analysis"))
os.environ["ACCOUNTS_DIR"] = str(SANDBOX / "data/accounts")
os.environ["WB_PROXY_USAGE_DIR"] = str(SANDBOX / "data/usage")
import wb_proxy
import wb_trae
import wb_trae_http


class Provider:
    def __init__(self):
        self.calls = []
        self.fail = None

    def status(self):
        return {"provider": "trae", "accounts": [], "models": self.models(), "client": {"installed": False}}

    def models(self):
        return [{"id": "trae/mock-text", "name": "Mock text", "object": "model", "owned_by": "trae"}]

    def import_account(self, payload):
        self.calls.append(("import", set(payload)))
        return self.status()

    def import_local(self):
        self.calls.append(("scan",))
        return self.status()

    def refresh(self, account_id=None):
        self.calls.append(("refresh", account_id))
        return self.status()

    def set_enabled(self, account_id, enabled):
        self.calls.append(("toggle", account_id, enabled))
        return self.status()

    def remove_account(self, account_id):
        self.calls.append(("remove", account_id))
        return self.status()

    def chat(self, payload):
        self.calls.append(("chat",))
        if self.fail:
            raise wb_trae.TraeError(401, "Login expired", "login_expired")
        return {"object": "chat.completion", "model": payload["model"], "choices": [{"message": {"role": "assistant", "content": "mock-response"}}]}

    def stream(self, payload):
        self.calls.append(("stream",))
        if self.fail == "before":
            raise wb_trae.TraeError(401, "Login expired", "login_expired")
        yield {"object": "chat.completion.chunk", "choices": [{"delta": {"role": "assistant"}}]}
        if self.fail == "during":
            raise wb_trae.TraeError(502, "Upstream interrupted", "incomplete_stream")
        yield {"object": "chat.completion.chunk", "choices": [{"delta": {"content": "mock-response"}, "finish_reason": "stop"}]}


class Handler(wb_proxy.Handler):
    def log_message(self, *args):
        pass

    def _panel_ok(self):
        return self.headers.get("X-Panel-Token") == "fixture-panel"

    def _key_ok(self):
        self.key_entry = None
        return self.headers.get("Authorization") == "Bearer fixture-key" or self._panel_ok()

    def _key_realm(self):
        return self.headers.get("X-Test-Bound-Realm", "")

    def _banned_model_error(self, model):
        return "blocked model" if model == "trae/blocked" else ""

    def _key_model_error(self, model):
        return ""


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = wb_proxy.GatewayServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.server.server_port

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def setUp(self):
        self.provider = Provider()
        self.patches = [patch.object(wb_trae_http, "provider_for", return_value=self.provider),
                        patch.object(wb_proxy, "BLOCK_BACKGROUND_REQUESTS", False)]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def request(self, method, path, payload=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            body = None if payload is None else json.dumps(payload)
            connection.request(method, path, body, {"Content-Type": "application/json", **(headers or {})})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read().decode("utf-8")
        finally:
            connection.close()

    def test_status_requires_panel_not_just_api_key(self):
        self.assertEqual(self.request("GET", "/providers/trae")[0], 401)
        self.assertEqual(self.request("GET", "/providers/trae", headers={"Authorization": "Bearer fixture-key"})[0], 401)

    def test_status_is_no_store_and_does_not_scan_or_refresh(self):
        status, headers, text = self.request("GET", "/providers/trae", headers={"X-Panel-Token": "fixture-panel"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(json.loads(text)["provider"], "trae")
        self.assertFalse(self.provider.calls)

    def test_cross_origin_and_dns_rebinding_are_rejected(self):
        for extra in ({"Origin": "https://other.invalid"}, {"Host": "rebinding.invalid"}, {"Sec-Fetch-Site": "cross-site"}):
            self.assertEqual(self.request("POST", "/providers/trae/scan", {}, {"X-Panel-Token": "fixture-panel", **extra})[0], 403)
        self.assertFalse(self.provider.calls)

    def test_same_origin_scan_requires_explicit_post(self):
        status, _, _ = self.request("POST", "/providers/trae/scan", {}, {"X-Panel-Token": "fixture-panel", "Origin": "http://127.0.0.1:%d" % self.port})
        self.assertEqual(status, 200)
        self.assertEqual(self.provider.calls, [("scan",)])

    def test_management_actions_are_dispatched(self):
        for action, payload in (("import", {"token": "fixture-not-a-secret"}), ("refresh", {"id": "fixture"}), ("toggle", {"id": "fixture", "enabled": False}), ("remove", {"id": "fixture"})):
            self.assertEqual(self.request("POST", "/providers/trae/" + action, payload, {"X-Panel-Token": "fixture-panel"})[0], 200)
        self.assertEqual([row[0] for row in self.provider.calls], ["import", "refresh", "toggle", "remove"])

    def test_chat_requires_api_authorization(self):
        self.assertEqual(self.request("POST", "/v1/chat/completions", {"model": "trae/mock-text", "messages": []})[0], 401)
        self.assertFalse(self.provider.calls)

    def test_normal_chat_uses_trae_not_workbuddy(self):
        status, _, text = self.request("POST", "/v1/chat/completions", {"model": "trae/mock-text", "messages": []}, {"Authorization": "Bearer fixture-key"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(text)["model"], "trae/mock-text")
        self.assertEqual(self.provider.calls, [("chat",)])

    def test_realm_bound_keys_and_banned_models_do_not_dispatch(self):
        for model, headers in (("trae/mock-text", {"X-Test-Bound-Realm": "cn"}), ("trae/blocked", {})):
            self.assertEqual(self.request("POST", "/v1/chat/completions", {"model": model}, {"Authorization": "Bearer fixture-key", **headers})[0], 403)
        self.assertFalse(self.provider.calls)

    def test_stream_has_done_only_after_success(self):
        status, headers, text = self.request("POST", "/v1/chat/completions", {"model": "trae/mock-text", "stream": True}, {"Authorization": "Bearer fixture-key"})
        self.assertEqual(status, 200)
        self.assertIn("text/event-stream", headers["Content-Type"])
        self.assertTrue(text.endswith("data: [DONE]\n\n"))

    def test_stream_preflight_error_is_not_http_200(self):
        self.provider.fail = "before"
        status, _, text = self.request("POST", "/v1/chat/completions", {"model": "trae/mock-text", "stream": True}, {"Authorization": "Bearer fixture-key"})
        self.assertEqual(status, 401)
        self.assertEqual(json.loads(text)["error"]["code"], "login_expired")

    def test_midstream_error_is_not_reported_as_success(self):
        self.provider.fail = "during"
        status, _, text = self.request("POST", "/v1/chat/completions", {"model": "trae/mock-text", "stream": True}, {"Authorization": "Bearer fixture-key"})
        self.assertEqual(status, 200)
        self.assertIn('"code":"incomplete_stream"', text)
        self.assertNotIn("[DONE]", text)

    def test_trae_models_query_does_not_touch_workbuddy_upstream(self):
        with patch.object(wb_proxy, "fetch_models", side_effect=AssertionError("unexpected WorkBuddy call")):
            status, _, text = self.request("GET", "/v1/models?provider=trae", headers={"Authorization": "Bearer fixture-key"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(text)["data"][0]["id"], "trae/mock-text")

    def test_provider_cache_failure_does_not_break_workbuddy_models(self):
        with patch.object(self.provider, "models", side_effect=ValueError("fixture corrupt store")), \
             patch.object(wb_proxy, "fetch_models", return_value=[]), \
             patch.object(wb_proxy.wb_modelsdev, "refresh_async"):
            status, _, text = self.request("GET", "/v1/models", headers={"Authorization": "Bearer fixture-key"})
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(text)["data"], [])
            status, _, text = self.request("GET", "/v1/models?provider=trae", headers={"Authorization": "Bearer fixture-key"})
            self.assertEqual(status, 503)
            self.assertNotIn("fixture corrupt store", text)

    def test_upstream_login_error_does_not_logout_panel(self):
        for upstream_status in (401, 403):
            with patch.object(self.provider, "refresh", side_effect=wb_trae.TraeError(upstream_status, "Refresh TRAE login", "login_expired")):
                status, _, text = self.request("POST", "/providers/trae/refresh", {"id": "fixture"}, {"X-Panel-Token": "fixture-panel"})
                self.assertEqual(status, 409)
                self.assertEqual(json.loads(text)["error"]["code"], "login_expired")
                self.assertEqual(self.request("GET", "/providers/trae", headers={"X-Panel-Token": "fixture-panel"})[0], 200)


if __name__ == "__main__":
    unittest.main()
