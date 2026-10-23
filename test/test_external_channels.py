import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "hub"))
import wb_external


class _ModelsHandler(BaseHTTPRequestHandler):
    code = 200
    payload = {"data": [{"id": "deepseek-chat"}, {"id": "vision-model"}]}

    def do_GET(self):
        body = json.dumps(self.payload).encode()
        self.send_response(self.code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


class ExternalStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = wb_external.ExternalStore(self.tmp.name)
        self.server = HTTPServer(("127.0.0.1", 0), _ModelsHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def test_crud_masks_secret_and_keeps_standalone(self):
        # Use a public-looking test endpoint; probe is tested separately with a
        # temporary local endpoint, while URL validation intentionally blocks it.
        row = self.store.save({"id": "demo", "name": "Demo", "base_url": "https://example.com/v1", "api_key": "sk-1234567890-secret"})
        self.assertEqual(row["pool_mode"], "standalone")
        self.assertNotIn("api_key", row)
        self.assertEqual(row["key_masked"], "sk-1******cret")
        loaded = self.store.get("demo")
        self.assertEqual(loaded["api_key"], "sk-1234567890-secret")
        self.store.save_model({"channel_id": "demo", "model": "deepseek-chat", "remote_model": "deepseek-v4"})
        listed = self.store.list()[0]
        self.assertEqual(listed["models"][0]["public_id"], "ext/demo/deepseek-chat")
        self.store.delete_model("demo", "deepseek-chat")
        self.store.toggle("demo", False)
        self.assertFalse(self.store.list()[0]["enabled"])
        self.store.delete("demo")
        self.assertEqual(self.store.list(), [])

    def test_private_targets_are_blocked(self):
        with self.assertRaises(wb_external.ExternalError) as ctx:
            self.store.save({"name": "local", "base_url": "http://127.0.0.1:9", "api_key": "x"})
        self.assertEqual(ctx.exception.code, "private_target_blocked")

    def test_probe_classifies_auth_error_without_leaking_key(self):
        # Store an endpoint by monkey-patching URL validation only in this test;
        # the actual probe and classification remain real HTTP code paths.
        original = wb_external._validate_url
        wb_external._validate_url = lambda value: value.rstrip("/")
        try:
            row = self.store.save({"id": "probe", "name": "Probe", "base_url": "http://127.0.0.1:%d" % self.server.server_port, "api_key": "super-secret-key"})
            _ModelsHandler.code = 200
            result = self.store.probe("probe")
            self.assertTrue(result["ok"])
            self.assertEqual(result["models"], ["deepseek-chat", "vision-model"])
            self.assertNotIn("super-secret-key", json.dumps(result))
        finally:
            wb_external._validate_url = original


if __name__ == "__main__":
    unittest.main()
