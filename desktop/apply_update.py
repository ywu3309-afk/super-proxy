"""Portable desktop updater. Runs from a separate, local staging directory.

No credentials or downloaded code are evaluated by this helper. Every archive
path and digest is checked before replacing the app; data moves by rename and
the previous program is retained. Only the two process IDs supplied by the
running desktop app are waited on. No services/registry/global settings change.
"""

import ctypes
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import stat
import subprocess
import sys
import time
import urllib.request
import zipfile

ROOT = "WorkBuddy Gateway-win32-x64"
EXE = "WorkBuddy Gateway.exe"
PRESERVE = ("data", "electron-user-data")


class UpdateError(Exception):
    pass


def _status(directory, state, version):
    (directory / "status.json").write_text(json.dumps({
        "state": state, "version": version,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }), encoding="utf-8")


def _alive(pid):
    if not pid:
        return False
    if os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.OpenProcess(0x00100000, False, pid)
        if not handle:
            return ctypes.get_last_error() == 5
        try:
            return kernel.WaitForSingleObject(handle, 0) == 258
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def _wait_for_exit(pid, timeout=90):
    deadline = time.monotonic() + timeout
    while _alive(pid):
        if time.monotonic() >= deadline:
            raise UpdateError("The old app has not exited; no files were replaced")
        time.sleep(0.2)


def _load_job(job_path):
    location = Path(job_path).absolute()
    job = json.loads(location.read_text(encoding="utf-8"))
    directory = Path(job["jobDir"]).absolute()
    install = Path(job["installDir"]).absolute()
    archive = Path(job["zipPath"]).absolute()
    if (job.get("schemaVersion") != 1 or directory != location.parent
            or directory.parent.name != ".super-proxy-updates"
            or directory.parent.parent != install.parent
            or archive.parent != directory or install == install.parent
            or job.get("root") != ROOT or job.get("executable") != EXE
            or not re.fullmatch(r"\d+\.\d+\.\d+", job.get("version", ""))
            or not re.fullmatch(r"[a-f0-9]{64}", job.get("sha256", ""))
            or job.get("repository") != "ywu3309-afk/super-proxy"):
        raise UpdateError("Invalid local update job")
    if any(item.is_symlink() for item in (location, directory, directory.parent, install, archive)):
        raise UpdateError("Symlink update locations are not supported")
    if not install.is_dir() or not (install / EXE).is_file():
        raise UpdateError("The existing portable application was not found")
    return job, directory, install, archive


def _extract(archive, directory, expected_version, repository, extract=True):
    target = directory / "unpacked"
    total = 0
    seen = set()
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        if not entries or len(entries) > 20000:
            raise UpdateError("Invalid archive entry count")
        for item in entries:
            # ZipInfo.filename 在 Windows 会把反斜杠变成斜杠；校验未经归一化的原始名。
            name = item.orig_filename
            parts = PurePosixPath(name).parts
            if (not parts or parts[0] != ROOT or "\\" in name or ":" in name
                    or name.startswith("/") or any(p in (".", "..") for p in parts)
                    or any(p.endswith((".", " ")) for p in parts)
                    or any(p.casefold() in {"data", "accounts", "usage", "electron-user-data", ".git"}
                           for p in parts[1:])
                    or stat.S_ISLNK(item.external_attr >> 16)):
                raise UpdateError("Unsafe path or runtime data in update archive")
            key = "/".join(parts).casefold()
            if key in seen:
                raise UpdateError("Duplicate path in update archive")
            seen.add(key)
            total += item.file_size
            if total > 2 * 1024 * 1024 * 1024:
                raise UpdateError("Unpacked update exceeds size limit")
        for required in (EXE, "resources/app.asar", "resources/hub/wb_proxy.py", "resources/python/python.exe", "resources/desktop-release.json"):
            if (ROOT + "/" + required).casefold() not in seen:
                raise UpdateError("The update archive is incomplete")
        marker = bundle.getinfo(ROOT + "/resources/desktop-release.json")
        if marker.file_size > 65536:
            raise UpdateError("Packaged version metadata is too large")
        metadata = json.loads(bundle.read(marker))
        if metadata.get("version") != expected_version or metadata.get("repository") != repository:
            raise UpdateError("Packaged desktop version does not match the release")
        if extract:
            target.mkdir(exist_ok=False)
            bundle.extractall(target)
    program = target / ROOT
    return program


def _launch(install):
    env = dict(os.environ)
    for name in ("GH_TOKEN", "GITHUB_TOKEN", "WBSIM_RUNTIME_DIR", "WBSIM_DATA_DIR"):
        env.pop(name, None)
    return subprocess.Popen([str(install / EXE)], cwd=str(install), env=env,
                            creationflags=0x08000000 if os.name == "nt" else 0)


def _verify_started(process, install, version, timeout=60):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise UpdateError("The new desktop process exited before startup")
        try:
            info = json.loads((install / "data/gateway.json").read_text(encoding="utf-8"))
            if (info.get("pid") == process.pid and info.get("version") == version
                    and info.get("host") == "127.0.0.1"
                    and isinstance(info.get("port"), int) and 1 <= info["port"] <= 65535):
                # Bypass proxy environment variables: this is a loopback health check.
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                with opener.open("http://127.0.0.1:%d/health" % info["port"], timeout=2) as response:
                    if response.status == 200:
                        return
        except (OSError, ValueError, KeyError):
            pass
        time.sleep(0.5)
    raise UpdateError("The new version failed its local startup health check")


def _stop_new(process, install):
    # Only stop the executable we launched and its self-reported gateway child.
    try:
        info = json.loads((install / "data/gateway.json").read_text(encoding="utf-8"))
        child = info.get("gatewayPid")
        if info.get("pid") == process.pid and isinstance(child, int) and child > 0:
            try:
                os.kill(child, signal.SIGTERM)
                _wait_for_exit(child, timeout=10)
            except (OSError, UpdateError):
                pass
    except (OSError, ValueError):
        pass
    if process.poll() is None:
        process.terminate()
    process.wait(timeout=10)


def check_job(job_path):
    job, directory, install, archive = _load_job(job_path)
    version = job["version"]
    _status(directory, "verifying", version)
    with archive.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if digest != job["sha256"]:
        raise UpdateError("SHA-256 mismatch; the existing program was not replaced")
    _extract(archive, directory, version, job["repository"], extract=False)
    _status(directory, "ready", version)
    return job, directory, install, archive


def apply_job(job_path, launch=True):
    job, directory, install, archive = check_job(job_path)
    version = job["version"]
    program = _extract(archive, directory, version, job["repository"])
    for name in PRESERVE:
        if (install / name).is_symlink():
            raise UpdateError("Symlink runtime data is not supported")
    _status(directory, "waiting_for_exit", version)
    _wait_for_exit(int(job.get("appPid") or 0))
    _wait_for_exit(int(job.get("gatewayPid") or 0))
    backup = install.with_name(install.name + ".previous-" + directory.name)
    if backup.exists():
        raise UpdateError("The previous-version backup location already exists")
    original_moved = False
    installed = False
    new_process = None
    try:
        _status(directory, "applying", version)
        install.rename(backup)
        original_moved = True
        for name in PRESERVE:
            if (backup / name).exists():
                (backup / name).rename(program / name)
        program.rename(install)
        installed = True
        if launch:
            _status(directory, "restarting", version)
            new_process = _launch(install)
            _verify_started(new_process, install, version)
        _status(directory, "succeeded", version)
        return {"version": version, "backupDir": str(backup)}
    except Exception:
        if new_process is not None:
            _stop_new(new_process, install)
        if original_moved:
            _status(directory, "rolling_back", version)
            source = install if installed else program
            if installed:
                source = directory / "failed-program"
                install.rename(source)
            for name in PRESERVE:
                if (source / name).exists() and not (backup / name).exists():
                    (source / name).rename(backup / name)
            backup.rename(install)
            _status(directory, "rolled_back", version)
            if launch:
                _launch(install)
        else:
            _status(directory, "failed", version)
        raise


if __name__ == "__main__":
    try:
        if sys.argv[1] == "--check":
            check_job(sys.argv[2])
        else:
            apply_job(sys.argv[1])
    except Exception:
        # No raw exception/path/HTTP response is emitted; original data remains local.
        sys.exit(1)
