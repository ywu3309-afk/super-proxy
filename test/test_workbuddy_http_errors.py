"""Real loopback HTTP handlers and isolated upstream fixtures; never live accounts."""
import ast
import copy
import http.client
import io
import json
import os
from pathlib import Path
import sys
import threading
import time
import types
import unittest
from unittest.mock import Mock, patch
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))
# Import-time defaults, if this is the first importer, point only at an unused
# D-drive fixture path. No directories or credentials are created or loaded.
with patch.dict(os.environ, {
    "ACCOUNTS_DIR": str(ROOT / "analysis" / "http-errors-unused" / "accounts"),
    "WB_PROXY_USAGE_DIR": str(ROOT / "analysis" / "http-errors-unused" / "usage"),
}):
    import wb_proxy


MODEL = "deepseek-v4.1-flash"
ACCOUNT = "fixture-account-not-a-real-user"
REQUEST_ID = "01a15d9720187546abf208abcea1b17b"
SECRET = "fixture-upstream-password-do-not-echo"


def upstream_error(payload):
    raw = json.dumps(payload).encode("utf-8")
    exc = urllib.error.HTTPError("https://fixture.invalid/chat", 400, "fixture", {}, io.BytesIO(raw))
    exc.account_uid = ACCOUNT
    return exc


class FixtureHandler(wb_proxy.Handler):
    def log_message(self, *args):
        pass

    def _key_ok(self):
        self.key_entry = {"id": "fixture-key-id"}
        return self.headers.get("Authorization") == "Bearer fixture-key"

    def _key_realm(self):
        return "cn"

    def _cross_realm_error(self, model, realm):
        return ""

    def _banned_model_error(self, model):
        return ""

    def _key_model_error(self, model):
        return ""


class WorkBuddyHTTPErrorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = wb_proxy.GatewayServer(("127.0.0.1", 0), FixtureHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.server.server_port

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def setUp(self):
        self.rows = []
        self.patches = [
            patch.object(wb_proxy, "BLOCK_BACKGROUND_REQUESTS", False),
            patch.object(wb_proxy, "_apply_background_model_alias", return_value=None),
            patch.object(wb_proxy, "POOL", None),
            patch.object(wb_proxy, "CURRENT_REALM", "cn"),
            patch.object(wb_proxy, "log"),
            patch.object(wb_proxy, "_persist_usage", side_effect=lambda row, label: self.rows.append(copy.deepcopy(row))),
            patch.object(wb_proxy, "build_upstream_body", side_effect=lambda payload: copy.deepcopy(payload)),
            patch.object(wb_proxy, "upstream_effort_of", return_value="max"),
            patch.object(wb_proxy, "responses_to_chat", side_effect=lambda payload: {
                "model": payload["model"], "messages": [{"role": "user", "content": "fixture hello"}],
                "stream": payload.get("stream", False),
            }),
            patch.object(wb_proxy.wb_accounts, "urlopen", side_effect=AssertionError("unexpected outbound transport")),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def request(self, path, stream=False):
        payload = {"model": MODEL, "stream": stream}
        if path.endswith("responses"):
            payload["input"] = "fixture hello"
        else:
            payload["messages"] = [{"role": "user", "content": "fixture hello"}]
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request("POST", path, json.dumps(payload), {
                "Authorization": "Bearer fixture-key", "Content-Type": "application/json",
            })
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read().decode("utf-8")
        finally:
            connection.close()

    def exercise(self, path, exc, stream=False):
        with patch.object(wb_proxy, "open_upstream", side_effect=exc) as opened:
            result = self.request(path, stream)
        self.assertEqual(opened.call_count, 1, "a rejected call must not be retried")
        self.assertEqual(opened.call_args.args[0]["model"], MODEL)
        self.assertEqual(len(self.rows), 1, "record exactly one failed request")
        self.assertEqual(self.rows[0]["account"], ACCOUNT)
        self.assertEqual(self.rows[0]["model"], MODEL)
        self.assertEqual(self.rows[0]["status"], 400)
        self.assertEqual(self.rows[0]["outcome"], "failed")
        return result

    def test_chat_and_responses_return_structured_11128_for_stream_and_nonstream(self):
        for path in ("/v1/chat/completions", "/v1/responses"):
            for stream in (False, True):
                with self.subTest(path=path, stream=stream):
                    self.rows.clear()
                    status, headers, text = self.exercise(path, upstream_error({
                        "code": 11128, "requestId": REQUEST_ID, "msg": SECRET,
                        "secret": SECRET, "displayTips": {"en": SECRET},
                        "headers": {"Authorization": SECRET},
                    }), stream)
                    self.assertEqual(status, 400)
                    self.assertIn("application/json", headers["Content-Type"])
                    self.assertNotIn("text/event-stream", headers["Content-Type"])
                    error = json.loads(text)["error"]
                    self.assertEqual(error["code"], "upstream_channel_rejected")
                    self.assertEqual(error["type"], "invalid_request_error")
                    self.assertEqual(error["provider"], "workbuddy")
                    self.assertEqual(error["upstream_code"], 11128)
                    self.assertEqual(error["upstream_request_id"], REQUEST_ID)
                    self.assertEqual(error["model"], MODEL)
                    self.assertNotIn(SECRET, text)
                    self.assertEqual(self.rows[0]["upstream"], {
                        "provider": "workbuddy", "code": "upstream_channel_rejected",
                        "upstream_code": 11128, "upstream_request_id": REQUEST_ID,
                    })
                    self.assertNotIn(SECRET, json.dumps(self.rows))

    def test_unknown_400_keeps_original_server_error_envelope(self):
        for path in ("/v1/chat/completions", "/v1/responses"):
            with self.subTest(path=path):
                self.rows.clear()
                status, _, text = self.exercise(path, upstream_error({"code": 12345, "msg": "fixture unknown"}))
                self.assertEqual(status, 400)
                error = json.loads(text)["error"]
                self.assertEqual(error["type"], "server_error")
                self.assertEqual(error["code"], 400)
                self.assertIn("upstream 400:", error["message"])
                self.assertIn("fixture unknown", error["message"])
                self.assertNotIn("upstream", self.rows[0])

    def test_valid_json_longer_than_old_600_byte_cap_is_classified(self):
        for path in ("/v1/chat/completions", "/v1/responses"):
            with self.subTest(path=path):
                self.rows.clear()
                payload = {"padding": "x" * 2000, "code": "11-128", "requestId": REQUEST_ID, "secret": SECRET}
                status, _, text = self.exercise(path, upstream_error(payload), stream=True)
                self.assertEqual(status, 400)
                error = json.loads(text)["error"]
                self.assertEqual(error["code"], "upstream_channel_rejected")
                self.assertEqual(error["upstream_request_id"], REQUEST_ID)
                self.assertNotIn("padding", text)
                self.assertNotIn(SECRET, text)
                self.assertEqual(self.rows[0]["upstream"]["upstream_request_id"], REQUEST_ID)

    def test_interrupted_error_body_preserves_http_rejection_without_leaking_read_error(self):
        for path in ("/v1/chat/completions", "/v1/responses"):
            for failure in (OSError(SECRET), http.client.IncompleteRead(SECRET.encode(), 100)):
                with self.subTest(path=path, failure=type(failure).__name__):
                    self.rows.clear()
                    exc = upstream_error({"code": 11128})
                    exc.read = Mock(side_effect=failure)
                    status, _, text = self.exercise(path, exc)
                    self.assertEqual(status, 400)
                    error = json.loads(text)["error"]
                    self.assertEqual(error["code"], 400)
                    self.assertEqual(error["type"], "server_error")
                    self.assertIn("body unavailable", error["message"])
                    self.assertNotIn(SECRET, text)
                    self.assertNotIn("upstream", self.rows[0])
                    exc.read.assert_called_once_with(8192)


class WorkBuddyUpstreamAttributionTests(unittest.TestCase):
    def test_direct_400_has_actual_account_and_does_not_retry_or_mutate_account(self):
        # Execute only this function's AST with a closed fixture namespace.
        # The actual account store, settings readers and external transport are
        # never reachable, even if the module was imported by another test.
        tree = ast.parse((ROOT / "hub" / "wb_proxy.py").read_text(encoding="utf-8"))
        method = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "open_upstream")
        account = types.SimpleNamespace(uid=ACCOUNT, realm="cn", product="fixture-desktop", proxy=None)
        account.is_cli_identity = Mock(return_value=False)
        account.chat_base_url = Mock(return_value="https://fixture.invalid")
        account.headers = Mock(return_value={"X-Fixture": "only"})
        mutations = ("note_success", "note_failure", "note_unknown_failure", "note_error", "note_balance_cooled",
                     "note_restricted", "note_soft_rate", "note_unscoped_rate", "refresh", "clear_error")
        for name in mutations:
            setattr(account, name, Mock(side_effect=AssertionError("unexpected account mutation: " + name)))
        state = {key: getattr(account, key) for key in ("uid", "realm", "product", "proxy")}
        pool = types.SimpleNamespace(
            accounts=[account], apply_remaining_weights=Mock(), count_ready=Mock(return_value=1),
            pick_for_session=Mock(return_value=account), affinity=types.SimpleNamespace(demote=Mock()),
        )
        exc = upstream_error({"code": 11128, "requestId": REQUEST_ID})
        del exc.account_uid  # The real function must supply the attribution.
        transport = Mock(side_effect=exc)
        namespace = {
            "POOL": pool, "CURRENT_REALM": "cn", "ACCOUNTS_DIR": "D:/fixture-unused/accounts",
            "CHAT_PATH": "/fixture/chat", "MAX_PRODUCT_SWITCHES": 0,
            "apply_daily_guards": Mock(), "remaining_priority_enabled": lambda: False,
            "pinned_account": lambda: None, "restriction_hold_remaining": lambda realm: 0,
            "prompt_cache_key_enabled": lambda: False, "upstream_timeouts": lambda: (3, 3),
            "encode_upstream_body": lambda body: json.dumps(body).encode("utf-8"),
            "wb_identity": types.SimpleNamespace(PRODUCT_VSCODE="fixture-vscode", new_turn_request_id=lambda: "fixture-turn",
                                                  new_message_id=lambda: "fixture-message", conversation_id_for=lambda *args: "fixture-conversation"),
            "wb_settings": types.SimpleNamespace(egress_backoff_enabled=lambda directory: False),
            "wb_accounts": types.SimpleNamespace(get_realm_config=lambda realm: {}, urlopen=transport),
            "urllib": urllib, "time": time,
        }
        exec(compile(ast.Module(body=[method], type_ignores=[]), "<fixture-open-upstream>", "exec"), namespace)
        payload = {"model": MODEL, "messages": [{"role": "user", "content": "fixture hello"}]}
        before_payload = copy.deepcopy(payload)
        with self.assertRaises(urllib.error.HTTPError) as caught:
            namespace["open_upstream"](payload, session_key="fixture-session", target_realm="cn",
                                        prebuilt_body=payload, allow_credit_fallback=False, allow_product_switch=False)
        self.assertIs(caught.exception, exc)
        self.assertEqual(caught.exception.account_uid, ACCOUNT)
        self.assertEqual(transport.call_count, 1)
        self.assertEqual(pool.pick_for_session.call_count, 1)
        self.assertEqual(payload, before_payload)
        self.assertEqual({key: getattr(account, key) for key in state}, state)
        for name in mutations:
            getattr(account, name).assert_not_called()
        pool.affinity.demote.assert_not_called()


if __name__ == "__main__":
    unittest.main()
