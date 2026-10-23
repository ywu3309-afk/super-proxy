"""Standalone third-party OpenAI-compatible channel registry.

This module is intentionally separate from :mod:`wb_accounts`: an external
channel is a base URL + API key, not a WorkBuddy account and must never enter
the WorkBuddy account pool.  Version 1.4 only provides the management
foundation (persistent CRUD, model mappings and a non-consuming ``/models``
probe); request dispatch is a later, explicit step.
"""

import ipaddress
import json
import os
import secrets
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


class ExternalError(RuntimeError):
    def __init__(self, message, status=400, code="external_error"):
        super().__init__(message)
        self.message = str(message)
        self.status = int(status)
        self.code = str(code)


KIND_OPENAI = "openai-compatible"
POOL_MODE_STANDALONE = "standalone"
MAX_MODELS = 256
MAX_BODY = 2 * 1024 * 1024


def mask_key(value):
    value = str(value or "").strip()
    if not value:
        return ""
    if len(value) <= 10:
        return "*" * len(value)
    return value[:4] + "*" * 6 + value[-4:]


def _now():
    return int(time.time())


def _clean_text(value, limit=256):
    return str(value or "").strip()[:limit]


def _validate_url(raw):
    value = _clean_text(raw, 2048).rstrip("/")
    if not value:
        raise ExternalError("通道地址不能为空", 400, "invalid_base_url")
    try:
        parsed = urllib.parse.urlsplit(value)
    except ValueError as exc:
        raise ExternalError("通道地址格式错误", 400, "invalid_base_url") from exc
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ExternalError("通道地址只支持带主机名的 http/https", 400, "invalid_base_url")
    host = parsed.hostname.lower()
    if host in ("localhost", "localhost.localdomain", "ip6-localhost"):
        raise ExternalError("不允许把通道探活指向本机", 400, "private_target_blocked")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None
    if ip is not None and (ip.is_loopback or ip.is_private or ip.is_link_local or
                           ip.is_unspecified or ip.is_reserved):
        raise ExternalError("不允许把通道探活指向内网/回环地址", 400, "private_target_blocked")
    # Resolve host names too. A public-looking DNS name must not resolve to a
    # loopback/private target at probe time.
    try:
        infos = socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80),
                                   type=socket.SOCK_STREAM)
    except OSError as exc:
        raise ExternalError("通道主机无法解析", 400, "dns_error") from exc
    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            continue
        if ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_unspecified or ip.is_reserved:
            raise ExternalError("通道地址解析到了内网/回环地址", 400, "private_target_blocked")
    return value


def _normalize_model(raw, channel_id=None, existing=None):
    if not isinstance(raw, dict):
        raise ExternalError("模型映射必须是对象", 400, "invalid_model")
    model_id = _clean_text(raw.get("model") or raw.get("id"), 256)
    if not model_id or any(ch in model_id for ch in ("/", "\\", "\n", "\r")):
        raise ExternalError("模型名不能为空且不能包含路径分隔符", 400, "invalid_model")
    remote = _clean_text(raw.get("remote_model"), 256) or model_id
    public_id = "ext/%s/%s" % (channel_id or "channel", model_id)
    return {
        "id": _clean_text(raw.get("id") or secrets.token_hex(6), 32),
        "model": model_id,
        "remote_model": remote,
        "public_id": public_id,
        "enabled": bool(raw.get("enabled", True)),
        "supports_vision": bool(raw.get("supports_vision", False)),
        "supports_tools": bool(raw.get("supports_tools", True)),
        "verified_at": int(raw.get("verified_at") or 0),
        "created_at": int(raw.get("created_at") or _now()),
        "updated_at": _now(),
    }


def _safe_channel(raw, keep_secret=True, existing=None):
    if not isinstance(raw, dict):
        raise ExternalError("通道必须是对象", 400, "invalid_channel")
    cid = _clean_text(raw.get("id") or (existing or {}).get("id") or secrets.token_hex(6), 64)
    name = _clean_text(raw.get("name") or (existing or {}).get("name"), 128)
    if not name:
        raise ExternalError("通道名不能为空", 400, "invalid_channel")
    kind = _clean_text(raw.get("kind") or (existing or {}).get("kind") or KIND_OPENAI, 64)
    if kind != KIND_OPENAI:
        raise ExternalError("当前只支持 openai-compatible 通道", 400, "unsupported_kind")
    base = raw.get("base_url") or (existing or {}).get("base_url")
    base = _validate_url(base)
    supplied_key = str(raw.get("api_key") or "").strip()
    old_key = str((existing or {}).get("api_key") or "").strip()
    if not supplied_key and not old_key:
        raise ExternalError("通道 API Key 不能为空", 400, "missing_api_key")
    key = supplied_key or old_key
    models = raw.get("models") if "models" in raw else (existing or {}).get("models") or []
    if not isinstance(models, list) or len(models) > MAX_MODELS:
        raise ExternalError("模型映射数量超出限制", 400, "invalid_models")
    normalized = {
        "id": cid,
        "name": name,
        "kind": kind,
        "base_url": base,
        "api_key": key if keep_secret else "",
        "enabled": bool(raw.get("enabled", (existing or {}).get("enabled", True))),
        "priority": max(0, min(100000, int(raw.get("priority", (existing or {}).get("priority", 100)) or 100))),
        "note": _clean_text(raw.get("note", (existing or {}).get("note", "")), 1000),
        # Explicitly standalone: no AccountPool fallback or cross-realm mixing.
        "pool_mode": POOL_MODE_STANDALONE,
        "self_hosted_only": bool(raw.get("self_hosted_only", (existing or {}).get("self_hosted_only", False))),
        "last_probe_at": int((existing or {}).get("last_probe_at") or 0),
        "last_probe_ok": bool((existing or {}).get("last_probe_ok", False)),
        "last_probe_code": _clean_text((existing or {}).get("last_probe_code"), 64),
        "last_probe_msg": _clean_text((existing or {}).get("last_probe_msg"), 500),
        "created_at": int((existing or {}).get("created_at") or _now()),
        "updated_at": _now(),
    }
    normalized["models"] = [_normalize_model(m, cid, existing=m) for m in models]
    return normalized


class ExternalStore:
    """JSON-backed store; secrets never leave the process in read responses."""

    def __init__(self, root):
        self.root = os.path.abspath(str(root))
        self.path = os.path.join(self.root, "external_channels.json")
        self._lock = threading.RLock()

    def _load(self):
        try:
            with open(self.path, encoding="utf-8") as fh:
                data = json.load(fh)
            rows = data.get("channels") if isinstance(data, dict) else []
            return rows if isinstance(rows, list) else []
        except FileNotFoundError:
            return []
        except Exception as exc:
            raise ExternalError("第三方通道配置损坏", 500, "store_error") from exc

    def _save(self, rows):
        os.makedirs(self.root, exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"version": 1, "channels": rows}, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, self.path)

    @staticmethod
    def _public(row):
        out = dict(row)
        out.pop("api_key", None)
        out["key_masked"] = mask_key(row.get("api_key"))
        out["models"] = [dict(m) for m in row.get("models") or []]
        return out

    def list(self):
        with self._lock:
            rows = self._load()
            return [self._public(r) for r in sorted(rows, key=lambda x: (int(x.get("priority", 100)), x.get("id", "")))]

    def get(self, channel_id):
        cid = _clean_text(channel_id, 64)
        with self._lock:
            for row in self._load():
                if row.get("id") == cid:
                    return dict(row)
        raise ExternalError("通道不存在", 404, "channel_not_found")

    def save(self, payload):
        with self._lock:
            rows = self._load()
            cid = _clean_text((payload or {}).get("id"), 64)
            old = next((r for r in rows if r.get("id") == cid), None) if cid else None
            row = _safe_channel(payload or {}, keep_secret=True, existing=old)
            if old is None:
                rows.append(row)
            else:
                rows[rows.index(old)] = row
            self._save(rows)
            return self._public(row)

    def delete(self, channel_id):
        with self._lock:
            rows = self._load()
            cid = _clean_text(channel_id, 64)
            kept = [r for r in rows if r.get("id") != cid]
            if len(kept) == len(rows):
                raise ExternalError("通道不存在", 404, "channel_not_found")
            self._save(kept)
            return {"ok": True, "id": cid}

    def toggle(self, channel_id, enabled):
        with self._lock:
            rows = self._load()
            for row in rows:
                if row.get("id") == _clean_text(channel_id, 64):
                    row["enabled"] = bool(enabled)
                    row["updated_at"] = _now()
                    self._save(rows)
                    return self._public(row)
            raise ExternalError("通道不存在", 404, "channel_not_found")

    def save_model(self, payload):
        with self._lock:
            rows = self._load()
            cid = _clean_text((payload or {}).get("channel_id"), 64)
            row = next((r for r in rows if r.get("id") == cid), None)
            if row is None:
                raise ExternalError("通道不存在", 404, "channel_not_found")
            model = _normalize_model(payload, cid)
            found = False
            for idx, old in enumerate(row.get("models") or []):
                if old.get("id") == model["id"] or old.get("model") == model["model"]:
                    model["created_at"] = old.get("created_at") or model["created_at"]
                    row["models"][idx] = model
                    found = True
                    break
            if not found:
                if len(row.get("models") or []) >= MAX_MODELS:
                    raise ExternalError("模型映射数量超出限制", 400, "invalid_models")
                row.setdefault("models", []).append(model)
            row["updated_at"] = _now()
            self._save(rows)
            return self._public(row)

    def delete_model(self, channel_id, model_id):
        with self._lock:
            rows = self._load()
            cid, mid = _clean_text(channel_id, 64), _clean_text(model_id, 256)
            for row in rows:
                if row.get("id") != cid:
                    continue
                before = len(row.get("models") or [])
                row["models"] = [m for m in row.get("models") or [] if m.get("id") != mid and m.get("model") != mid]
                if len(row["models"]) == before:
                    raise ExternalError("模型映射不存在", 404, "model_not_found")
                row["updated_at"] = _now()
                self._save(rows)
                return self._public(row)
            raise ExternalError("通道不存在", 404, "channel_not_found")

    def probe(self, channel_id):
        with self._lock:
            row = self.get(channel_id)
        url = row["base_url"] + "/models"
        request = urllib.request.Request(url, method="GET", headers={
            "Accept": "application/json",
            "Authorization": "Bearer " + row["api_key"],
            "User-Agent": "WorkBuddy-Gateway/1.4",
        })
        result = {"id": row["id"], "models": [], "ok": False}
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                status = int(response.status)
                raw = response.read(MAX_BODY + 1)
                if len(raw) > MAX_BODY:
                    raise ExternalError("上游响应过大", 502, "response_too_large")
                value = json.loads(raw.decode("utf-8", "replace"))
                if not isinstance(value, dict) or not isinstance(value.get("data"), list):
                    raise ExternalError("上游 /models 响应格式不是 OpenAI 兼容格式", 502, "invalid_response")
                result["models"] = sorted({_clean_text(x.get("id"), 256) for x in value["data"] if isinstance(x, dict) and _clean_text(x.get("id"), 256)})
                result.update(ok=True, status=status, code="ok", message="探活成功")
        except urllib.error.HTTPError as exc:
            status = int(exc.code)
            code = "auth_error" if status in (401, 403) else "rate_limited" if status == 429 else "not_found" if status == 404 else "upstream_unavailable" if status >= 500 else "http_error"
            result.update(status=status, code=code, message="上游返回 HTTP %d" % status)
        except urllib.error.URLError as exc:
            result.update(status=502, code="transport_error", message="上游连接失败")
        except ExternalError as exc:
            result.update(status=exc.status, code=exc.code, message=exc.message)
        except (ValueError, UnicodeError, json.JSONDecodeError):
            result.update(status=502, code="invalid_response", message="上游响应不是有效 JSON")
        except Exception:
            result.update(status=502, code="probe_error", message="第三方通道探活失败")
        with self._lock:
            rows = self._load()
            for item in rows:
                if item.get("id") == row["id"]:
                    item["last_probe_at"] = _now()
                    item["last_probe_ok"] = bool(result.get("ok"))
                    item["last_probe_code"] = result.get("code", "probe_error")
                    item["last_probe_msg"] = result.get("message", "")
                    if result.get("ok"):
                        result["channel"] = self._public(item)
                    self._save(rows)
                    break
        return result

