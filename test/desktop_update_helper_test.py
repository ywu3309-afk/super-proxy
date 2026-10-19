import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import unittest
from unittest.mock import patch, Mock
import zipfile

PROJECT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("apply_update", PROJECT / "desktop/apply_update.py")
updater = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(updater)


class PortableUpdateTests(unittest.TestCase):
    def fixture(self, extra=None, version="1.2.0"):
        analysis = PROJECT / "analysis"
        analysis.mkdir(exist_ok=True)
        self.root = Path(tempfile.mkdtemp(prefix="update-helper-test-", dir=analysis))
        self.install = self.root / "portable"
        (self.install / "data/accounts").mkdir(parents=True)
        (self.install / "electron-user-data").mkdir()
        (self.install / updater.EXE).write_bytes(b"old-program")
        (self.install / "data/accounts/fixture.json").write_bytes(b"fixture-account-state")
        (self.install / "data/.key").write_bytes(b"fixture-local-key")
        (self.install / "electron-user-data/preferences").write_bytes(b"fixture-preferences")
        self.jobdir = self.root / ".super-proxy-updates" / "v1.2.0-test"
        self.jobdir.mkdir(parents=True)
        archive = self.jobdir / "update.zip"
        files = {
            updater.EXE: b"new-program", "resources/app.asar": b"fixture-asar",
            "resources/hub/wb_proxy.py": b"# fixture", "resources/python/python.exe": b"fixture-python",
            "resources/desktop-release.json": json.dumps({"version": version, "repository": "ywu3309-afk/super-proxy"}).encode(),
        }
        with zipfile.ZipFile(archive, "w") as bundle:
            for name, content in files.items():
                bundle.writestr(updater.ROOT + "/" + name, content)
            for name, content in (extra or {}).items():
                # ZipInfo(name) 会在 Windows 把反斜杠规范化；显式保留恶意原名来测解析器。
                info = zipfile.ZipInfo("fixture")
                info.filename = name
                info.orig_filename = name
                bundle.writestr(info, content)
        job = {"schemaVersion": 1, "installDir": str(self.install), "jobDir": str(self.jobdir),
               "zipPath": str(archive), "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
               "version": "1.2.0", "repository": "ywu3309-afk/super-proxy", "root": updater.ROOT,
               "executable": updater.EXE, "appPid": 0, "gatewayPid": 0}
        self.job = self.jobdir / "job.json"
        self.job.write_text(json.dumps(job), encoding="utf-8")
        return job

    def assert_original(self):
        self.assertEqual((self.install / updater.EXE).read_bytes(), b"old-program")
        self.assertEqual((self.install / "data/accounts/fixture.json").read_bytes(), b"fixture-account-state")
        self.assertEqual((self.install / "data/.key").read_bytes(), b"fixture-local-key")
        self.assertEqual((self.install / "electron-user-data/preferences").read_bytes(), b"fixture-preferences")

    def test_applies_and_preserves_accounts_keys_preferences_and_old_program(self):
        self.fixture()
        result = updater.apply_job(self.job, launch=False)
        self.assertEqual((self.install / updater.EXE).read_bytes(), b"new-program")
        self.assertEqual((self.install / "data/accounts/fixture.json").read_bytes(), b"fixture-account-state")
        self.assertEqual((self.install / "data/.key").read_bytes(), b"fixture-local-key")
        self.assertEqual((self.install / "electron-user-data/preferences").read_bytes(), b"fixture-preferences")
        self.assertEqual((Path(result["backupDir"]) / updater.EXE).read_bytes(), b"old-program")
        self.assertEqual(json.loads((self.jobdir / "status.json").read_text())["state"], "succeeded")

    def test_preflight_does_not_extract_replace_or_stop_the_running_app(self):
        self.fixture()
        with patch.object(updater, "_wait_for_exit") as wait:
            updater.check_job(self.job)
            wait.assert_not_called()
        self.assert_original()
        self.assertFalse((self.jobdir / "unpacked").exists())
        self.assertEqual(json.loads((self.jobdir / "status.json").read_text())["state"], "ready")

    def test_bad_hash_leaves_original_untouched(self):
        job = self.fixture()
        job["sha256"] = "0" * 64
        self.job.write_text(json.dumps(job))
        with self.assertRaises(updater.UpdateError):
            updater.apply_job(self.job, launch=False)
        self.assert_original()

    def test_path_traversal_and_windows_aliases_are_rejected(self):
        for name in [updater.ROOT + "/../../escaped", updater.ROOT + "/resources/../escape",
                     "C:/escape", updater.ROOT + "\\escape", updater.ROOT + "/resources/stream:secret",
                     updater.ROOT + "/resources/name. "]:
            with self.subTest(name=name):
                self.fixture({name: b"unsafe"})
                with self.assertRaises(updater.UpdateError):
                    updater.apply_job(self.job, launch=False)
                self.assert_original()
                self.assertFalse((self.root / "escaped").exists())

    def test_runtime_data_must_never_come_from_a_release(self):
        self.fixture({updater.ROOT + "/data/accounts/unwanted.json": b"unsafe"})
        with self.assertRaises(updater.UpdateError):
            updater.apply_job(self.job, launch=False)
        self.assert_original()

    def test_case_aliased_paths_are_rejected(self):
        self.fixture({updater.ROOT + "/resources/APP.ASAR": b"unsafe"})
        with self.assertRaises(updater.UpdateError):
            updater.apply_job(self.job, launch=False)
        self.assert_original()

    def test_packaged_version_must_match_manifest(self):
        self.fixture(version="1.3.0")
        with self.assertRaises(updater.UpdateError):
            updater.apply_job(self.job, launch=False)
        self.assert_original()

    def test_failed_new_version_rolls_back_program_and_data(self):
        self.fixture()
        process = Mock()
        with patch.object(updater, "_launch", return_value=process) as launch, \
                patch.object(updater, "_verify_started", side_effect=updater.UpdateError("fixture startup failure")), \
                patch.object(updater, "_stop_new"):
            with self.assertRaises(updater.UpdateError):
                updater.apply_job(self.job)
            self.assertEqual(launch.call_count, 2)
        self.assert_original()
        self.assertEqual(json.loads((self.jobdir / "status.json").read_text())["state"], "rolled_back")

    def test_failure_midway_through_data_move_restores_everything(self):
        self.fixture()
        original = Path.rename
        failed = False
        def rename(source, target):
            nonlocal failed
            if source.name == "electron-user-data" and not failed:
                failed = True
                raise OSError("fixture rename failure")
            return original(source, target)
        with patch.object(Path, "rename", rename):
            with self.assertRaises(OSError):
                updater.apply_job(self.job, launch=False)
        self.assert_original()

    def test_gateway_reports_desktop_version_without_losing_standalone_fallback(self):
        tree = ast.parse((PROJECT / "hub/wb_proxy.py").read_text(encoding="utf-8"))
        node = next(item for item in tree.body if isinstance(item, ast.FunctionDef) and item.name == "running_version")
        namespace = {"os": os, "re": re, "Handler": type("Handler", (), {"server_version": "workbuddy/9.9.9"})}
        exec(compile(ast.Module(body=[node], type_ignores=[]), "fixture", "exec"), namespace)
        with patch.dict(os.environ, {"WB_DESKTOP_VERSION": "1.1.0"}):
            self.assertEqual(namespace["running_version"](), "1.1.0")
        with patch.dict(os.environ, {"WB_DESKTOP_VERSION": "invalid"}):
            self.assertEqual(namespace["running_version"](), "9.9.9")


if __name__ == "__main__":
    unittest.main()
