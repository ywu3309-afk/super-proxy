"""Best-effort, account-isolated TRAE CN *directory* cache reader.

This does not authenticate models, refresh the client, or establish chat readiness.
Only two exact keys for the supplied UID are queried; no account discovery occurs.
"""
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import time
import unicodedata


_VALUE_LIMIT = 4 * 1024 * 1024
_TOTAL_LIMIT = 8 * 1024 * 1024
_UID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,159}\Z")
_MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,159}\Z")
_SOURCE = "local_client_cache"
_CUSTOM_FIELDS = ("ak", "sk", "base_url", "custom_model_id",
                  "custom_model_type", "provider", "auth_type")


def _models(raw, function):
    if not isinstance(raw, list) or len(raw) > 4096:
        return None
    models, seen = [], set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        mid = item.get("name")
        if not isinstance(mid, str) or not _MODEL.fullmatch(mid):
            continue
        if mid.lower().startswith("custom_") or mid in seen:
            continue
        # Missing/null legacy flags are allowed; explicit false and malformed
        # non-boolean flags are not. Never accept a known custom connection.
        if any(item.get(key) is not None and item[key] is not True
               for key in ("is_preset", "status", "selectable")):
            continue
        if any(item.get(key) not in (None, "", False) for key in _CUSTOM_FIELDS):
            continue
        if any(item.get(key) is not None and item[key] is not False
               for key in ("client_connect", "is_custom_base_url")):
            continue
        source = item.get("config_source")
        if source is not None and (type(source) is not int or source != 1):
            continue
        name = item.get("display_name")
        if name is None or name == "":
            name = mid
        if not isinstance(name, str) or not 1 <= len(name) <= 160:
            continue
        if name != name.strip() or any(unicodedata.category(c).startswith("C") for c in name):
            continue
        # Explicit allowlist: no raw nested configuration or connection fields
        # (including custom_config) are copied, even for built-in models.
        models.append({"upstreamId": mid, "name": name,
                       "function": function, "source": _SOURCE})
        seen.add(mid)
    return models


def read_local_model_catalog(uid, db_path=None):
    """Return sanitized cached models and file-age metadata, or None on error.

    fetchedAt is the database file's epoch mtime, NOT a server refresh time.
    ageSeconds is informational: old cache is not relabeled fresh or chat-ready.
    Active WAL databases are skipped: opening even mode=ro can create/update SHM
    sidecars, while immutable=1 would silently ignore the WAL's newer records.
    """
    if not isinstance(uid, str) or not _UID.fullmatch(uid):
        return None
    if db_path is None:
        appdata = os.environ.get("APPDATA")
        if not appdata:
            return None
        db_path = Path(appdata) / "Trae CN/User/globalStorage/state.vscdb"
    connection = None
    try:
        path = Path(db_path).resolve(strict=True)
        if not path.is_file() or Path(str(path) + "-wal").exists():
            return None
        before = path.stat()
        if not math.isfinite(before.st_mtime):
            return None
        keys = ((uid + ":AI.agent.model.model_list_map", "assistant"),
                (uid + "_AI.agent.model.model_list_map", "chat_v3"))
        connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=0)
        connection.execute("PRAGMA query_only=ON")
        connection.execute("PRAGMA temp_store=MEMORY")
        rows = connection.execute(
            "SELECT key,length(CAST(value AS BLOB)) FROM ItemTable "
            "WHERE key COLLATE BINARY IN (?,?) LIMIT 3",
            (keys[0][0], keys[1][0])).fetchall()
        sizes = {}
        total = 0
        for key, size in rows:
            if key in sizes or type(size) is not int or not 0 < size <= _VALUE_LIMIT:
                return None
            total += size
            if total > _TOTAL_LIMIT:
                return None
            sizes[key] = size
        for key, function in keys:
            if key not in sizes:
                continue
            row = connection.execute(
                "SELECT substr(CAST(value AS BLOB),1,?) FROM ItemTable "
                "WHERE key COLLATE BINARY=? LIMIT 1",
                (_VALUE_LIMIT + 1, key)).fetchone()
            if not row or not isinstance(row[0], bytes) or len(row[0]) != sizes[key]:
                return None
            document = json.loads(row[0].decode("utf-8"))
            if not isinstance(document, dict):
                return None
            models = _models(document.get(function, []), function)
            if models is None:
                return None
            if not models:
                continue
            after = path.stat()
            if (before.st_mtime_ns, before.st_size) != (after.st_mtime_ns, after.st_size):
                return None
            if Path(str(path) + "-wal").exists():
                return None
            return {"models": models, "source": _SOURCE,
                    "fetchedAt": before.st_mtime,
                    "ageSeconds": max(0.0, time.time() - before.st_mtime)}
    except (OSError, sqlite3.Error, ValueError, TypeError, RecursionError, OverflowError):
        # No logging: errors may contain SQL, paths, or malformed secret fields.
        return None
    finally:
        if connection is not None:
            connection.close()
    return None
