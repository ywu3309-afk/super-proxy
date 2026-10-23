"""Offline browser-login contract tests for the TRAE provider."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))

import wb_trae
import wb_trae_oauth


def protect(value, decrypt=False):
    return bytes(byte ^ 0x5A for byte in value)


class OAuthLoginTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="trae-oauth-", dir=ROOT / "analysis")
        self.provider = wb_trae.TraeProvider(
            self.temp.name,
            protector=protect,
            native_client=type("Native", (), {"configured": False})(),
            catalog_reader=lambda _uid: None,
        )
        self.device = {
            "deviceId": "123456789012345",
            "machineId": "machine",
            "publicKeyPEM": "",
            "privateKeyPEM": "",
            "appVersion": "3.3.102",
        }
        self.started = {
            "authUrl": "https://www.trae.cn/authorization?fixture=1",
            "state": "trace-fixture",
            "verifier": "verifier-fixture",
            **self.device,
        }

    def tearDown(self):
        self.temp.cleanup()

    def test_start_poll_and_cancel_without_desktop_client(self):
        with mock.patch.object(wb_trae_oauth, "oauth_device", return_value=self.device) as device, \
             mock.patch.object(wb_trae_oauth, "oauth_login_url", return_value=self.started):
            started = self.provider.start_oauth_login(
                "http://127.0.0.1:8787/authorize", "cn")
        device.assert_called_once_with("cn", prefer_local=False)
        self.assertEqual(started["provider"], "trae")
        self.assertEqual(started["redirectUri"], "http://127.0.0.1:8787/authorize")
        self.assertEqual(self.provider.poll_oauth_login("trace-fixture")["status"], "pending")
        self.assertTrue(self.provider.cancel_oauth_login("trace-fixture"))

    def test_browser_device_generation_skips_native_storage(self):
        with mock.patch.object(wb_trae_oauth, "local_device_credentials",
                               side_effect=AssertionError("native scan must not run")), \
             mock.patch.object(wb_trae_oauth, "_credential_storage", return_value={}):
            device = wb_trae_oauth.oauth_device("cn", prefer_local=False)
        self.assertTrue(device["deviceId"])
        self.assertTrue(device["machineId"])
        self.assertEqual(device["publicKeyPEM"], "")
        self.assertEqual(device["privateKeyPEM"], "")

    def test_callback_exchanges_code_and_redacted_account_enters_pool(self):
        with mock.patch.object(wb_trae_oauth, "oauth_device", return_value=self.device), \
             mock.patch.object(wb_trae_oauth, "oauth_login_url", return_value=self.started):
            self.provider.start_oauth_login(
                "http://127.0.0.1:8787/authorize", "cn")
        token = "a" * 40 + "." + "b" * 20 + "." + "c" * 20
        with mock.patch.object(wb_trae_oauth, "exchange_auth_code", return_value={
            "accessToken": token,
            "refreshToken": "r" * 40,
            "expiresAt": 1899999999,
        }) as exchange:
            result = self.provider.complete_oauth_login({
                "loginTraceID": "trace-fixture",
                "authCodeInfo": json.dumps({
                    "AuthCode": "fixture-code",
                    "Host": "api.trae.com.cn",
                }),
                "userInfo": json.dumps({"UserID": "uid-1", "ScreenName": "TRAE fixture"}),
            })
        self.assertTrue(result["ok"])
        exchange.assert_called_once()
        status = self.provider.status()
        self.assertEqual(len(status["accounts"]), 1)
        self.assertEqual(status["accounts"][0]["label"], "TRAE fixture")
        stored = next((self.provider.root).glob("*.json")).read_text(encoding="utf-8")
        self.assertNotIn(token, stored)
        self.assertNotIn("fixture-code", stored)
        self.assertNotIn("refreshToken", json.dumps(status))

    def test_non_cn_oauth_is_rejected_without_network(self):
        with self.assertRaises(wb_trae.TraeError) as raised:
            self.provider.start_oauth_login("http://127.0.0.1:8787/authorize", "intl")
        self.assertEqual(raised.exception.code, "unsupported_region")


if __name__ == "__main__":
    unittest.main()
