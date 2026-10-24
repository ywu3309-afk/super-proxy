"""Independent TRAE CN adapter. Credentials never leave verified official hosts.

Standard-library only. Imported credentials are DPAPI protected on Windows; no
client installation files are changed. Chat is never replayed or failed over.
"""
import base64
import contextlib
import ctypes
from datetime import datetime
import hashlib
import hmac
import http.client
import json
import math
import os
from pathlib import Path
import re
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from wb_trae_catalog import read_local_model_catalog
from wb_trae_native import NativeTraeClient, NativeBridgeError, _NATIVE_PROMPT_BUDGET
from wb_trae_tools import prepare as prepare_tools, ToolBridgeError
import wb_trae_oauth as trae_oauth
from wb_trae_remote import (
    MODEL_FUNCTIONS as REMOTE_MODEL_FUNCTIONS,
    catalog_headers as remote_catalog_headers,
    normalise_payloads as normalise_remote_catalog,
    request_body as remote_catalog_request_body,
    to_gateway_models as remote_gateway_models,
)


class TraeError(Exception):
    def __init__(self, status, message, code="trae_error", extra=None):
        super().__init__(message)
        self.status = int(status)
        self.http_status = self.status
        self.message = str(message)
        self.code = str(code)
        self.extra = extra if isinstance(extra, dict) else None


# Verified against installed TRAE CN 3.4.4 product.json bootConfig.agent/remote.
# Do not broaden this to *.mchost.guru or accept a user-supplied agent host.
_AGENT = "https://trae-api-cn.mchost.guru"
_HOSTS = frozenset(("api.trae.cn", "api.trae.com.cn", "trae-api-cn.mchost.guru"))
_JSON_LIMIT = 4 * 1024 * 1024
_STREAM_LIMIT = 32 * 1024 * 1024
_LINE_LIMIT = 512 * 1024
_TOKEN = re.compile(r"^[A-Za-z0-9._~+\-/=]{16,16384}$")
_MODEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$")
_ACCOUNT_ID = re.compile(r"^[a-f0-9]{24}$")

# Public format constants from the installed client's byteCrypto implementation.
_CRYPTO_TABLES = (
    (82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37),
    (31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125),
    (191,192,216,250,122,246,220,97,31,254,98,27,8,72,71,176,135,99,96,18,127,101,203,104,211,102,191,125,37,72,150,156,51,229,121,35,17,153,141,177,110,131,150,128,172,255,254,6,18,140,55,62,236,249,135,64,135,12,117,4,89,149,168,209),
    (246,204,26,232,232,70,129,109,223,146,169,242,23,241,105,145,50,196,165,42,254,120,3,54,244,207,209,85,53,6,138,106,175,148,31,204,186,186,165,182,87,142,49,10,39,110,26,154,86,56,173,125,18,64,198,225,99,99,83,82,191,134,76,170),
)


def _gf(a, b):
    value = 0
    for _ in range(8):
        if b & 1:
            value ^= a
        a = ((a << 1) ^ (0x11b if a & 128 else 0)) & 255
        b >>= 1
    return value


def _sboxes():
    forward, inverse = [], [0] * 256
    for n in range(256):
        inverse_field = 0 if not n else 1
        if n:
            base, power = n, 254
            while power:
                if power & 1:
                    inverse_field = _gf(inverse_field, base)
                base = _gf(base, base)
                power >>= 1
        x = inverse_field
        for shift in range(1, 5):
            x ^= ((inverse_field << shift) | (inverse_field >> (8 - shift))) & 255
        x ^= 0x63
        forward.append(x)
        inverse[x] = n
    return forward, inverse


_SBOX, _INVBOX = _sboxes()


def _aes128_cbc_decrypt(key, iv, ciphertext):
    if len(key) != 16 or len(iv) != 16 or not ciphertext or len(ciphertext) % 16:
        raise ValueError("invalid AES block size")
    expanded = list(key)
    rcon = 1
    while len(expanded) < 176:
        word = expanded[-4:]
        if len(expanded) % 16 == 0:
            word = [_SBOX[v] for v in word[1:] + word[:1]]
            word[0] ^= rcon
            rcon = _gf(rcon, 2)
        for v in word:
            expanded.append(expanded[-16] ^ v)
    output = bytearray()
    previous = iv
    for offset in range(0, len(ciphertext), 16):
        block = ciphertext[offset:offset + 16]
        state = [block[i] ^ expanded[160 + i] for i in range(16)]
        for rnd in range(9, -1, -1):
            state = [_INVBOX[state[(i - 4 * (i % 4)) % 16]] for i in range(16)]
            state = [state[i] ^ expanded[rnd * 16 + i] for i in range(16)]
            if rnd:
                mixed = []
                for col in range(4):
                    part = state[col * 4:col * 4 + 4]
                    for row in range(4):
                        mixed.append(_gf(part[row], 14) ^ _gf(part[(row + 1) % 4], 11) ^
                                     _gf(part[(row + 2) % 4], 13) ^ _gf(part[(row + 3) % 4], 9))
                state = mixed
        output.extend(state[i] ^ previous[i] for i in range(16))
        previous = block
    return bytes(output)


def decode_stored_user_info(encoded):
    """Pure decoder: no files/network. Verify format and SHA-512 integrity."""
    try:
        if not isinstance(encoded, str) or len(encoded) > 512 * 1024:
            raise ValueError()
        data = base64.b64decode(encoded, validate=True)
        headers = (bytes.fromhex("746305100000"), bytes.fromhex("123920200203"))
        if len(data) < 54 or data[:6] not in headers:
            raise ValueError()
        index = headers.index(data[:6]) * 2
        salt = bytes(a ^ b for a, b in zip(_CRYPTO_TABLES[index], _CRYPTO_TABLES[index + 1]))
        material = hashlib.sha512(hashlib.sha512(data[6:38]).digest() + salt).digest()
        plain = _aes128_cbc_decrypt(material[:16], material[16:32], data[38:])
        padding = plain[-1]
        if not 1 <= padding <= 16 or plain[-padding:] != bytes([padding]) * padding:
            raise ValueError()
        plain = plain[:-padding]
        if len(plain) < 64 or not hmac.compare_digest(hashlib.sha512(plain[64:]).digest(), plain[:64]):
            raise ValueError()
        value = json.loads(plain[64:])
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except (ValueError, TypeError, IndexError, UnicodeError, RecursionError):
        raise TraeError(422, "无法识别当前 TRAE 登录存储，请在 TRAE 内重新登录后同步。", "local_storage_unsupported") from None


def read_local_account():
    """Read only the documented local login key; never read device-proof keys."""
    appdata = os.environ.get("APPDATA")
    if not appdata:
        raise TraeError(404, "未找到 TRAE CN 用户配置目录。", "local_account_not_found")
    storage = Path(appdata) / "Trae CN/User/globalStorage/storage.json"
    try:
        if storage.stat().st_size > 8 * 1024 * 1024:
            raise TraeError(422, "TRAE 配置文件超出读取限制。", "local_storage_unsupported")
        document = json.loads(storage.read_text(encoding="utf-8"))
        encoded = document.get("iCubeAuthInfo://icube.cloudide")
        if not encoded:
            raise TraeError(404, "TRAE CN 尚未登录，请先打开 TRAE 登录。", "local_account_not_found")
        info = decode_stored_user_info(encoded)
    except (OSError, ValueError, AttributeError, RecursionError):
        raise TraeError(404, "未找到可读取的 TRAE CN 登录信息。", "local_account_not_found") from None
    host = info.get("host")
    if host:
        _safe_url(str(host))
    account = info.get("account") or {}
    if not isinstance(account, dict):
        raise TraeError(422, "TRAE 本地账号资料结构无效。", "local_storage_unsupported")
    return {"region": "cn", "label": account.get("username") or "TRAE CN 本机账号",
        "account": {"uid": info.get("userId", "")},
        "auth": {"accessToken": info.get("token", ""), "expiresAt": info.get("expiredAt", 0)}}


def _compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _finite_number(value):
    """JSON may contain integers too large for a float conversion."""
    try:
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    except (OverflowError, TypeError, ValueError):
        return False


def _atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with open(temp, "xb") as handle:
            os.chmod(temp, 0o600)
            handle.write(_compact(value))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temp.unlink()


def _dpapi(raw, decrypt=False):
    if os.name != "nt":
        raise TraeError(503, "TRAE 凭据存储需要 Windows DPAPI。", "credential_store_unavailable")
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]

    buf = ctypes.create_string_buffer(raw)
    src = Blob(len(raw), ctypes.cast(buf, ctypes.POINTER(ctypes.c_byte)))
    dst = Blob()
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    if decrypt:
        function = crypt32.CryptUnprotectData
        function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                             ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
        ok = function(ctypes.byref(src), None, None, None, None, 1, ctypes.byref(dst))
    else:
        function = crypt32.CryptProtectData
        function.argtypes = [ctypes.POINTER(Blob), wintypes.LPCWSTR, ctypes.c_void_p,
                             ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
        ok = function(ctypes.byref(src), "Super Proxy TRAE", None, None, None, 1, ctypes.byref(dst))
    if not ok:
        raise TraeError(503, "TRAE 凭据无法在当前 Windows 用户下解密。", "credential_store_unavailable")
    try:
        return ctypes.string_at(dst.pbData, dst.cbData)
    finally:
        kernel32.LocalFree(ctypes.cast(dst.pbData, ctypes.c_void_p))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise TraeError(502, "TRAE 请求重定向已阻止。", "redirect_blocked")


def _safe_url(url):
    try:
        parsed = urllib.parse.urlsplit(url)
        valid = (parsed.scheme == "https" and parsed.hostname in _HOSTS and not parsed.username
                 and not parsed.password and parsed.port in (None, 443) and not parsed.fragment)
    except ValueError:
        valid = False
    if not valid:
        raise TraeError(400, "TRAE 只允许连接已核实的官方 HTTPS 服务。", "untrusted_host")
    return url


def _upstream_error(status, body=None):
    if isinstance(body, dict) and isinstance(body.get("data"), dict):
        body = {**body, **body["data"]}
    code = body.get("code") if isinstance(body, dict) else None
    if code in (1005, 4008, "1005", "4008"):
        return TraeError(402, "TRAE 积分或套餐权益不足。", "credits_exhausted")
    if code in (4015, "4015"):
        return TraeError(403, "TRAE 风控拒绝了当前账号或出口，请更换账号或稍后重试。", "access_denied")
    if code in (4001, 2001, "4001", "2001"):
        return TraeError(400, "TRAE 请求参数或工具协议不兼容。", "invalid_request")
    if status == 401:
        return TraeError(401, "TRAE 登录已失效，请重新导入账号。", "login_expired")
    if status == 403:
        return TraeError(403, "TRAE 拒绝了当前账号的请求。", "access_denied")
    if status == 429 or code in (4011, "4011"):
        return TraeError(429, "TRAE 请求过于频繁，请稍后再试。", "rate_limited")
    if status == 404:
        return TraeError(502, "TRAE 当前客户端接口不可用。", "upstream_not_found")
    return TraeError(502, "TRAE 服务返回错误，未重放请求。", "upstream_error")


def _expires(value):
    try:
        if isinstance(value, str) and not value.replace(".", "", 1).isdigit():
            return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())
        number = float(value or 0)
        return int(number / 1000 if number > 100000000000 else number)
    except (ValueError, TypeError, OverflowError):
        return 0


def iter_sse(response):
    """Strict bounded SSE parser. Incomplete streams never become fake success."""
    event, data = "", []
    total = 0
    deadline = time.monotonic() + 180
    for _ in range(200000):
        if time.monotonic() > deadline:
            raise TraeError(504, "TRAE 流式响应超时，未重放请求。", "stream_timeout")
        line = response.readline(_LINE_LIMIT + 1)
        if len(line) > _LINE_LIMIT:
            raise TraeError(502, "TRAE SSE 单行超出大小限制。", "response_too_large")
        total += len(line)
        if total > _STREAM_LIMIT:
            raise TraeError(502, "TRAE SSE 响应超出大小限制。", "response_too_large")
        if not line:
            if data:
                yield _decode_event(event, data)
            return
        try:
            text = line.decode("utf-8").rstrip("\r\n")
        except UnicodeError:
            raise TraeError(502, "TRAE SSE 编码无效。", "invalid_upstream_response") from None
        if not text:
            if data:
                yield _decode_event(event, data)
            event, data = "", []
        elif text.startswith("event:"):
            event = text[6:].strip()
        elif text.startswith("data:"):
            data.append(text[5:].removeprefix(" "))
        # Comments, id and retry fields contain no assistant content.
    raise TraeError(502, "TRAE SSE 事件数超出限制。", "response_too_large")


def _decode_event(event, lines):
    raw = "\n".join(lines)
    if raw == "[DONE]":
        return "done", {"finish_reason": "stop"}
    try:
        value = json.loads(raw)
    except (ValueError, RecursionError):
        raise TraeError(502, "TRAE SSE 数据不是有效 JSON。", "invalid_upstream_response") from None
    if not isinstance(value, dict):
        raise TraeError(502, "TRAE SSE 数据结构无效。", "invalid_upstream_response")
    return event, value


class TraeProvider:
    def __init__(self, data_root, *, opener=None, protector=None, local_reader=None,
                 native_client=None, catalog_reader=None, remote_catalog=False):
        self.root = Path(data_root).resolve() / "trae"
        # Request telemetry is deliberately separate from account records.  It
        # contains only local, non-secret counters used by the TRAE panel; no
        # token, cookie, prompt, image bytes or raw upstream response is ever
        # written here.
        self.metrics_path = self.root / "requests.jsonl"
        self._metrics_cache_at = 0.0
        self._metrics_cache = None
        self._lock = threading.RLock()
        self._account_locks = {}
        self._opener = opener or urllib.request.build_opener(_NoRedirect())
        self._protector = protector or _dpapi
        self._local_reader = local_reader or read_local_account
        self._native = native_client if native_client is not None else NativeTraeClient()
        self._catalog_reader = catalog_reader or read_local_model_catalog
        # The upstream wb-proxy implementation now reads the live
        # get_detail_param catalog.  Keep the switch injectable so offline
        # contract tests and operators that intentionally pin the old endpoint
        # can still do so without changing account storage.
        self._remote_catalog = remote_catalog is True
        self._cursor = 0
        # Browser login state is intentionally process-local.  The state holds
        # only the PKCE verifier/device proof material needed to finish one
        # short-lived OAuth attempt; tokens are written only through the
        # DPAPI-protected account store after the callback is verified.
        self._oauth_lock = threading.RLock()
        self._oauth_logins = {}
        self._oauth_ttl = 10 * 60

    @staticmethod
    def _metric_int(value):
        return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0

    def _record_request(self, row, model, body, started, *, usage=None,
                        usage_source=None, outcome="completed", error=None):
        """Append one redacted TRAE request row for the local dashboard."""
        try:
            usage = usage if isinstance(usage, dict) else {}
            prompt = self._metric_int(usage.get("prompt_tokens"))
            completion = self._metric_int(usage.get("completion_tokens"))
            reasoning = self._metric_int(usage.get("reasoning_tokens"))
            total = self._metric_int(usage.get("total_tokens")) or prompt + completion + reasoning
            route = ""
            try:
                route = next((str(item.get("route") or "") for item in row.get("models", [])
                              if item.get("upstreamId") == model[5:]), "")
            except Exception:
                route = ""
            record = {
                "at": int(time.time() * 1000),
                "model": model,
                "account": str(row.get("label") or "TRAE"),
                "route": route,
                "mode": "vision" if body.get("_images") else "tools" if body.get("_tool_plan") else "text",
                "status": "completed" if outcome == "completed" else "error",
                "errorCode": str(error or "")[:80],
                "latencyMs": max(0, int((time.monotonic() - started) * 1000)),
                "promptTokens": prompt,
                "completionTokens": completion,
                "reasoningTokens": reasoning,
                "totalTokens": total,
                "usageSource": str(usage_source or ("upstream" if usage else "missing")),
            }
            self.root.mkdir(parents=True, exist_ok=True)
            with self.metrics_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
            self._metrics_cache_at = 0.0
        except (OSError, TypeError, ValueError):
            # Telemetry must never change the request outcome.
            pass

    def analytics(self):
        """Return redacted all-time TRAE request analytics for the local panel."""
        now = time.time()
        with self._lock:
            if self._metrics_cache is not None and now - self._metrics_cache_at < 5:
                return self._metrics_cache
            rows = []
            try:
                if self.metrics_path.is_file():
                    # A bounded tail prevents a very old local history from
                    # making a dashboard refresh expensive.
                    lines = self.metrics_path.read_text(encoding="utf-8").splitlines()[-5000:]
                    for line in lines:
                        try:
                            item = json.loads(line)
                        except (ValueError, TypeError):
                            continue
                        if isinstance(item, dict):
                            rows.append(item)
            except (OSError, UnicodeError):
                rows = []
            total = success = errors = total_tokens = input_tokens = output_tokens = latency = 0
            estimated_requests = estimated_tokens = 0
            by_model = {}
            by_account = {}
            for item in rows:
                total += 1
                ok = item.get("status") == "completed"
                success += 1 if ok else 0
                errors += 0 if ok else 1
                tokens = self._metric_int(item.get("totalTokens"))
                prompt = self._metric_int(item.get("promptTokens"))
                completion = self._metric_int(item.get("completionTokens"))
                total_tokens += tokens
                if item.get("usageSource") == "estimated":
                    estimated_requests += 1
                    estimated_tokens += tokens
                input_tokens += prompt
                output_tokens += completion
                latency += self._metric_int(item.get("latencyMs"))
                model = str(item.get("model") or "unknown")
                account = str(item.get("account") or "TRAE")
                model_row = by_model.setdefault(model, {"model": model, "requests": 0, "success": 0,
                    "errors": 0, "tokens": 0, "inputTokens": 0, "outputTokens": 0, "vision": 0})
                model_row["requests"] += 1
                model_row["success"] += 1 if ok else 0
                model_row["errors"] += 0 if ok else 1
                model_row["tokens"] += tokens
                model_row["inputTokens"] += prompt
                model_row["outputTokens"] += completion
                model_row["vision"] += 1 if item.get("mode") == "vision" else 0
                account_row = by_account.setdefault(account, {"account": account, "requests": 0,
                    "success": 0, "errors": 0, "tokens": 0})
                account_row["requests"] += 1
                account_row["success"] += 1 if ok else 0
                account_row["errors"] += 0 if ok else 1
                account_row["tokens"] += tokens
            denominator = success + errors
            result = {
                "summary": {
                    "requests": total,
                    "success": success,
                    "errors": errors,
                    "successRatePct": round(success * 100 / denominator, 1) if denominator else None,
                    "totalTokens": total_tokens,
                    "inputTokens": input_tokens,
                    "outputTokens": output_tokens,
                    "estimatedRequests": estimated_requests,
                    "estimatedTokens": estimated_tokens,
                    "avgLatencyMs": round(latency / success) if success else None,
                    "lastRequestAt": rows[-1].get("at") if rows else None,
                },
                "byModel": sorted(by_model.values(), key=lambda item: item["tokens"], reverse=True),
                "byAccount": sorted(by_account.values(), key=lambda item: item["tokens"], reverse=True),
                "recent": [{key: item.get(key) for key in (
                    "at", "model", "account", "route", "mode", "status", "errorCode",
                    "latencyMs", "totalTokens", "usageSource")} for item in rows[-30:][::-1]],
            }
            self._metrics_cache = result
            self._metrics_cache_at = now
            return result

    def _records(self):
        result = []
        if self.root.is_dir():
            for path in sorted(self.root.glob("*.json")):
                if not _ACCOUNT_ID.fullmatch(path.stem):
                    continue
                try:
                    if path.stat().st_size > 128 * 1024:
                        continue
                    row = json.loads(path.read_text(encoding="utf-8"))
                    if isinstance(row, dict) and row.get("id") == path.stem:
                        if row.get("schemaVersion", 1) != 1 or not isinstance(row.get("enabled"), bool):
                            continue
                        if not isinstance(row.get("models", []), list) or not all(
                                isinstance(m, dict) and isinstance(m.get("upstreamId"), str) and
                                _MODEL.fullmatch(m["upstreamId"]) for m in row.get("models", [])):
                            continue
                        if any(not _finite_number(row.get(key, 0)) or row.get(key, 0) < 0
                               for key in ("expiresAt", "cooldownUntil")):
                            continue
                        credits = row.get("credits")
                        if credits is not None and not _finite_number(credits):
                            continue
                        if not isinstance(row.get("label", ""), str) or not isinstance(row.get("secret"), str):
                            continue
                        if str(row.get("region", "cn")).lower() not in ("cn", "intl"):
                            continue
                        if not isinstance(row.get("status", ""), str) or not isinstance(row.get("creditDetails", []), list):
                            continue
                        result.append(row)
                except (OSError, ValueError, RecursionError):
                    continue
        return result

    def _path(self, account_id):
        if not isinstance(account_id, str) or not _ACCOUNT_ID.fullmatch(account_id):
            raise TraeError(400, "TRAE 账号标识无效。", "invalid_account")
        return self.root / (account_id + ".json")

    def _get(self, account_id):
        path = self._path(account_id)
        for row in self._records():
            if row["id"] == account_id:
                return row
        raise TraeError(404, "TRAE 账号不存在。", "account_not_found")

    def _save(self, row):
        _atomic(self._path(row["id"]), row)

    def _account_lock(self, account_id):
        with self._lock:
            return self._account_locks.setdefault(account_id, threading.RLock())

    def _credentials(self, row):
        try:
            raw = base64.b64decode(row["secret"], validate=True)
            result = json.loads(self._protector(raw, True))
            if not isinstance(result, dict) or not _TOKEN.fullmatch(result.get("token", "")):
                raise ValueError()
            return result
        except TraeError:
            raise
        except (KeyError, TypeError, ValueError, OSError, RecursionError):
            raise TraeError(503, "TRAE 凭据存储损坏，请重新导入账号。", "credential_store_unavailable") from None

    def _protect(self, credentials):
        return base64.b64encode(self._protector(_compact(credentials), False)).decode("ascii")

    @staticmethod
    def _client():
        roots = []
        for base in (os.environ.get("LOCALAPPDATA"), os.environ.get("ProgramW6432"),
                     os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")):
            if not isinstance(base, str) or not base:
                continue
            for candidate in (Path(base) / "Programs/Trae CN/resources/app",
                              Path(base) / "Trae CN/resources/app"):
                if candidate not in roots:
                    roots.append(candidate)
        if os.name == "nt":
            try:
                import winreg
                uninstall_roots = (
                    (winreg.HKEY_CURRENT_USER, r"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall"),
                    (winreg.HKEY_LOCAL_MACHINE, r"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall"),
                    (winreg.HKEY_LOCAL_MACHINE, r"Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall"),
                )
                for hive, key_path in uninstall_roots:
                    try:
                        with winreg.OpenKey(hive, key_path) as uninstall:
                            for index in range(winreg.QueryInfoKey(uninstall)[0]):
                                try:
                                    with winreg.OpenKey(uninstall, winreg.EnumKey(uninstall, index)) as entry:
                                        display = winreg.QueryValueEx(entry, "DisplayName")[0]
                                        if not isinstance(display, str) or "trae" not in display.lower() or "cn" not in display.lower():
                                            continue
                                        install = winreg.QueryValueEx(entry, "InstallLocation")[0]
                                        if isinstance(install, str) and install:
                                            roots.append(Path(install) / "resources/app")
                                        icon = winreg.QueryValueEx(entry, "DisplayIcon")[0]
                                        if isinstance(icon, str) and icon:
                                            roots.append(Path(icon.split(",", 1)[0]).parent / "resources/app")
                                except (OSError, ValueError, TypeError):
                                    continue
                    except (OSError, ValueError, TypeError):
                        continue
            except (ImportError, OSError, ValueError, TypeError):
                pass
        unique = []
        for root in roots:
            if root not in unique:
                unique.append(root)
        for root in unique:
            try:
                product = json.loads((root / "product.json").read_text(encoding="utf-8"))
                version = product.get("appVersion")
                return {"installed": True, "version": version if isinstance(version, str) else None,
                        "path": str(root.parent.parent)}
            except (OSError, ValueError, AttributeError, RecursionError):
                pass
        return {"installed": False, "version": None, "path": None}

    @staticmethod
    def _oauth_uid(token, fallback=""):
        """Extract only the stable subject from a JWT; never expose claims."""
        value = str(fallback or "").strip()
        if value:
            return value[:128]
        try:
            parts = str(token or "").split(".")
            if len(parts) < 2:
                return ""
            raw = parts[1] + "=" * (-len(parts[1]) % 4)
            claims = json.loads(base64.urlsafe_b64decode(raw.encode("ascii")))
            if isinstance(claims, dict):
                data = claims.get("data") if isinstance(claims.get("data"), dict) else {}
                for key in ("userId", "uid", "sub", "id"):
                    item = data.get(key) or claims.get(key)
                    if isinstance(item, (str, int)) and str(item).strip():
                        return str(item).strip()[:128]
        except (ValueError, TypeError, UnicodeError, json.JSONDecodeError,
                RecursionError):
            pass
        return ""

    def _oauth_prune(self, now=None):
        now = time.time() if now is None else float(now)
        with self._oauth_lock:
            for key, item in list(self._oauth_logins.items()):
                created = float(item.get("created") or 0)
                if now - created > self._oauth_ttl:
                    self._oauth_logins.pop(key, None)

    def start_oauth_login(self, callback_url, realm="cn"):
        """Start a browser/QR login without requiring the TRAE desktop app."""
        realm = str(realm or "cn").strip().lower()
        if realm != "cn":
            raise TraeError(422, "TRAE 版本无效。", "unsupported_region")
        callback = trae_oauth.normalize_oauth_callback(callback_url)
        if not callback:
            raise TraeError(400, "无法生成 TRAE 本地授权回调地址。", "oauth_callback_invalid")
        self._oauth_prune()
        try:
            # Browser/QR login is deliberately independent from the desktop
            # client.  Do not scan storage.json or reuse a stale native device
            # identity for this path; the OAuth helper creates a gateway-owned
            # device identity and still keeps native scan as a compatibility
            # action below the same page.
            device = trae_oauth.oauth_device(realm, prefer_local=False)
            started = trae_oauth.oauth_login_url(realm, callback, device=device)
        except Exception as exc:
            # Do not echo device keys or authorization material in the panel.
            raise TraeError(502, "无法生成 TRAE 浏览器授权链接。", "oauth_start_failed") from exc
        state = str(started.get("state") or "").strip()
        auth_url = str(started.get("authUrl") or "").strip()
        if not state or not auth_url:
            raise TraeError(502, "TRAE 授权服务没有返回有效链接。", "oauth_start_failed")
        with self._oauth_lock:
            self._oauth_logins[state] = {
                "created": time.time(),
                "realm": realm,
                "verifier": str(started.get("verifier") or ""),
                "deviceId": str(started.get("deviceId") or ""),
                "machineId": str(started.get("machineId") or ""),
                "publicKeyPEM": str(started.get("publicKeyPEM") or ""),
                "privateKeyPEM": str(started.get("privateKeyPEM") or ""),
                "appVersion": str(started.get("appVersion") or ""),
                "callbackUrl": callback,
                "status": "pending",
            }
        return {
            "state": state,
            "authUrl": auth_url,
            "realm": realm,
            "provider": "trae",
            "redirectUri": callback,
            "expiresAt": int(time.time() + self._oauth_ttl),
        }

    def _oauth_result(self, state, result):
        with self._oauth_lock:
            item = self._oauth_logins.get(state)
            if item is None:
                return
            item["status"] = "ok" if result.get("ok") else "error"
            item["result"] = {
                "status": item["status"],
                "account": result.get("account") if result.get("ok") else None,
                "message": result.get("error") if not result.get("ok") else "",
            }
            # Keep a completed attempt briefly so the browser page and the
            # dashboard poll can both observe the same result.
            item["created"] = time.time() - self._oauth_ttl + 300

    def complete_oauth_login(self, params):
        """Consume the official callback and add the account to the TRAE pool."""
        self._oauth_prune()
        try:
            callback = trae_oauth.parse_oauth_callback(params)
        except Exception:
            return {"ok": False, "error": "TRAE 授权回调格式无效。"}
        state = str(callback.get("loginTraceID") or "").strip()
        with self._oauth_lock:
            item = dict(self._oauth_logins.get(state) or {}) if state else {}
        if not item or item.get("status") not in (None, "pending"):
            return {"ok": False, "error": "授权会话不存在或已过期，请重新发起。"}
        if time.time() - float(item.get("created") or 0) > self._oauth_ttl:
            with self._oauth_lock:
                self._oauth_logins.pop(state, None)
            return {"ok": False, "error": "授权会话已过期，请重新发起。"}
        realm = str(item.get("realm") or "cn")
        device = {
            "deviceId": item.get("deviceId") or "",
            "machineId": item.get("machineId") or "",
            "publicKeyPEM": item.get("publicKeyPEM") or "",
            "privateKeyPEM": item.get("privateKeyPEM") or "",
            "appVersion": item.get("appVersion") or "",
        }
        token = str(callback.get("accessToken") or "").strip()
        refresh = str(callback.get("refreshToken") or "").strip()
        try:
            if not token and callback.get("authCode"):
                exchanged = trae_oauth.exchange_auth_code(
                    callback["authCode"], item.get("verifier") or "",
                    callback.get("host") or "", device, realm=realm)
                token = str(exchanged.get("accessToken") or "").strip()
                refresh = str(exchanged.get("refreshToken") or refresh).strip()
                expires_at = exchanged.get("expiresAt") or 0
                refresh_expired_at = exchanged.get("refreshExpiredAt") or 0
            else:
                expires_at = 0
                refresh_expired_at = 0
            if not token:
                raise ValueError("回调里没有可用的授权令牌")
            uid = self._oauth_uid(token, callback.get("userId"))
            label = str(callback.get("userName") or uid or "TRAE CN")[:80]
            result = self.import_account({
                "oauth": True,
                "source": "oauth",
                "region": realm,
                "label": label,
                "account": {"uid": uid, "nickname": label},
                "auth": {
                    "accessToken": token,
                    "refreshToken": refresh,
                    "expiresAt": expires_at,
                    "uid": uid,
                    "userId": uid,
                    "deviceId": device.get("deviceId") or "",
                    "machineId": device.get("machineId") or "",
                    "devicePublicKey": device.get("publicKeyPEM") or "",
                    "privateKeyPEM": device.get("privateKeyPEM") or "",
                    "appVersion": device.get("appVersion") or "",
                    "userRegion": callback.get("userRegion") or "",
                    "refreshExpiredAt": refresh_expired_at,
                },
            })
            account = next((row for row in result.get("accounts", [])
                            if row.get("label") == label), None)
            response = {"ok": True, "account": account or {"label": label, "uid": uid}}
            self._oauth_result(state, response)
            return response
        except Exception:
            response = {"ok": False, "error": "TRAE 授权交换失败，请重新发起授权。"}
            self._oauth_result(state, response)
            return response

    def poll_oauth_login(self, state):
        state = str(state or "").strip()
        self._oauth_prune()
        with self._oauth_lock:
            item = self._oauth_logins.get(state)
            if item is None:
                return {"status": "unknown", "message": "授权会话不存在，请重新发起。"}
            status = item.get("status", "pending")
            result = dict(item.get("result") or {})
        if status == "ok":
            return {"status": "ok", "account": result.get("account"), "provider": self.status()}
        if status == "error":
            return {"status": "error", "message": result.get("message") or "授权失败。"}
        return {"status": "pending", "message": "等待浏览器授权 / 扫码完成。"}

    def cancel_oauth_login(self, state):
        state = str(state or "").strip()
        with self._oauth_lock:
            return self._oauth_logins.pop(state, None) is not None

    def status(self):
        with self._lock:
            rows = self._records()
            accounts = []
            models = {}
            for row in rows:
                expired = bool(row.get("expiresAt") and row["expiresAt"] <= time.time() + 10)
                accounts.append({"id": row["id"], "label": row.get("label", "TRAE"),
                    "region": str(row.get("region") or "cn"), "enabled": row.get("enabled") is True,
                    "status": "login_expired" if expired else row.get("status", "imported"), "credits": row.get("credits"),
                    "lastError": "TRAE 登录已失效，请在 TRAE 内刷新后重新同步。" if expired else row.get("lastError"), "updatedAt": row.get("updatedAt"),
                    "expiresAt": row.get("expiresAt"), "creditDetails": row.get("creditDetails", []),
                    "cooldownUntil": row.get("cooldownUntil"),
                    "quotaError": row.get("quotaError"), "modelError": row.get("modelError"),
                    "catalogSource": row.get("catalogSource", "legacy_http"),
                    "catalogFetchedAt": row.get("catalogFetchedAt"),
                    "catalogAgeSeconds": max(0, time.time() - row["catalogFetchedAt"])
                        if _finite_number(row.get("catalogFetchedAt")) else None,
                    "nativeConnected": row.get("nativeConnected") is True,
                    "nativeError": row.get("nativeError")})
                if row.get("enabled"):
                    for model in row.get("models", []):
                        if isinstance(model, dict) and _MODEL.fullmatch(model.get("upstreamId", "")):
                            mid = "trae/" + model["upstreamId"]
                            models[mid] = {"id": mid, "name": model.get("name") or model["upstreamId"],
                                "route": model.get("route", "legacy_http"),
                                "source": model.get("source", row.get("catalogSource", "legacy_http")),
                                "streaming": "buffered" if model.get("route") == "native_client" else "sse"}
                            if "supports_vision" in model:
                                models[mid]["supports_vision"] = (mid == "trae/deepseek-v4.1-flash"
                                    and model.get("route") == "native_client"
                                    and model.get("source", row.get("catalogSource")) == "native_client"
                                    and row.get("nativeConnected") is True
                                    and model.get("supports_vision") is True)
            return {"provider": "trae", "accounts": accounts, "models": list(models.values()),
                    "client": {**self._client(), "nativeBridgeConfigured": bool(getattr(self._native, "configured", False))},
                    "creditsScope": "account_pool_not_model_entitlement",
                    "metrics": self.analytics()}

    def models(self):
        return [{"id": m["id"], "object": "model", "owned_by": "trae", "name": m["name"],
                 "route": m["route"], "streaming": m["streaming"], "source": m["source"],
                 "supports_vision": m.get("supports_vision") is True,
                 "context_limit_chars": _NATIVE_PROMPT_BUDGET,
                 "input": ["text", "image"] if m.get("supports_vision") is True else ["text"]}
                for m in self.status()["models"]]

    def import_account(self, payload):
        if not isinstance(payload, dict):
            raise TraeError(400, "请输入 TRAE 账号 JSON 或登录令牌。", "invalid_import")
        auth = payload.get("auth", payload)
        account = payload.get("account", {})
        if not isinstance(auth, dict) or not isinstance(account, dict):
            raise TraeError(400, "TRAE 账号 JSON 格式无效。", "invalid_import")
        region = str(payload.get("region", "cn")).lower()
        if region in ("china", "cn"):
            region = "cn"
        else:
            raise TraeError(422, "TRAE 版本无效。", "unsupported_region")
        for key in ("apiHost", "host", "baseURL", "base_url", "agentHost"):
            value = auth.get(key, payload.get(key))
            if value:
                _safe_url(str(value))
        token = auth.get("accessToken", auth.get("token", ""))
        if not isinstance(token, str):
            raise TraeError(400, "TRAE 登录令牌格式无效。", "invalid_token")
        token = token.removeprefix("Cloud-IDE-JWT ").strip()
        if not _TOKEN.fullmatch(token):
            raise TraeError(400, "TRAE 登录令牌格式无效。", "invalid_token")
        label = str(payload.get("label") or account.get("nickname") or "TRAE CN")[:80]
        # Identity is stable across refreshes when an upstream UID is supplied.
        uid = str(account.get("uid") or auth.get("uid") or "")[:128]
        if uid and not re.fullmatch(r"[A-Za-z0-9._:@-]{1,128}", uid):
            raise TraeError(400, "TRAE 账号用户标识无效。", "invalid_import")
        account_id = hashlib.sha256((region + ":" + (uid or token)).encode()).hexdigest()[:24]
        credentials = {"token": token}
        oauth_managed = bool(payload.get("oauth")) or str(payload.get("source") or "") == "oauth"
        # Manual JWT import keeps the historical narrow credential surface.
        # Browser OAuth accounts additionally retain the refresh/device fields
        # inside the DPAPI envelope so they can refresh without the desktop app.
        for key in ("machineId", "deviceId"):
            value = auth.get(key, "")
            if isinstance(value, str) and value and len(value) <= 16384 and not any(ord(c) < 32 for c in value):
                credentials[key] = value
        if oauth_managed:
            refresh = auth.get("refreshToken", "")
            if isinstance(refresh, str) and refresh and _TOKEN.fullmatch(refresh):
                credentials["refreshToken"] = refresh
            for key in ("devicePublicKey", "privateKeyPEM", "appVersion", "userRegion"):
                value = auth.get(key, "")
                if isinstance(value, str) and value and len(value) <= 64 * 1024 and not any(ord(c) < 32 for c in value):
                    credentials[key] = value
            for key in ("refreshExpiredAt", "tokenReleaseAt"):
                value = _expires(auth.get(key, 0))
                if value:
                    credentials[key] = value
        if uid:
            credentials["uid"] = uid
        with self._account_lock(account_id), self._lock:
            existing = next((r for r in self._records() if r["id"] == account_id), {})
            row = {"schemaVersion": 1, "id": account_id, "label": label, "region": region, "enabled": True,
                "status": "imported", "credits": existing.get("credits"), "lastError": None,
                "models": existing.get("models", []), "updatedAt": int(time.time()),
                "expiresAt": _expires(auth.get("expiresAt", auth.get("expiredAt", 0))),
                "secret": self._protect(credentials)}
            for key in ("catalogSource", "catalogFetchedAt", "nativeConnected", "nativeError"):
                if key in existing:
                    row[key] = existing[key]
            if row["expiresAt"] and row["expiresAt"] <= time.time():
                row["status"] = "login_expired"
                row["lastError"] = "TRAE 登录已失效，请在 TRAE 内刷新后重新同步。"
            self._save(row)
        return self.status()

    def import_local(self):
        payload = self._local_reader()
        if not payload:
            raise TraeError(404, "未找到已登录的 TRAE CN 账号。", "local_account_not_found")
        return self.import_account(payload)

    def set_enabled(self, account_id, enabled):
        self._path(account_id)
        if not isinstance(enabled, bool):
            raise TraeError(400, "enabled 必须为布尔值。", "invalid_request")
        with self._account_lock(account_id), self._lock:
            row = self._get(account_id)
            row["enabled"] = enabled
            self._save(row)
        return self.status()

    def remove_account(self, account_id):
        self._path(account_id)
        with self._account_lock(account_id), self._lock:
            self._get(account_id)
            backup = self.root / "removed" / (account_id + "." + uuid.uuid4().hex + ".json")
            backup.parent.mkdir(parents=True, exist_ok=True)
            os.replace(self._path(account_id), backup)
        return self.status()

    def _headers(self, credentials, stream=False, raw_chat_function=None):
        version = self._client().get("version") or "3.4.4"
        # Match the current upstream client headers.  The old Trae/<version>
        # user agent can be rate-limited (4011) and may receive an old catalog.
        user_agent = os.environ.get("TRAE_USER_AGENT") or "VSCode 1.107.1 (TRAE SOLO CN)"
        ide_version = os.environ.get("TRAE_IDE_VERSION") or version
        ide_version_code = os.environ.get("TRAE_IDE_VERSION_CODE") or "20260401"
        request_id = uuid.uuid4().hex
        trace_id = uuid.uuid4().hex
        span_id = uuid.uuid4().hex[:16]
        headers = {"Content-Type": "application/json", "Accept": "text/event-stream" if stream else "application/json",
            "User-Agent": user_agent, "Authorization": "Cloud-IDE-JWT " + credentials["token"],
            "X-User-Region": "CN", "Connection": "keep-alive",
            "X-Request-Id": request_id, "X-Custom-Trace-Id": trace_id,
            "X-Flow-Traceparent": "00-%s-%s-01" % (trace_id, span_id)}
        if raw_chat_function:
            headers["X-App-Function"] = raw_chat_function
            headers["X-Ide-Function"] = raw_chat_function
        if credentials.get("deviceId"):
            headers["X-Device-Id"] = credentials["deviceId"]
        headers.update({"X-Cloudide-Token": credentials["token"], "X-Ide-Token": credentials["token"],
            "X-Ide-Version": ide_version, "X-Ide-Version-Type": "stable", "X-Device-Type": "windows",
            "Request-Traffic-Type": "prod", "X-App-Version": "default",
            # Installed official product.json bootConfig.agent.appId / traeVersionCode.
            "X-App-Id": "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
            "X-Ide-Version-Code": ide_version_code, "X-App-Version-Code": ide_version_code,
            "X-Device-Brand": os.environ.get("TRAE_DEVICE_MODEL") or "82RF",
            "X-Device-Cpu": os.environ.get("TRAE_CPU") or "Intel",
            "X-OS-Version": os.environ.get("TRAE_OS_VERSION") or "Windows 10"})
        if raw_chat_function in REMOTE_MODEL_FUNCTIONS:
            headers = remote_catalog_headers(headers)
        if credentials.get("uid"):
            headers["X-Uid"] = credentials["uid"]
        if credentials.get("machineId"):
            headers["X-Machine-Id"] = credentials["machineId"]
        return headers

    def _open(self, url, credentials, body, stream=False, method="POST"):
        _safe_url(url)
        if method not in ("GET", "POST") or (method == "GET" and body is not None):
            raise TraeError(400, "TRAE 请求方法无效。", "invalid_request")
        # Tokens are only ever header values, never URL or query parameters.
        if credentials["token"] in url:
            raise TraeError(400, "TRAE 凭据不得放入请求地址。", "invalid_request")
        raw_chat_function = None
        if isinstance(body, dict):
            # New raw-chat wire names this field explicitly; retain the
            # verified legacy adapter's `function` header binding as well.
            raw_chat_function = body.get("raw_chat_function")
            if not raw_chat_function and url.endswith("/llm_utils_chat"):
                raw_chat_function = body.get("function")
        headers = self._headers(credentials, stream, raw_chat_function)
        if url.endswith("/api/ide/v1/get_detail_param"):
            headers = remote_catalog_headers(headers)
        request = urllib.request.Request(url, data=None if method == "GET" else _compact(body),
                                         headers=headers, method=method)
        try:
            response = self._opener.open(request, timeout=45)
            status = response.getcode()
            if status < 200 or status >= 300:
                response.close()
                raise _upstream_error(status)
            if response.geturl() != url:
                response.close()
                raise TraeError(502, "TRAE 请求重定向已阻止。", "redirect_blocked")
            return response
        except urllib.error.HTTPError as exc:
            try:
                raw = exc.read(_JSON_LIMIT + 1)
                body = json.loads(raw) if len(raw) <= _JSON_LIMIT else None
            except (ValueError, OSError, http.client.HTTPException, RecursionError):
                body = None
            finally:
                exc.close()
            error = _upstream_error(exc.code, body)
            if exc.code == 429:
                try:
                    retry = float(exc.headers.get("Retry-After", "60"))
                    error.retry_after = max(5, min(300, retry)) if math.isfinite(retry) else 60
                except (TypeError, ValueError):
                    error.retry_after = 60
            raise error from None
        except (urllib.error.URLError, OSError, socket.timeout, TimeoutError):
            raise TraeError(502, "无法连接 TRAE 官方服务，未重放请求。", "network_error") from None

    def _json(self, url, credentials, body, method="POST"):
        try:
            with self._open(url, credentials, body, method=method) as response:
                raw = response.read(_JSON_LIMIT + 1)
        except (OSError, urllib.error.URLError, http.client.HTTPException, TimeoutError):
            raise TraeError(502, "TRAE 响应读取失败，未重放请求。", "network_error") from None
        if len(raw) > _JSON_LIMIT:
            raise TraeError(502, "TRAE 响应超出大小限制。", "response_too_large")
        try:
            value = json.loads(raw)
        except (ValueError, UnicodeError, RecursionError):
            raise TraeError(502, "TRAE 返回了无法识别的 JSON。", "invalid_upstream_response") from None
        if not isinstance(value, dict):
            raise TraeError(502, "TRAE 响应结构无效。", "invalid_upstream_response")
        if value.get("code") not in (None, 0, "0"):
            raise _upstream_error(200, value)
        return value

    def _mark_error(self, row, error):
        with self._lock:
            current = self._get(row["id"])
            current["status"] = error.code
            current["lastError"] = error.message
            current["updatedAt"] = int(time.time())
            if error.code == "rate_limited":
                current["cooldownUntil"] = int(time.time() + getattr(error, "retry_after", 60))
            self._save(current)

    def refresh(self, account_id=None):
        rows = [self._get(account_id)] if account_id else self._records()
        if not rows:
            return self.status()
        for candidate in rows:
            with self._account_lock(candidate["id"]):
                row = self._get(candidate["id"])
                try:
                    self._refresh_row(row)
                except TraeError as error:
                    self._mark_error(row, error)
                    if account_id:
                        raise
        return self.status()

    def _refresh_row(self, row):
        self._check_expiry(row)
        credentials = self._credentials(row)
        quota_error = model_error = None
        try:
            value = self._json("https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage", credentials,
                               {"require_usage": True, "req_source": 1})
            credits, details = self._parse_credits(value)
            row["credits"], row["creditDetails"] = credits, details
        except TraeError as error:
            quota_error = error
        try:
            model_error = self._refresh_catalog(row, credentials)
        except TraeError as error:
            model_error = error
        row["quotaError"] = quota_error.message if quota_error else None
        row["modelError"] = model_error.message if model_error else None
        row["updatedAt"] = int(time.time())
        first_error = quota_error or model_error
        row["status"] = "partial" if first_error else "ready"
        row["lastError"] = first_error.message if first_error else None
        if not first_error:
            row["cooldownUntil"] = 0
        with self._lock:
            self._save(row)
        if quota_error and model_error:
            raise quota_error

    def _refresh_remote_catalog(self, row, credentials):
        """Read the live multi-function catalog used by modern TRAE clients.

        The old ``model_list?type=chat`` response is a compatibility fallback
        and is the reason older installations only showed a handful of models.
        Each function is independent: one unavailable function must not hide
        models returned by the other two.
        """
        payloads = []
        errors = []
        for function in REMOTE_MODEL_FUNCTIONS:
            body = remote_catalog_request_body(function)
            try:
                payloads.append(self._json(
                    _AGENT + "/api/ide/v1/get_detail_param", credentials,
                    body, method="POST"))
            except TraeError as error:
                errors.append("%s: %s" % (function, error.code))
        models = normalise_remote_catalog(payloads)
        gateway_models = remote_gateway_models(models)
        if not gateway_models:
            detail = " | ".join(errors) or "没有可用的 function"
            raise TraeError(502, "TRAE 动态模型目录不可用：" + detail,
                            "remote_catalog_unavailable")
        row["models"] = gateway_models
        row["catalogSource"] = "remote_http"
        row["catalogFetchedAt"] = time.time()
        return None

    def _refresh_catalog(self, row, credentials):
        native_error = None
        row["nativeConnected"] = False
        uid = credentials.get("uid", "")
        if getattr(self._native, "configured", False):
            try:
                catalog = self._native.catalog(uid)
                row["models"] = catalog["models"]
                row["catalogSource"] = "native_client"
                row["catalogFetchedAt"] = catalog.get("fetchedAt") if _finite_number(catalog.get("fetchedAt")) else time.time()
                row["nativeConnected"], row["nativeError"] = True, None
                return None
            except NativeBridgeError as error:
                native_error = TraeError(error.status, error.message, error.code)
        row["nativeError"] = native_error.message if native_error else None
        # A current-client cache is directory evidence only. Every cached model
        # still goes through the native UID/catalog/identity checks at chat time.
        cached = self._catalog_reader(uid) if uid else None
        if cached and cached.get("models"):
            row["models"] = [{"upstreamId": m["upstreamId"], "name": m["name"],
                              "route": "native_client", "source": "local_client_cache"} for m in cached["models"]]
            row["catalogSource"], row["catalogFetchedAt"] = "local_client_cache", cached.get("fetchedAt")
            if self._remote_catalog:
                try:
                    return self._refresh_remote_catalog(row, credentials)
                except TraeError:
                    pass
            return native_error or TraeError(503, "当前显示本机缓存目录；使用新模型需从新版桌面程序启动，并运行登录同一账号的 TRAE。", "native_bridge_unavailable")
        if row.get("catalogSource") in ("native_client", "local_client_cache") and row.get("models"):
            # Prefer the modern upstream catalog before retaining a stale native
            # snapshot.  If it is unavailable, never silently fall back to the
            # old five-item endpoint.
            if self._remote_catalog:
                try:
                    return self._refresh_remote_catalog(row, credentials)
                except TraeError:
                    pass
            return native_error or TraeError(503, "保留上次原生模型目录；请运行 TRAE 后刷新，未降级到旧接口。", "native_bridge_unavailable")
        if self._remote_catalog:
            try:
                return self._refresh_remote_catalog(row, credentials)
            except TraeError:
                # A temporarily unavailable modern endpoint should not make an
                # older account impossible to use; retain the legacy fallback.
                pass
        value = self._json(_AGENT + "/api/ide/v1/model_list?type=chat", credentials, None, method="GET")
        configs = value.get("model_configs")
        if not isinstance(configs, list):
            raise TraeError(502, "TRAE 模型响应结构不匹配。", "invalid_upstream_response")
        models = []
        for config in configs:
            if not isinstance(config, dict):
                continue
            if config.get("is_preset") is not True or config.get("status") is not True or config.get("client_connect"):
                continue
            if self._has_custom_connection(config):
                continue
            mid = config.get("name", "")
            if isinstance(mid, str) and _MODEL.fullmatch(mid):
                name = config.get("display_name") or mid
                models.append({"upstreamId": mid, "name": str(name)[:160], "route": "legacy_http", "source": "legacy_http"})
        if not models:
            raise TraeError(502, "TRAE 未返回可用的模型列表。", "empty_models")
        row["models"], row["catalogSource"], row["catalogFetchedAt"] = models, "legacy_http", time.time()
        return native_error

    @staticmethod
    def _has_custom_connection(config):
        def connection(value, depth=0):
            if depth > 8:
                return True
            if isinstance(value, dict):
                for key, field in value.items():
                    if key.lower().replace("_", "").replace("-", "") in (
                            "ak", "apikey", "accesstoken", "token", "baseurl", "apihost", "endpoint", "url") and field:
                        return True
                    if isinstance(field, (dict, list)) and connection(field, depth + 1):
                        return True
            elif isinstance(value, list):
                return any(connection(item, depth + 1) for item in value)
            return False
        # Icons legitimately contain public image URLs; inspect connectivity
        # fields only, never mistake icon metadata for a custom model endpoint.
        connection_keys = ("ak", "apikey", "accesstoken", "token", "baseurl", "apihost", "endpoint", "url")
        if any(key.lower().replace("_", "").replace("-", "") in connection_keys and field
               for key, field in config.items()):
            return True
        custom = config.get("custom_config")
        if isinstance(custom, (dict, list)):
            return connection(custom)
        if isinstance(custom, str) and custom.strip() not in ("", "null"):
            if len(custom) > 64 * 1024:
                return True
            try:
                return connection(json.loads(custom))
            except (ValueError, RecursionError):
                return True
        return False

    @staticmethod
    def _parse_credits(value):
        packs = value.get("user_entitlement_pack_list")
        if not isinstance(packs, list):
            raise TraeError(502, "TRAE 积分响应结构不匹配。", "invalid_upstream_response")
        details = []
        total = 0.0
        for pack in packs:
            if not isinstance(pack, dict):
                continue
            base = pack.get("entitlement_base_info", {})
            quota = base.get("quota", {}) if isinstance(base, dict) else {}
            if not isinstance(quota, dict):
                continue
            usage = pack.get("usage", {})
            limit, used = quota.get("credits_limit"), usage.get("credits_amount", 0) if isinstance(usage, dict) else None
            if not _finite_number(limit) or limit < 0 or not _finite_number(used) or used < 0:
                continue
            remaining = max(0, limit - used)
            # Raw pool total, not a promise of any particular model/Work entitlement.
            total += remaining
            if not _finite_number(total):
                raise TraeError(502, "TRAE 积分统计超出数值范围。", "invalid_upstream_response")
            detail = {"limit": limit, "used": used, "remaining": remaining}
            for key in ("product_type", "start_time", "end_time", "expire_time"):
                field = base.get(key, pack.get(key))
                if isinstance(field, (str, int, float)) and not isinstance(field, bool):
                    detail[key] = field[:160] if isinstance(field, str) else field
            details.append(detail)
        return (total if details else None), details

    def _check_expiry(self, row):
        if not row.get("expiresAt") or row["expiresAt"] > time.time() + 60:
            return
        try:
            credentials = self._credentials(row)
        except TraeError:
            raise
        refresh = credentials.get("refreshToken")
        if not refresh:
            raise TraeError(401, "TRAE 登录已失效，请重新浏览器授权。", "login_expired")
        try:
            refreshed = trae_oauth.refresh_credential(
                str(row.get("region") or "cn"),
                {"refreshToken": refresh,
                 "deviceId": credentials.get("deviceId", ""),
                 "machineId": credentials.get("machineId", ""),
                 "privateKeyPEM": credentials.get("privateKeyPEM", ""),
                 "appVersion": credentials.get("appVersion", "")},
                refresh,
            )
            token = str(refreshed.get("accessToken") or "").strip()
            if not token:
                raise ValueError("empty access token")
            updated = dict(credentials)
            updated["token"] = token
            if refreshed.get("refreshToken"):
                updated["refreshToken"] = str(refreshed["refreshToken"])
            expiry = _expires(refreshed.get("expiresAt"))
            if expiry:
                row["expiresAt"] = expiry
            row["secret"] = self._protect(updated)
            row["status"] = "imported"
            row["lastError"] = None
            row["updatedAt"] = int(time.time())
            self._save(row)
        except Exception as exc:
            raise TraeError(401, "TRAE 登录已失效，请重新浏览器授权。", "login_expired") from exc

    @staticmethod
    def _model_name(payload):
        if not isinstance(payload, dict):
            raise TraeError(400, "请求必须为 JSON 对象。", "invalid_request")
        model = payload.get("model", "")
        if not isinstance(model, str) or not model.startswith("trae/") or not _MODEL.fullmatch(model[5:]):
            raise TraeError(400, "请选择 trae/ 前缀的模型。", "invalid_model")
        return model

    def _payload(self, payload, *, force_framed=None):
        if not isinstance(payload, dict):
            raise TraeError(400, "请求必须为 JSON 对象。", "invalid_request")
        model = self._model_name(payload)
        for key in ("functions", "function_call", "response_format", "modalities", "audio"):
            if key in payload:
                raise TraeError(422, "TRAE 不支持旧版 functions、结构化响应模式或多模态参数。", "unsupported_feature")
        if "stream" in payload and type(payload["stream"]) is not bool:
            raise TraeError(400, "stream 必须为布尔值。", "invalid_request")
        stream_options = payload.get("stream_options")
        if stream_options is not None and (not isinstance(stream_options, dict)
                or set(stream_options) - {"include_usage"}
                or ("include_usage" in stream_options and type(stream_options["include_usage"]) is not bool)):
            raise TraeError(400, "stream_options 仅支持布尔 include_usage。", "invalid_request")
        if payload.get("n", 1) != 1:
            raise TraeError(422, "TRAE 首版仅支持 n=1。", "unsupported_feature")
        try:
            tool_plan = prepare_tools(payload, force_framed=force_framed)
        except ToolBridgeError as error:
            raise TraeError(error.status, error.message, error.code, extra=error.extra) from None
        messages = payload.get("messages")
        if not isinstance(messages, list) or not messages or len(messages) > 256:
            raise TraeError(400, "messages 必须为 1 至 256 条文本消息。", "invalid_messages")
        converted = []
        for message in (tool_plan.messages if tool_plan else messages):
            if not isinstance(message, dict) or message.get("role") not in ("system", "developer", "user", "assistant"):
                raise TraeError(422, "TRAE 仅接受文本消息及有效的工具调用往返。", "unsupported_feature")
            if any(key in message for key in ("tool_calls", "tool_call_id", "function_call")):
                raise TraeError(422, "TRAE 工具历史格式无效。", "unsupported_feature")
            content = message.get("content")
            if isinstance(content, list):
                if not all(isinstance(x, dict) and x.get("type") == "text" and isinstance(x.get("text"), str) for x in content):
                    raise TraeError(422, "TRAE 首版不支持图片或其他非文本内容。", "unsupported_feature")
                content = "".join(x["text"] for x in content)
            if not isinstance(content, str):
                raise TraeError(400, "消息 content 必须为文本。", "invalid_messages")
            role = "system" if message["role"] == "developer" else message["role"]
            converted.append({"role": role, "content": [{"type": "text", "text": content}]})
        # Verified TRAE CN IDE wire: chat_v3 + model only. A SOLO-style
        # config_name causes 4001 on this endpoint.
        body = {"model": model[5:], "function": "chat_v3", "stream": True,
                "messages": converted, "max_tokens": 512}
        numeric_payload = payload.copy()
        if "max_completion_tokens" in payload:
            if "max_tokens" in payload and payload["max_tokens"] != payload["max_completion_tokens"]:
                raise TraeError(400, "max_tokens 与 max_completion_tokens 不得冲突。", "invalid_request")
            numeric_payload["max_tokens"] = payload["max_completion_tokens"]
        for key in ("temperature", "top_p", "max_tokens"):
            if key in numeric_payload:
                number = numeric_payload[key]
                if not _finite_number(number):
                    raise TraeError(400, key + " 必须为有限数字。", "invalid_request")
                if ((key == "temperature" and not 0 <= number <= 2) or
                    (key == "top_p" and not 0 <= number <= 1) or
                    (key == "max_tokens" and (not isinstance(number, int) or not 1 <= number <= 65536))):
                    raise TraeError(400, key + " 超出支持范围。", "invalid_request")
                body[key] = number
        # The 2 MiB ceiling applies only to the normalized text/tool envelope.
        # Inline image bytes remain private in _images and are governed by the
        # 16 MiB input limit in wb_trae_images, not duplicated into this body.
        if len(_compact(body)) > 2 * 1024 * 1024:
            raise TraeError(413, "TRAE 文本请求体超过 2 MiB。", "request_too_large")
        if tool_plan:
            # Private in-memory plan; never send this object to either upstream.
            body["_tool_plan"] = tool_plan
            if tool_plan.images:
                body["_images"] = tool_plan.images
        return model, body

    def _choose(self, model):
        with self._lock:
            now = time.time()
            candidates = [r for r in self._records() if r.get("enabled") and
                (not r.get("expiresAt") or r["expiresAt"] > now + 10) and
                r.get("status") != "login_expired" and r.get("cooldownUntil", 0) <= now and
                any(m.get("upstreamId") == model[5:] for m in r.get("models", []))]
            if not candidates:
                raise TraeError(503, "没有已启用且支持此模型的 TRAE 账号，请先刷新模型。", "no_available_account")
            row = candidates[self._cursor % len(candidates)]
            self._cursor += 1
            return row

    def stream(self, payload):
        # Validate the full request before account selection, preserving the
        # historical error precedence for malformed payloads.  After the
        # selected account is known, rebuild only remote DeepSeek text requests
        # without the native framed envelope: the upstream HTTP endpoint wants
        # ordinary chat messages while native DeepSeek still uses V2 framing.
        model, body = self._payload(payload)
        row = self._choose(model)
        config = next((item for item in row.get("models", [])
                       if item.get("upstreamId") == model[5:]), {})
        if config.get("route") == "remote_http":
            model, body = self._payload(payload, force_framed=False)
        return self._tracked_stream(row, model, body)

    def _tracked_stream(self, row, model, body):
        started = time.monotonic()
        usage = None
        usage_source = None
        try:
            for chunk in self._stream(row, model, body):
                if isinstance(chunk, dict) and isinstance(chunk.get("usage"), dict):
                    usage = chunk["usage"]
                if isinstance(chunk, dict) and isinstance(chunk.get("provider_metadata"), dict):
                    source = chunk["provider_metadata"].get("usage_source")
                    if source in ("upstream", "estimated", "missing"):
                        usage_source = source
                yield chunk
        except TraeError as error:
            self._record_request(row, model, body, started, usage=usage,
                                 usage_source=usage_source, outcome="error", error=error.code)
            raise
        except Exception:
            self._record_request(row, model, body, started, usage=usage,
                                 usage_source=usage_source, outcome="error", error="internal_error")
            raise
        else:
            self._record_request(row, model, body, started, usage=usage,
                                 usage_source=usage_source, outcome="completed")

    def _stream(self, row, model, body):
        with self._account_lock(row["id"]):
            row = self._get(row["id"])
            if not row.get("enabled"):
                raise TraeError(503, "TRAE 账号已禁用。", "account_disabled")
            self._check_expiry(row)
            if row.get("status") == "login_expired":
                raise TraeError(401, "TRAE 登录已失效，请在 TRAE 内刷新后重新同步。", "login_expired")
            if row.get("cooldownUntil", 0) > time.time():
                raise TraeError(429, "TRAE 账号正在限流冷却，请稍后再试。", "rate_limited")
            if not any(m.get("upstreamId") == model[5:] for m in row.get("models", [])):
                raise TraeError(503, "TRAE 模型列表已更新，请重新选择可用模型。", "model_unavailable")
            config = next(m for m in row["models"] if m["upstreamId"] == model[5:])
            if config.get("route") == "native_client":
                yield from self._native_stream(row, model, body)
                return
            if config.get("route") == "remote_http" and config.get("upstreamModel"):
                # Modern get_detail_param entries keep the public model id, but
                # the direct llm_utils_chat endpoint still wants its stable
                # provider config for a small set of aliases.
                body = dict(body)
                body["model"] = config["upstreamModel"]
            if body.get("_images"):
                raise TraeError(422, "图片输入需要 TRAE 原生客户端路由。", "image_not_supported")
            if body.get("_tool_plan"):
                raise TraeError(422, "工具桥接需要 TRAE 原生客户端模型，请刷新目录并选择新模型。", "tools_require_native_client")
            credentials = self._credentials(row)
            response_id = "chatcmpl-trae-" + uuid.uuid4().hex
            created = int(time.time())

            def chunk(delta, finish=None, usage=None):
                result = {"id": response_id, "created": created, "object": "chat.completion.chunk",
                    "model": model, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                if usage is not None:
                    result["usage"] = usage
                return result

            sent_role = False
            usage = None
            # The upstream has been observed to ignore max_tokens. Bound local
            # forwarded text so a malformed/ignoring stream cannot consume
            # unbounded memory or credits; abort without replay or fake DONE.
            try:
                requested_tokens = int(body.get("max_tokens", 512))
            except (TypeError, ValueError, OverflowError):
                requested_tokens = 512
            output_budget = max(256, min(4 * 1024 * 1024, requested_tokens * 16))
            output_chars = 0
            try:
                with self._open(_AGENT + "/api/agent/v3/llm_utils_chat", credentials, body, True) as response:
                    ctype = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
                    if ctype != "text/event-stream":
                        raw = response.read(_JSON_LIMIT + 1)
                        try:
                            value = json.loads(raw) if len(raw) <= _JSON_LIMIT else None
                        except (ValueError, UnicodeError, RecursionError):
                            value = None
                        raise _upstream_error(200, value)
                    for event, value in iter_sse(response):
                        if event == "error" or value.get("error"):
                            raise _upstream_error(200, value)
                        if event == "output":
                            if value.get("tool_calls"):
                                raise TraeError(502, "TRAE 返回了首版尚不支持的工具调用。", "unsupported_upstream_feature")
                            delta = {}
                            for source, dest in (("response", "content"), ("content", "content"),
                                                 ("text", "content"),
                                                 ("reasoning_content", "reasoning_content"),
                                                 ("reasoning", "reasoning_content")):
                                part = value.get(source)
                                if part is not None and not isinstance(part, str):
                                    raise TraeError(502, "TRAE 输出内容结构无效。", "invalid_upstream_response")
                                if part:
                                    output_chars += len(part)
                                    if output_chars > output_budget:
                                        raise TraeError(502, "TRAE 输出超过本地大小限制，未重放请求。", "output_limit")
                                    delta[dest] = part
                            if delta:
                                if not sent_role:
                                    yield chunk({"role": "assistant"})
                                    sent_role = True
                                yield chunk(delta)
                        elif event == "token_usage":
                            usage_value = value.get("data") if isinstance(value.get("data"), dict) else value
                            usage = {}
                            for target, names in (("prompt_tokens", ("prompt_tokens", "input_tokens", "promptTokens", "inputTokens")),
                                                  ("completion_tokens", ("completion_tokens", "output_tokens", "completionTokens", "outputTokens")),
                                                  ("total_tokens", ("total_tokens", "totalTokens"))):
                                for name in names:
                                    candidate = usage_value.get(name)
                                    if isinstance(candidate, int) and not isinstance(candidate, bool) and candidate >= 0:
                                        usage[target] = candidate
                                        break
                            if "total_tokens" not in usage:
                                total = usage.get("prompt_tokens", 0) + usage.get("completion_tokens", 0)
                                if total:
                                    usage["total_tokens"] = total
                        elif event == "done":
                            done_value = value.get("data") if isinstance(value.get("data"), dict) else value
                            reason = done_value.get("finish_reason", done_value.get("stop_reason", "stop"))
                            if reason not in ("stop", "length", "content_filter"):
                                raise TraeError(502, "TRAE 对话结束状态不受支持。", "invalid_upstream_response")
                            if not sent_role:
                                yield chunk({"role": "assistant"})
                            with self._lock:
                                row["status"] = "partial" if row.get("quotaError") or row.get("modelError") else "ready"
                                row["lastError"] = row.get("quotaError") or row.get("modelError")
                                row["cooldownUntil"] = 0
                                row["updatedAt"] = int(time.time())
                                self._save(row)
                            yield chunk({}, reason, usage)
                            return
                        elif event in ("metadata", "timing_cost", "extra_info"):
                            # The modern TRAE stream includes bookkeeping
                            # frames around the actual output.  They are not
                            # assistant deltas and must not turn a valid
                            # response into invalid_upstream_response.
                            continue
                    raise TraeError(502, "TRAE 对话流意外中断，未重放请求。", "incomplete_stream")
            except (OSError, urllib.error.URLError, http.client.HTTPException, socket.timeout, TimeoutError):
                error = TraeError(502, "TRAE 对话连接中断，未重放请求。", "network_error")
                self._mark_error(row, error)
                raise error from None
            except TraeError as error:
                self._mark_error(row, error)
                raise

    def _native_stream(self, row, model, body):
        if any(key in body for key in ("temperature", "top_p")):
            raise TraeError(422, "原生文本桥接未提供 temperature/top_p 控制，请移除这两个参数。", "unsupported_feature")
        credentials = self._credentials(row)
        # Character budget floor of 8192 so a small max_tokens can never trap
        # the native client below a single reasoning pass; reasoning is checked
        # separately in wb_trae_native and does not eat the response budget.
        max_chars = max(8192, min(65536, int(body.get("max_tokens", 512)) * 16))
        try:
            options = {"images": body["_images"]} if body.get("_images") else {}
            value = self._native.chat(credentials.get("uid", ""), model[5:], body["messages"], max_chars=max_chars, **options)
        except NativeBridgeError as error:
            failure = TraeError(error.status, error.message, error.code, extra=error.extra)
            self._mark_error(row, failure)
            raise failure from None
        plan = body.get("_tool_plan")
        parsed = None
        if plan:
            try:
                parsed = plan.parse(value["response"])
            except ToolBridgeError as error:
                failure = TraeError(error.status, error.message, error.code, extra=error.extra)
                self._mark_error(row, failure)
                raise failure from None
        response_id, created = "chatcmpl-trae-" + uuid.uuid4().hex, int(time.time())
        metadata = {"route": "native_client", "streaming": "buffered", "upstream_model": value["upstreamModel"]}
        if value.get("usageEstimated") is True:
            metadata["usage_estimated"] = True
            metadata["usage_source"] = "estimated"
        if plan:
            metadata["tool_calling"] = "structured_text"
            metadata["tool_execution"] = "client"
            if parsed.get("response_format") in ("plain_text_final", "single_outer_close_final", "framed_json_v2"):
                metadata["response_format"] = parsed["response_format"]
        trim = (plan.trim_level if plan else 0) or value.get("context_trim", 0)
        if trim:
            metadata["context_trim"] = trim

        def chunk(delta, finish=None, usage=None):
            result = {"id": response_id, "created": created, "object": "chat.completion.chunk", "model": model,
                      "provider_metadata": metadata, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            if usage is not None:
                result["usage"] = usage
            return result

        with self._lock:
            row["status"] = "partial" if row.get("quotaError") or row.get("modelError") else "ready"
            row["lastError"] = row.get("quotaError") or row.get("modelError")
            row["cooldownUntil"], row["updatedAt"] = 0, int(time.time())
            self._save(row)
        yield chunk({"role": "assistant"})
        if value.get("reasoning_content"):
            yield chunk({"reasoning_content": value["reasoning_content"]})
        # Compatibility SSE is buffered native text, not native token streaming.
        if parsed is None:
            yield chunk({"content": value["response"]})
        else:
            if parsed["content"]:
                yield chunk({"content": parsed["content"]})
            for index, call in enumerate(parsed["tool_calls"]):
                yield chunk({"tool_calls": [{"index": index, **call}]})
        yield chunk({}, parsed["finish_reason"] if parsed else "stop", value.get("usage", {}))

    def chat(self, payload):
        chunks = self.stream(payload)
        result = None
        text = []
        reasoning = []
        tool_calls = {}
        finish = None
        usage = None
        for chunk in chunks:
            if result is None:
                result = {"id": chunk["id"], "created": chunk["created"], "model": chunk["model"], "object": "chat.completion"}
                if chunk.get("provider_metadata"):
                    result["provider_metadata"] = chunk["provider_metadata"]
            if chunk.get("usage"):
                usage = chunk["usage"]
            for choice in chunk.get("choices", []):
                delta = choice.get("delta", {})
                text.append(delta.get("content") or "")
                reasoning.append(delta.get("reasoning_content", ""))
                for call in delta.get("tool_calls", []):
                    target = tool_calls.setdefault(call["index"], {"id": "", "type": "function",
                        "function": {"name": "", "arguments": ""}})
                    target["id"] += call.get("id", "")
                    target["function"]["name"] += call.get("function", {}).get("name", "")
                    target["function"]["arguments"] += call.get("function", {}).get("arguments", "")
                finish = choice.get("finish_reason") or finish
        if result is None or finish is None:
            raise TraeError(502, "TRAE 对话未完整结束，未重放请求。", "incomplete_stream")
        message = {"role": "assistant", "content": "".join(text) or (None if tool_calls else "")}
        if tool_calls:
            message["tool_calls"] = [tool_calls[index] for index in sorted(tool_calls)]
        if any(reasoning):
            message["reasoning_content"] = "".join(reasoning)
        result["choices"] = [{"index": 0, "message": message, "finish_reason": finish}]
        if usage is not None:
            result["usage"] = usage
        return result
