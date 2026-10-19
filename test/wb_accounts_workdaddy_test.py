import base64
import json
import os
import sys
import tempfile
import unittest
from unittest import mock


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "hub"))

import wb_accounts  # noqa: E402


def fake_jwt(uid="workdaddy-test", issuer="https://www.workbuddy.ai"):
    def encode(value):
        raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    return "%s.%s.sig" % (
        encode({"alg": "none", "typ": "JWT"}),
        encode({"sub": uid, "iss": issuer, "exp": 1999999999}),
    )


class WorkDaddyImportTests(unittest.TestCase):
    def setUp(self):
        token = fake_jwt()
        self.info = {
            "account": {"uid": "workdaddy-test", "nickname": "WorkDaddy test"},
            "auth": {
                "accessToken": token,
                "refreshToken": "refresh-test",
                "domain": "https://www.workbuddy.ai",
            },
        }

    def test_native_info_shape_imports(self):
        result = wb_accounts.normalise_import_row(self.info)
        self.assertEqual(result["uid"], "workdaddy-test")
        self.assertEqual(result["realm"], "intl")
        self.assertEqual(result["source"], "import")

    def test_workdaddy_export_row_unwraps_info(self):
        row = {"uid": "workdaddy-test", "info": json.dumps(self.info)}
        result = wb_accounts.normalise_import_row(row)
        self.assertEqual(result["uid"], "workdaddy-test")
        self.assertEqual(result["source"], "workdaddy")

    def test_workdaddy_uid_mismatch_is_rejected(self):
        row = {"uid": "another-user", "info": json.dumps(self.info)}
        with self.assertRaisesRegex(ValueError, "uid does not match"):
            wb_accounts.normalise_import_row(row)

    def test_workdaddy_outer_uid_must_match_token_when_profile_uid_missing(self):
        inner = json.loads(json.dumps(self.info))
        inner["account"].pop("uid")
        row = {"uid": "another-user", "info": json.dumps(inner)}
        with self.assertRaisesRegex(ValueError, "access token"):
            wb_accounts.normalise_import_row(row)

    def test_workdaddy_export_document_is_accepted(self):
        row = {"uid": "workdaddy-test", "info": json.dumps(self.info)}
        rows, error = wb_accounts._coerce_account_rows({
            "exportType": "WorkDaddy-accounts",
            "accounts": [row],
        })
        self.assertEqual(error, "")
        self.assertEqual(len(rows), 1)
        preview = wb_accounts.AccountPool(os.path.join(ROOT, "analysis", "_test-workdaddy-pool"))
        self.assertEqual(preview.preview_import_rows(rows)["added"], ["workdaddy-test"])

    def test_workdaddy_backup_scan_is_read_only_and_classifies_duplicates(self):
        with tempfile.TemporaryDirectory(prefix="workdaddy-scan-") as tmp:
            accounts_dir = os.path.join(tmp, "accounts")
            os.makedirs(accounts_dir)
            ready = {
                "account": {"uid": "ready-user", "nickname": "Ready"},
                "auth": {"accessToken": fake_jwt("ready-user"),
                         "domain": "https://www.workbuddy.ai"},
            }
            duplicate = {
                "account": {"uid": "duplicate-user", "nickname": "Duplicate"},
                "auth": {"accessToken": fake_jwt("duplicate-user"),
                         "domain": "https://www.workbuddy.ai"},
            }
            encrypted = {
                "account": {"uid": "encrypted-user", "nickname": "Encrypted"},
                "auth": {"accessToken": {"$wbEncrypted": 1, "envelope": "not-a-real-envelope"}},
            }
            with open(os.path.join(accounts_dir, "ready.info"), "w", encoding="utf-8") as fh:
                json.dump(ready, fh)
            with open(os.path.join(accounts_dir, "duplicate.info"), "w", encoding="utf-8") as fh:
                json.dump(duplicate, fh)
            with open(os.path.join(accounts_dir, "encrypted.info"), "w", encoding="utf-8") as fh:
                json.dump(encrypted, fh)
            with open(os.path.join(accounts_dir, "broken.info"), "w", encoding="utf-8") as fh:
                fh.write("not json")
            with open(os.path.join(accounts_dir, "ignored.json"), "w", encoding="utf-8") as fh:
                fh.write("{}");
            before = sorted(os.listdir(accounts_dir))

            with mock.patch.object(wb_accounts.wb_atrest, "cached_key", return_value=None):
                result = wb_accounts.scan_workdaddy_backups(
                    existing_uids={"duplicate-user"},
                    roots=[{"path": accounts_dir, "profile": "workbuddy-ai",
                            "realm": "intl", "label": "test WorkDaddy"}],
                )

            self.assertEqual(sorted(os.listdir(accounts_dir)), before)
            self.assertEqual(result["summary"]["found"], 4)
            self.assertEqual(result["summary"]["valid"], 2)
            self.assertEqual(result["summary"]["importable"], 1)
            self.assertEqual(result["summary"]["duplicates"], 1)
            self.assertEqual(result["summary"]["encrypted"], 1)
            self.assertEqual(result["summary"]["needsKey"], 1)
            self.assertEqual(result["summary"]["invalid"], 1)
            rows = {row["file"]: row for row in result["detected"]}
            self.assertTrue(rows["ready.info"]["importable"])
            self.assertTrue(rows["duplicate.info"]["duplicate"])
            self.assertFalse(rows["duplicate.info"]["importable"])
            self.assertTrue(rows["encrypted.info"]["encrypted"])
            self.assertTrue(rows["encrypted.info"]["needsKey"])
            self.assertNotIn("accessToken", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
