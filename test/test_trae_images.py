"""Offline inline-image and structured-text tool contracts; no image upload."""
import base64
import copy
import json
from pathlib import Path
import struct
import sys
import unittest
from unittest import mock
import zlib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))
sys.path.insert(0, str(ROOT))
import wb_trae_images as images
import wb_trae_tools as tools
import wb_trae_native as native
import wb_trae as trae
from test import test_trae_native as fixtures
from test.test_trae_deepseek_frames import frames_for_nonce


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def png(width=2, height=3):
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"\0" + b"\0" * 6)) + chunk(b"IEND", b""))


def part(raw=None, media_type="image/png", **extra):
    return {"type": "image_url", "image_url": {
        "url": "data:" + media_type + ";base64," + base64.b64encode(png() if raw is None else raw).decode("ascii"), **extra}}


def request(messages=None, **changes):
    return {"model": images.VISION_MODEL, "messages": messages or [{"role": "user", "content": [
        {"type": "text", "text": "Describe the image"}, part()]}], **changes}


class InlineImageTests(unittest.TestCase):
    def assert_bad(self, action, code="invalid_messages", status=422):
        with self.assertRaises(images.ImageInputError) as raised:
            action()
        self.assertEqual((raised.exception.code, raised.exception.status), (code, status))

    def test_png_contract_and_input_not_mutated(self):
        messages = request()["messages"]
        before = copy.deepcopy(messages)
        history, attachments = images.split_messages(messages, images.VISION_MODEL)
        self.assertEqual(messages, before)
        self.assertEqual(history[0]["content"][-1], {"type": "image_ref", "image_id": "image_1"})
        self.assertEqual(attachments, [{"id": "image_1", "mediaType": "image/png", "data":
            base64.b64encode(png()).decode("ascii"), "width": 2, "height": 3}])
        self.assertNotIn(attachments[0]["data"], json.dumps(history))

    def test_jpeg_header_dimensions(self):
        raw = b"\xff\xd8\xff\xc0\0\x0b\x08\0\x06\0\x07\x01\x01\x11\0\xff\xd9"
        item, _ = images.image(part(raw, "image/jpeg"), "image_1")
        self.assertEqual((item["width"], item["height"]), (7, 6))

    def test_webp_vp8x_vp8l_vp8_headers(self):
        contents = [
            b"VP8X" + struct.pack("<I", 10) + b"\0" * 4 + b"\x06\0\0\x05\0\0",
            b"VP8L" + struct.pack("<I", 5) + b"\x2f" + struct.pack("<I", 6 | (5 << 14)) + b"\0",
            b"VP8 " + struct.pack("<I", 10) + b"\0" * 3 + b"\x9d\x01\x2a\x07\0\x06\0"]
        for content in contents:
            raw = b"RIFF" + struct.pack("<I", len(content) + 4) + b"WEBP" + content
            item, _ = images.image(part(raw, "image/webp"), "image_1")
            self.assertEqual((item["width"], item["height"]), (7, 6))

    def test_remote_urls_file_urls_and_noncanonical_data_rejected(self):
        for url in ("https://fixture.invalid/a.png", "file:///D:/a.png", "data:image/png;base64,", "data:image/gif;base64,AAAA",
                    "data:image/png;base64, YQ==", "data:image/png;base64,YQ=", "data:image/png;base64,YR=="):
            self.assert_bad(lambda: images.image({"type": "image_url", "image_url": {"url": url}}, "image_1"))

    def test_wrong_mime_truncated_headers_and_unreasonable_dimensions_rejected(self):
        for value in (part(png(), "image/jpeg"), part(png()[:24]), part(png(width=0)),
                      part(png(width=16385)), part(png(width=8000, height=5001)), part(b"RIFF", "image/webp")):
            self.assert_bad(lambda: images.image(value, "image_1"))

    def test_detail_and_part_shapes_are_strict(self):
        for value in (part(detail="huge"), part(secret="x"), {**part(), "other": True},
                      {"type": "image_url", "image_url": "data:image/png;base64,AAAA"}):
            self.assert_bad(lambda: images.image(value, "image_1"))
        for detail in ("auto", "low", "high"):
            self.assertEqual(images.image(part(detail=detail), "image_1")[0]["width"], 2)

    def test_only_exact_model_and_user_role(self):
        for model in ("trae/DeepSeek-V4-Flash-Official", "trae/deepseek-v4.1-flash-extra", "deepseek-v4.1-flash"):
            self.assert_bad(lambda: images.split_messages(request()["messages"], model), "unsupported_feature")
        for role in ("system", "developer", "assistant", "tool"):
            self.assert_bad(lambda: images.split_messages([{"role": role, "content": [part()]}], images.VISION_MODEL))

    def test_historical_images_order_and_forged_refs(self):
        messages = [{"role": "user", "content": [part(), {"type": "text", "text": "first"}]},
                    {"role": "assistant", "content": "answer"},
                    {"role": "user", "content": [{"type": "text", "text": "second"}, part()]}]
        history, attachments = images.split_messages(messages, images.VISION_MODEL)
        self.assertEqual([x["id"] for x in attachments], ["image_1", "image_2"])
        self.assertEqual(history[0]["content"][0]["image_id"], "image_1")
        self.assertEqual(history[2]["content"][1]["image_id"], "image_2")
        self.assert_bad(lambda: images.split_messages([{"role": "user", "content": [
            {"type": "image_ref", "image_id": "image_1"}]}], images.VISION_MODEL))

    def test_image_count_single_and_aggregate_budgets(self):
        self.assert_bad(lambda: images.split_messages([{"role": "user", "content": [part()] * 5}], images.VISION_MODEL),
                        "request_too_large", 413)
        with mock.patch.object(images, "MAX_IMAGE_BYTES", 20):
            self.assert_bad(lambda: images.image(part(), "image_1"), "request_too_large", 413)
        with mock.patch.object(images, "MAX_TOTAL_BYTES", len(png())):
            self.assert_bad(lambda: images.split_messages([{"role": "user", "content": [part(), part()]}], images.VISION_MODEL),
                            "request_too_large", 413)


class ImageToolBridgeTests(unittest.TestCase):
    def test_frame_and_private_images_preserve_history_without_base64(self):
        payload = request(messages=[{"role": "user", "content": [part()]}, {"role": "assistant", "content": "first answer"},
                                   {"role": "user", "content": [part(), {"type": "text", "text": "compare"}]}])
        before = copy.deepcopy(payload)
        plan = tools.prepare(payload)
        self.assertEqual(payload, before)
        self.assertEqual(plan.protocol, "framed_json_v2")
        self.assertEqual(len(plan.images), 2)
        text = "".join(x["text"] for m in plan.messages for x in m["content"])
        self.assertIn("image_1", text)
        self.assertIn("image_2", text)
        self.assertNotIn(plan.images[0]["data"], text)
        self.assertEqual(plan.parse(frames_for_nonce(plan.nonce, "seen"))["content"], "seen")

    def test_strict_frame_checks_unchanged_with_images(self):
        plan = tools.prepare(request())
        for text in ("looks fine", frames_for_nonce(plan.nonce, "fine").replace("WB_END " + plan.nonce, "WB_END wrong")):
            with self.assertRaises(tools.ToolBridgeError):
                plan.parse(text)

    def test_images_survive_tool_result_roundtrip(self):
        payload = request(messages=[{"role": "user", "content": [part()]},
            {"role": "assistant", "content": None, "tool_calls": [{"id": "call_1", "type": "function",
              "function": {"name": "read", "arguments": '{"path":"D:/fixture"}'}}]},
            {"role": "tool", "tool_call_id": "call_1", "content": "read result"}])
        plan = tools.prepare(payload)
        self.assertEqual(len(plan.images), 1)
        self.assertIn("read result", plan.messages[1]["content"][0]["text"])

    def test_images_do_not_consume_utf16_prompt_budget(self):
        raw = png()[:-12] + b"x" * (96 * 1024) + png()[-12:]
        plan = tools.prepare(request(messages=[{"role": "user", "content": [part(raw)]}]))
        self.assertGreater(len(plan.images[0]["data"]), 65536)
        self.assertLess(len(plan.messages[1]["content"][0]["text"]), 1000)

    def test_image_larger_than_old_two_mib_envelope_is_not_text(self):
        raw = png()[:-12] + b"x" * (1600 * 1024) + png()[-12:]
        payload = request(messages=[{"role": "user", "content": [part(raw)]}])
        self.assertGreater(len(json.dumps(payload)), tools.MAX_REQUEST_BYTES)
        plan = tools.prepare(payload)
        self.assertEqual(len(plan.images), 1)
        self.assertLess(len(json.dumps(plan.messages)), 8192)

    def test_text_and_image_request_budgets_are_independent(self):
        with mock.patch.object(tools, "MAX_IMAGE_REQUEST_BYTES", 20):
            with self.assertRaises(tools.ToolBridgeError) as raised:
                tools.prepare(request())
            self.assertEqual(raised.exception.status, 413)
        with mock.patch.object(tools, "MAX_REQUEST_BYTES", 20):
            with self.assertRaises(tools.ToolBridgeError) as raised:
                tools.prepare(request())
            self.assertEqual(raised.exception.status, 413)

    def test_text_only_plan_has_independent_empty_images(self):
        first = tools.prepare(request(messages=[{"role": "user", "content": "hello"}]))
        second = tools.prepare(request(messages=[{"role": "user", "content": "hello"}]))
        self.assertEqual(first.images, [])
        self.assertIsNot(first.images, second.images)


class ImageNativeTests(unittest.TestCase):
    def test_native_payload_keeps_image_bytes_outside_prompt(self):
        http = fixtures.FakeHTTP()
        http.add(fixtures.chat_value(model="deepseek-v4.1-flash"))
        client = native.NativeTraeClient(fixtures.BRIDGE_URL, fixtures.BRIDGE_TOKEN, opener=http)
        plan = tools.prepare(request())
        client.chat(fixtures.UID, "deepseek-v4.1-flash", plan.messages, max_chars=256, images=plan.images)
        body = json.loads(http.requests[0][0].data)
        self.assertEqual(body["images"], plan.images)
        self.assertNotIn(plan.images[0]["data"], body["prompt"])

    def test_request_accepts_image_over_one_mib_but_response_limit_is_unchanged(self):
        http = fixtures.FakeHTTP()
        http.add(fixtures.chat_value(model="deepseek-v4.1-flash"))
        client = native.NativeTraeClient(fixtures.BRIDGE_URL, fixtures.BRIDGE_TOKEN, opener=http)
        raw = png()[:-12] + b"x" * (1024 * 1024) + png()[-12:]
        plan = tools.prepare(request(messages=[{"role": "user", "content": [part(raw)]}]))
        client.chat(fixtures.UID, "deepseek-v4.1-flash", plan.messages, max_chars=256, images=plan.images)
        self.assertGreater(len(http.requests[0][0].data), 1024 * 1024)
        self.assertEqual(native._LIMIT, 1024 * 1024)
        self.assertEqual(native._REQUEST_LIMIT, 16 * 1024 * 1024)

    def test_catalog_strict_boolean_and_exact_model_filter(self):
        http = fixtures.FakeHTTP()
        source = fixtures.catalog_value("deepseek-v4.1-flash", "DeepSeek-V4-Flash-Official", fixtures.MID)
        for item in source["models"]:
            item["supports_vision"] = True
        http.add(source)
        client = native.NativeTraeClient(fixtures.BRIDGE_URL, fixtures.BRIDGE_TOKEN, opener=http)
        self.assertEqual([x["supports_vision"] for x in client.catalog(fixtures.UID)["models"]], [True, False, False])
        for value in ("true", 1, None, False):
            source = fixtures.catalog_value("deepseek-v4.1-flash")
            source["models"][0]["supports_vision"] = value
            http.add(source)
            self.assertIs(client.catalog(fixtures.UID)["models"][0]["supports_vision"], False)

    def test_image_errors_sanitized_and_mapped(self):
        for code, expected in (("IMAGE_NOT_SUPPORTED", (422, "image_not_supported")),
                               ("IMAGE_UPLOAD_FAILED", (502, "image_upload_failed"))):
            error = native._failure(code)
            self.assertEqual((error.status, error.code), expected)


class ImageProviderTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.NativeProviderTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.native.catalogs[fixtures.UID] = {"source": "native_client", "models": [
            {"upstreamId": "deepseek-v4.1-flash", "name": "DS vision", "route": "native_client",
             "source": "native_client", "supports_vision": True}]}
        self.fixture.ready()
        self.provider = self.fixture.provider

    def test_provider_passes_images_privately_and_parses_frame(self):
        def answer(uid, model, messages, *, max_chars, images):
            self.assertEqual(model, "deepseek-v4.1-flash")
            self.assertEqual(len(images), 1)
            self.assertNotIn(images[0]["data"], json.dumps(messages))
            nonce = messages[0]["content"][0]["text"].split("WB_TOOL_BRIDGE_V2 ", 1)[1].split("\n", 1)[0]
            return fixtures.chat_value(model=model, response=frames_for_nonce(nonce, "image verified"))
        with mock.patch.object(self.fixture.native, "chat", side_effect=answer) as call:
            result = self.provider.chat(request())
        self.assertEqual(call.call_count, 1)
        self.assertEqual(result["choices"][0]["message"]["content"], "image verified")
        self.assertEqual(result["provider_metadata"]["response_format"], "framed_json_v2")

    def test_no_tools_vision_request_keeps_images_private_in_framed_plan(self):
        payload = request(messages=[{"role": "user", "content": [
            {"type": "text", "text": "Describe this image"}, part()]}])
        model, body = self.provider._payload(payload)
        self.assertEqual(model, images.VISION_MODEL)
        self.assertIn("_tool_plan", body)
        self.assertEqual(len(body["_images"]), 1)
        self.assertNotIn(body["_images"][0]["data"], json.dumps(body["messages"]))
        self.assertNotIn(body["_images"][0]["data"], json.dumps(body["_tool_plan"].messages))

    def test_no_tools_vision_request_accepts_image_payload_above_old_two_mib_limit(self):
        raw = png()[:-12] + b"x" * (1600 * 1024) + png()[-12:]
        payload = request(messages=[{"role": "user", "content": [part(raw)]}])
        _model, body = self.provider._payload(payload)
        self.assertGreater(len(body["_images"][0]["data"]), 2 * 1024 * 1024)
        self.assertIn("_tool_plan", body)

    def test_legacy_route_rejects_before_native_or_http(self):
        row = self.provider._records()[0]
        row["models"][0]["route"] = "legacy_http"
        self.provider._save(row)
        before = len(self.fixture.http.requests)
        with self.assertRaises(trae.TraeError) as raised:
            self.provider.chat(request())
        self.assertEqual(raised.exception.code, "image_not_supported")
        self.assertEqual(len(self.fixture.http.requests), before)
        self.assertEqual(self.fixture.native.chat_calls, [])

    def test_model_listing_requires_exact_live_native_boolean(self):
        self.assertEqual(self.provider.models()[0]["input"], ["text", "image"])
        for change in ({"supports_vision": "true"}, {"source": "local_client_cache"}, {"route": "legacy_http"}):
            row = self.provider._records()[0]
            row["models"][0].update(change)
            self.provider._save(row)
            self.assertEqual(self.provider.models()[0]["input"], ["text"])
        row = self.provider._records()[0]
        row["models"][0].update(source="native_client", route="native_client", supports_vision=True)
        row["nativeConnected"] = False
        self.provider._save(row)
        self.assertEqual(self.provider.models()[0]["input"], ["text"])


if __name__ == "__main__":
    unittest.main()
