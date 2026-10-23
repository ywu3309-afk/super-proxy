"""Regression tests for the live TRAE catalog adapter."""

import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))

import wb_trae
import wb_trae_remote as remote


TOKEN = "remote-catalog-fixture-token-0123456789"


def protect(value, decrypt=False):
    return bytes(byte ^ 0xA5 for byte in value)


class Response(io.BytesIO):
    def __init__(self, value, status=200, url=None):
        super().__init__(value if isinstance(value, bytes) else json.dumps(value).encode())
        self.status = status
        self.url = url
        self.headers = {"Content-Type": "application/json"}

    def getcode(self):
        return self.status

    def geturl(self):
        return self.url


class SseResponse(Response):
    def __init__(self, text, status=200, url=None):
        super().__init__(text.encode("utf-8"), status=status, url=url)
        self.headers = {"Content-Type": "text/event-stream; charset=utf-8"}


class FakeHTTP:
    def __init__(self, values):
        self.values = list(values)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        value = self.values.pop(0)
        if isinstance(value, Response):
            if value.url is None:
                value.url = request.full_url
            return value
        if isinstance(value, Exception):
            raise value
        return Response(value, url=request.full_url)


def quota():
    return {"user_entitlement_pack_list": [
        {"entitlement_base_info": {"quota": {"credits_limit": 100}},
         "usage": {"credits_amount": 1}},
    ]}


def catalog(*entries):
    return {"data": {"config_info_list": list(entries)}}


def entry(name, display=None, rate=None, **extra):
    item = {"config_name": name, "display_config": {"display_name": display or name}, **extra}
    if rate is not None:
        item["display_contact_config"] = json.dumps({
            "consumption_rate": {"enable": True, "data": {"rate": rate}}
        })
    return item


class RemoteCatalogTests(unittest.TestCase):
    def test_build_code_override_and_request_shape(self):
        with mock.patch.dict(os.environ, {"TRAE_CATALOG_VERSION_CODE": "20990101"}, clear=False):
            self.assertEqual(remote.catalog_version_code(), "20990101")
        self.assertEqual(remote.request_body("chat_v3")["function"], "chat_v3")
        self.assertEqual(remote.request_body("solo_agent")["poly_prompt"], True)
        with self.assertRaises(ValueError):
            remote.request_body("unknown")

    def test_normalise_filters_internal_and_merges_rated_models(self):
        models = remote.normalise_payloads([
            catalog(
                entry("glm-5.3", "GLM-5.3"),
                entry("summary", "内部摘要"),
                entry("custom_model_x", "自定义"),
                entry("hidden", "隐藏", enable=False),
            ),
            catalog(entry("glm-5.3", "GLM-5.3", rate=0.06)),
        ])
        self.assertEqual([model["id"] for model in models], ["glm-5.3"])
        self.assertEqual(models[0]["credits"], "0.06")

    def test_nested_wrappers_and_text_capabilities_are_sanitized(self):
        models = remote.normalise_payloads([{
            "result": {"models": [entry(
                "deepseek-v4.1-flash", "DeepSeek V4.1 Flash",
                supports_vision=True, supports_tool_call=True,
                context_window_tokens={"prod": 200000},
            )]}
        }])
        self.assertEqual(models[0]["context"], 200000)
        self.assertEqual(models[0]["input"], ["text", "image"])
        gateway = remote.to_gateway_models(models)
        self.assertEqual(gateway[0]["route"], "remote_http")
        self.assertEqual(gateway[0]["source"], "remote_http")
        self.assertEqual(gateway[0]["upstreamModel"], "DeepSeek-V4-Flash")

    def test_provider_uses_dynamic_catalog_before_legacy_endpoint(self):
        temp = tempfile.TemporaryDirectory(prefix="trae-remote-catalog-", dir=ROOT / "analysis")
        self.addCleanup(temp.cleanup)
        http = FakeHTTP([
            quota(),
            catalog(entry("deepseek-v4.1-flash", "DeepSeek V4.1 Flash", rate=0.06)),
            catalog(entry("glm-5.3", "GLM-5.3", rate=0.06)),
            catalog(entry("deepseek-v4.1-flash", "DeepSeek V4.1 Flash", rate=0.06)),
        ])
        provider = wb_trae.TraeProvider(
            temp.name, opener=http, protector=protect,
            native_client=type("Native", (), {"configured": False})(),
            catalog_reader=lambda _uid: None, remote_catalog=True,
        )
        provider.import_account({"token": TOKEN, "account": {"uid": "remote-user"}})
        with mock.patch.dict(os.environ, {"TRAE_CATALOG_VERSION_CODE": "20990101"}, clear=False):
            status = provider.refresh(provider.status()["accounts"][0]["id"])
        account = status["accounts"][0]
        self.assertEqual(account["catalogSource"], "remote_http")
        self.assertEqual({item["id"] for item in status["models"]},
                         {"trae/deepseek-v4.1-flash", "trae/glm-5.3"})
        self.assertEqual(len(http.requests), 4)
        dynamic = http.requests[1][0]
        self.assertTrue(dynamic.full_url.endswith("/api/ide/v1/get_detail_param"))
        self.assertEqual(dynamic.get_header("User-agent"), "VSCode 1.107.1 (TRAE SOLO CN)")
        self.assertEqual(dynamic.get_header("X-ide-version-code"), "20990101")
        self.assertIsNone(dynamic.get_header("X-app-function"))
        self.assertEqual(json.loads(dynamic.data)["function"], "chat_v3")

    def test_provider_falls_back_to_legacy_when_dynamic_endpoint_is_unavailable(self):
        temp = tempfile.TemporaryDirectory(prefix="trae-remote-fallback-", dir=ROOT / "analysis")
        self.addCleanup(temp.cleanup)
        # 1 quota + 3 failed dynamic calls + 1 legacy GET.
        http = FakeHTTP([
            quota(),
            Response(b"{}", status=404),
            Response(b"{}", status=404),
            Response(b"{}", status=404),
            {"model_configs": [{"name": "legacy-model", "display_name": "Legacy",
                                 "is_preset": True, "status": True,
                                 "client_connect": False, "custom_config": ""}]},
        ])
        provider = wb_trae.TraeProvider(
            temp.name, opener=http, protector=protect,
            native_client=type("Native", (), {"configured": False})(),
            catalog_reader=lambda _uid: None, remote_catalog=True,
        )
        provider.import_account({"token": TOKEN, "account": {"uid": "legacy-user"}})
        status = provider.refresh(provider.status()["accounts"][0]["id"])
        self.assertEqual(status["accounts"][0]["catalogSource"], "legacy_http")
        self.assertEqual(status["models"][0]["id"], "trae/legacy-model")
        self.assertTrue(http.requests[-1][0].full_url.endswith("/api/ide/v1/model_list?type=chat"))

    def test_remote_deepseek_text_uses_plain_chat_messages_and_sse_usage(self):
        temp = tempfile.TemporaryDirectory(prefix="trae-remote-chat-", dir=ROOT / "analysis")
        self.addCleanup(temp.cleanup)
        sse = (
            "id:1\n"
            "event: metadata\n"
            "data: {\"model\":\"\"}\n\n"
            "event: timing_cost\n"
            "data: {\"server_processing_time\":1}\n\n"
            "event: output\n"
            "data: {\"content\":\"TRAE_REMOTE_OK\"}\n\n"
            "event: extra_info\n"
            "data: {\"model\":\"ep-fixture\"}\n\n"
            "event: token_usage\n"
            "data: {\"prompt_tokens\":4,\"completion_tokens\":2}\n\n"
            "event: done\n"
            "data: {\"finish_reason\":\"stop\"}\n\n"
        )
        http = FakeHTTP([
            quota(),
            catalog(entry("deepseek-v4.1-flash", "DeepSeek V4.1 Flash")),
            catalog(entry("deepseek-v4.1-flash", "DeepSeek V4.1 Flash")),
            catalog(entry("deepseek-v4.1-flash", "DeepSeek V4.1 Flash")),
            SseResponse(sse),
        ])
        provider = wb_trae.TraeProvider(
            temp.name, opener=http, protector=protect,
            native_client=type("Native", (), {"configured": False})(),
            catalog_reader=lambda _uid: None, remote_catalog=True,
        )
        provider.import_account({"token": TOKEN, "account": {"uid": "remote-chat-user"}})
        provider.refresh(provider.status()["accounts"][0]["id"])
        result = provider.chat({
            "model": "trae/deepseek-v4.1-flash",
            "messages": [{"role": "user", "content": "hello"}],
            "stream": False,
            "max_tokens": 32,
        })
        self.assertEqual(result["choices"][0]["message"]["content"], "TRAE_REMOTE_OK")
        self.assertEqual(result["usage"], {"prompt_tokens": 4, "completion_tokens": 2, "total_tokens": 6})
        chat_request = http.requests[-1][0]
        body = json.loads(chat_request.data)
        self.assertEqual(body["model"], "DeepSeek-V4-Flash")
        self.assertEqual(body["function"], "chat_v3")
        self.assertEqual(body["messages"][0]["content"][0]["text"], "hello")


if __name__ == "__main__":
    unittest.main()

