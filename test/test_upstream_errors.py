"""Fixture-only classification; no gateway startup, credentials or network."""
import io
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "hub"))
from wb_upstream_errors import (MAX_ERROR_DETAIL, classify_workbuddy_error,
                                read_http_error_detail)


class WorkBuddyErrorTests(unittest.TestCase):
    def classify(self, payload, status=400, model=None):
        return classify_workbuddy_error(status, json.dumps(payload), model)

    def test_only_explicit_integer_and_string_codes_match(self):
        for code in (11128, "11128", "11-128"):
            with self.subTest(code=code):
                result = self.classify({"code": code})
                self.assertEqual(result["type"], "invalid_request_error")
                self.assertEqual(result["code"], "upstream_channel_rejected")
                self.assertEqual(result["provider"], "workbuddy")
                self.assertEqual(result["upstream_code"], 11128)
                self.assertIn("不等于余额不足", result["message"])
                self.assertIn("不一定成功", result["message"])
                self.assertIn("官方 WorkBuddy 客户端", result["message"])

    def test_does_not_infer_from_text_other_codes_or_nested_fields(self):
        for payload in ({}, {"code": 400, "msg": "11128 unapproved channel"},
                        {"error": {"code": 11128}}, {"metadata": {"code": 11128}},
                        {"code": 11128.0}, {"code": " 11128"}, {"code": "11128 "},
                        {"code": "11128-other"}, {"code": True}, {"code": False},
                        {"code": None}, {"code": [11128]}, {"code": {"code": 11128}},
                        [11128], [ {"code": 11128} ], None, 11128, "11128"):
            with self.subTest(payload=payload):
                self.assertIsNone(self.classify(payload))

    def test_non_400_and_non_integer_status_do_not_match(self):
        for status in (200, 401, 403, 429, 500, None, "400", 400.0, True):
            with self.subTest(status=status):
                self.assertIsNone(self.classify({"code": 11128}, status))

    def test_bad_or_truncated_json_is_not_inferred(self):
        for detail in ("", "upstream 400: {\"code\":11128}", "{\"code\":11128,", "11128",
                       "{\"code\":11128} trailing", b'{"code":11128}', None, {}):
            with self.subTest(detail=detail):
                self.assertIsNone(classify_workbuddy_error(400, detail))

    def test_parser_character_cap_is_inclusive(self):
        detail = '{"code":11128}'
        self.assertIsNotNone(classify_workbuddy_error(400, detail.ljust(MAX_ERROR_DETAIL)))
        self.assertIsNone(classify_workbuddy_error(400, detail.ljust(MAX_ERROR_DETAIL + 1)))
        self.assertIsNone(classify_workbuddy_error(400, '{"code":11128,"padding":"' + "中" * MAX_ERROR_DETAIL + '"}'))

    def test_excessive_json_nesting_is_not_a_secondary_error(self):
        detail = '[' * 1200 + '{"code":11128}' + ']' * 1200
        self.assertIsNone(classify_workbuddy_error(400, detail))

    def test_only_validated_request_ids_are_exposed(self):
        for request_id in ("01a15d9720187546abf208abcea1b17b", "01A15D9720187546ABF208ABCEA1B17B",
                           "01a15d97-2018-7546-abf2-08abcea1b17b"):
            with self.subTest(request_id=request_id):
                result = self.classify({"code": 11128, "requestId": request_id})
                self.assertEqual(result["upstream_request_id"], request_id)
        for request_id in ("fixture-id", "", "a" * 129, "a" * 31, "a" * 33,
                           "a" * 32 + "\n", '<script>alert(1)</script>',
                           "secret=fixture-password", {"secret": "fixture"}, ["a" * 32], None, 123):
            with self.subTest(request_id=request_id):
                self.assertNotIn("upstream_request_id", self.classify({"code": 11128, "requestId": request_id}))

    def test_model_is_only_taken_from_validated_caller_argument(self):
        for model in ("deepseek-v4.1-flash", "DeepSeek-V4-Pro", "a" * 128):
            with self.subTest(model=model):
                self.assertEqual(self.classify({"code": 11128}, model=model)["model"], model)
        for model in ("", "a" * 129, " model", "model\n", "model\r\nAuthorization:secret",
                      '<script>', "模型", {"secret": "fixture"}, ["model"], None, 5):
            with self.subTest(model=model):
                self.assertNotIn("model", self.classify({"code": 11128}, model=model))
        self.assertNotIn("model", self.classify({"code": 11128, "model": "untrusted-upstream-model"}))

    def test_arbitrary_fields_and_original_json_are_not_echoed(self):
        secret = "fixture-do-not-echo-password"
        result = self.classify({"code": 11128, "msg": secret, "message": secret,
                                "secret": secret, "token": secret, "headers": {"Authorization": secret},
                                "displayTips": {"en": secret}, "error": {"secret": secret}})
        self.assertEqual(set(result), {"message", "type", "code", "provider", "upstream_code"})
        self.assertNotIn(secret, json.dumps(result))

    def test_bounded_reader_never_requests_all_bytes(self):
        class Reader:
            def __init__(self):
                self.calls = []
            def read(self, size):
                self.calls.append(size)
                return b"a" * (MAX_ERROR_DETAIL + 100)
        reader = Reader()
        self.assertEqual(len(read_http_error_detail(reader)), MAX_ERROR_DETAIL)
        self.assertEqual(reader.calls, [MAX_ERROR_DETAIL])

    def test_reader_respects_custom_cap_and_utf8_replacement(self):
        reader = io.BytesIO("中".encode("utf-8"))
        self.assertEqual(read_http_error_detail(reader, 2), "\ufffd")
        self.assertEqual(reader.read(), b"\xad")

    def test_reader_rejects_invalid_caps_before_reading(self):
        class Reader:
            def read(self, size):
                self.fail = True
                raise AssertionError("must not read")
        for limit in (0, -1, MAX_ERROR_DETAIL + 1, None, True, 1.5, "8192"):
            with self.subTest(limit=limit), self.assertRaises(ValueError):
                read_http_error_detail(Reader(), limit)

    def test_reader_does_not_hide_io_errors_or_nonbyte_responses(self):
        class FailedReader:
            def read(self, size):
                raise OSError("fixture")
        with self.assertRaises(OSError):
            read_http_error_detail(FailedReader())
        class WrongReader:
            def read(self, size):
                return "not bytes"
        with self.assertRaises(TypeError):
            read_http_error_detail(WrongReader())


if __name__ == "__main__":
    unittest.main()
