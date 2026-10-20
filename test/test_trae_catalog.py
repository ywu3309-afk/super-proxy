"""Offline D-drive fixtures; no client login, network, or C-drive writes."""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))
import wb_trae_catalog as catalog

UID = "fixture-user"
PRIMARY = UID + ":AI.agent.model.model_list_map"
FALLBACK = UID + "_AI.agent.model.model_list_map"


def model(mid="glm-5.3", **fields):
    return {"name": mid, "display_name": mid.upper(), "is_preset": True,
            "status": True, "selectable": True, "config_source": 1, **fields}


class CatalogTests(unittest.TestCase):
    def setUp(self):
        folder = ROOT / "analysis/trae-models-20261020/catalog-tests"
        folder.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="catalog-", dir=folder)
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / "state.vscdb"

    def write(self, values):
        with closing(sqlite3.connect(self.db)) as con, con:
            con.execute("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT)")
            for key, value in values.items():
                raw = value if isinstance(value, (str, bytes)) else json.dumps(value)
                con.execute("INSERT OR REPLACE INTO ItemTable VALUES (?,?)", (key, raw))

    def read(self, uid=UID):
        return catalog.read_local_model_catalog(uid, self.db)

    def test_primary_assistant_has_priority(self):
        self.write({PRIMARY: {"assistant": [model("new-model")]},
                    FALLBACK: {"chat_v3": [model("old-model")]}})
        value = self.read()
        self.assertEqual([m["upstreamId"] for m in value["models"]], ["new-model"])
        self.assertEqual(value["models"][0]["function"], "assistant")

    def test_empty_primary_falls_back_to_exact_legacy_uid(self):
        self.write({PRIMARY: {"assistant": []}, FALLBACK: {"chat_v3": [model()]}})
        value = self.read()
        self.assertEqual(value["models"][0]["function"], "chat_v3")

    def test_other_users_and_other_groups_never_selected(self):
        self.write({"other_AI.agent.model.model_list_map": {"chat_v3": [model()]},
                    PRIMARY: {"solo_agent": [model()]}})
        self.assertIsNone(self.read())

    def test_no_prefix_or_suffix_uid_matching(self):
        self.write({"prefix-" + FALLBACK: {"chat_v3": [model()]},
                    FALLBACK + ":suffix": {"chat_v3": [model()]}})
        self.assertIsNone(self.read())

    def test_exact_uid_even_with_case_insensitive_database_schema(self):
        with closing(sqlite3.connect(self.db)) as con, con:
            con.execute("CREATE TABLE ItemTable (key TEXT COLLATE NOCASE, value TEXT)")
            con.execute("INSERT INTO ItemTable VALUES (?,?)",
                        (FALLBACK.upper(), json.dumps({"chat_v3": [model()]})))
        self.assertIsNone(self.read())

    def test_duplicate_key_rows_fail_closed(self):
        with closing(sqlite3.connect(self.db)) as con, con:
            con.execute("CREATE TABLE ItemTable (key TEXT, value TEXT)")
            con.executemany("INSERT INTO ItemTable VALUES (?,?)",
                            [(FALLBACK, json.dumps({"chat_v3": [model()]}))] * 4)
        self.assertIsNone(self.read())

    def test_21_models_and_output_allowlist(self):
        models = [model("official-%02d" % n, custom_config='{"native_function_call":true}',
                        nested={"sk": "never-copy-this"}, ak=None, sk=None,
                        base_url=None, client_connect=None) for n in range(21)]
        self.write({FALLBACK: {"chat_v3": models}})
        value = self.read()
        self.assertEqual(len(value["models"]), 21)
        self.assertEqual(set(value), {"models", "source", "fetchedAt", "ageSeconds"})
        self.assertTrue(all(set(m) == {"upstreamId", "name", "function", "source"}
                            for m in value["models"]))
        self.assertNotIn("never-copy-this", json.dumps(value))

    def test_custom_connections_filtered(self):
        bad = [model("custom_test"), model("provider//model"), model("model", is_preset=False)]
        for field in catalog._CUSTOM_FIELDS:
            bad.append(model("bad-" + field, **{field: "secret-not-copied"}))
        bad += [model("client-connected", client_connect=True),
                model("custom-base", is_custom_base_url=True),
                model("config-two", config_source=2)]
        self.write({FALLBACK: {"chat_v3": bad + [model()]}})
        self.assertEqual([m["upstreamId"] for m in self.read()["models"]], ["glm-5.3"])

    def test_disabled_and_malformed_flags_filtered(self):
        bad = []
        for field in ("is_preset", "status", "selectable"):
            for flag in (False, 0, "false", [], {}):
                bad.append(model("bad", **{field: flag}))
        self.write({FALLBACK: {"chat_v3": bad + [model()]}})
        self.assertEqual(len(self.read()["models"]), 1)

    def test_missing_legacy_flags_and_display_fallback(self):
        self.write({FALLBACK: {"chat_v3": [{"name": "legacy-model"}]}})
        self.assertEqual(self.read()["models"][0]["name"], "legacy-model")

    def test_id_and_display_name_length_control_validation(self):
        bad = [model("a" * 161), model("bad/name"), model("bad\nname"),
               model("bad name"), model("bad?name"), model("bad", display_name="x" * 161),
               model("bad", display_name="zero\u200bwidth"),
               model("bad", display_name="line\nfeed"), model("bad", display_name=" padded "),
               model("bad", display_name=7)]
        self.write({FALLBACK: {"chat_v3": bad + [model("a" * 160, display_name="字" * 160)]}})
        self.assertEqual(len(self.read()["models"]), 1)

    def test_duplicate_ids_keep_first_valid_record(self):
        self.write({FALLBACK: {"chat_v3": [model(status=False), model(display_name="First"),
                                        model(display_name="Second")]}})
        self.assertEqual(self.read()["models"][0]["name"], "First")

    def test_invalid_uids_do_not_open_database(self):
        for uid in (None, 42, "", "other:scope", "../user", "bad\nuid", "x" * 161):
            with self.subTest(uid=uid), mock.patch.object(catalog.sqlite3, "connect") as connect:
                self.assertIsNone(self.read(uid))
                connect.assert_not_called()

    def test_malformed_json_does_not_fall_back(self):
        self.write({PRIMARY: "{bad-json", FALLBACK: {"chat_v3": [model()]}})
        self.assertIsNone(self.read())

    def test_malformed_json_shapes_and_utf8(self):
        for raw in ("[]", '{"chat_v3":{}}', '{"chat_v3":null}', b"\xff"):
            with self.subTest(raw=raw):
                self.write({FALLBACK: raw})
                self.assertIsNone(self.read())

    def test_single_value_limit_rejected_before_fetch(self):
        self.write({FALLBACK: " " * (catalog._VALUE_LIMIT + 1)})
        self.assertIsNone(self.read())

    def test_total_limit_is_checked_across_both_exact_keys(self):
        self.write({PRIMARY: {"assistant": [model()]}, FALLBACK: {"chat_v3": [model()]}})
        with mock.patch.object(catalog, "_TOTAL_LIMIT", 10):
            self.assertIsNone(self.read())

    def test_missing_file_does_not_create_file_or_parent(self):
        missing = self.db.parent / "missing" / "state.vscdb"
        self.assertIsNone(catalog.read_local_model_catalog(UID, missing))
        self.assertFalse(missing.parent.exists())

    def test_database_without_table_and_non_database_return_none(self):
        self.db.write_bytes(b"not sqlite")
        self.assertIsNone(self.read())
        self.db.unlink()
        with closing(sqlite3.connect(self.db)):
            pass
        self.assertIsNone(self.read())

    def test_locked_database_returns_none_without_logging(self):
        self.write({FALLBACK: {"chat_v3": [model()]}})
        lock = sqlite3.connect(self.db)
        try:
            lock.execute("BEGIN EXCLUSIVE")
            with mock.patch("builtins.print") as printing:
                self.assertIsNone(self.read())
                printing.assert_not_called()
        finally:
            lock.close()

    def test_default_appdata_path_and_no_discovery(self):
        appdata = self.db.parent / "appdata"
        target = appdata / "Trae CN/User/globalStorage/state.vscdb"
        target.parent.mkdir(parents=True)
        self.write({FALLBACK: {"chat_v3": [model()]}})
        self.db.replace(target)
        with mock.patch.dict(os.environ, {"APPDATA": str(appdata)}):
            self.assertEqual(len(catalog.read_local_model_catalog(UID)["models"]), 1)
        with mock.patch.dict(os.environ, {"APPDATA": ""}):
            self.assertIsNone(catalog.read_local_model_catalog(UID))

    def test_mtime_age_not_network_freshness_or_ttl(self):
        self.write({FALLBACK: {"chat_v3": [model()]}})
        stamp = time.time() - 86400 * 100
        os.utime(self.db, (stamp, stamp))
        value = self.read()
        self.assertAlmostEqual(value["fetchedAt"], stamp, places=3)
        self.assertGreaterEqual(value["ageSeconds"], 86400 * 100 - 1)
        self.assertNotIn("fresh", value)
        os.utime(self.db, (time.time() + 3600, time.time() + 3600))
        self.assertEqual(self.read()["ageSeconds"], 0)

    def test_read_only_uri_and_unchanged_fixture_and_no_sidecars(self):
        self.write({FALLBACK: {"chat_v3": [model()]}})
        digest = hashlib.sha256(self.db.read_bytes()).hexdigest()
        stamp = self.db.stat().st_mtime_ns
        original_connect = sqlite3.connect
        with mock.patch.object(catalog.sqlite3, "connect", wraps=original_connect) as connect:
            self.assertIsNotNone(self.read())
            args, kwargs = connect.call_args
            self.assertTrue(args[0].startswith(self.db.as_uri()))
            self.assertTrue(args[0].endswith("?mode=ro"))
            self.assertTrue(kwargs["uri"])
        self.assertEqual(hashlib.sha256(self.db.read_bytes()).hexdigest(), digest)
        self.assertEqual(self.db.stat().st_mtime_ns, stamp)
        self.assertEqual(list(self.db.parent.iterdir()), [self.db])
        self.assertEqual(self.db.drive.upper(), "D:")

    def test_wal_fail_closed_does_not_open_or_generate_shm(self):
        self.write({FALLBACK: {"chat_v3": [model()]}})
        wal = Path(str(self.db) + "-wal")
        wal.write_bytes(b"pending WAL")
        with mock.patch.object(catalog.sqlite3, "connect") as connect:
            self.assertIsNone(self.read())
            connect.assert_not_called()
        self.assertFalse(Path(str(self.db) + "-shm").exists())


if __name__ == "__main__":
    unittest.main()
