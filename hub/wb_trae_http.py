"""HTTP boundary for the independently stored TRAE provider.

The existing gateway owns API-key checks and chat concurrency. Management
stays on loopback, uses the existing panel session, and never returns tokens.
"""
import ipaddress
import json
from pathlib import Path
import threading
from urllib.parse import urlsplit

import wb_trae

PREFIX = "/providers/trae"
CHAT_PATHS = ("/v1/chat/completions", "/chat/completions")
_PROVIDERS = {}
_PROVIDERS_LOCK = threading.Lock()


def provider_for(accounts_dir):
    root = str(Path(accounts_dir).resolve().parent)
    with _PROVIDERS_LOCK:
        if root not in _PROVIDERS:
            # Use the live TRAE catalog adapter in the desktop gateway. Unit
            # tests may still instantiate TraeProvider with the legacy switch
            # disabled to exercise the old endpoint deterministically.
            _PROVIDERS[root] = wb_trae.TraeProvider(root, remote_catalog=True)
        return _PROVIDERS[root]


def _json(handler, status, value):
    body = json.dumps(value, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)
    handler.wfile.flush()


def _error(handler, status, message, code="trae_error"):
    handler._handle_expect_continue()
    handler._discard_body()
    return _json(handler, status, {"error": {"message": message,
                                           "type": "provider_error", "code": code}})


def _callback_url(handler):
    """Return the exact loopback callback shape accepted by TRAE."""
    try:
        port = int(handler.server.server_address[1])
    except (AttributeError, TypeError, ValueError):
        port = 0
    return "http://127.0.0.1:%d/authorize" % port if port else ""


def oauth_callback(handler, query, provider):
    """Handle TRAE's public browser redirect without exposing credentials."""
    params = {}
    for key, values in (query or {}).items():
        params[str(key)] = (values[-1] if isinstance(values, list) and values
                            else values)
    result = provider.complete_oauth_login(params)
    ok = bool(result.get("ok"))
    title = "TRAE 授权成功" if ok else "TRAE 授权失败"
    message = ("账号已加入 TRAE 账号池，可以关闭此页回到网关。"
               if ok else str(result.get("error") or "授权失败，请回到网关重试。"))
    color = "#31d07c" if ok else "#ff6677"
    icon = "✓" if ok else "×"
    body = ("<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            "<title>%s</title></head><body style=\"margin:0;background:#0b111a;color:#eef5ff;"
            "font-family:Segoe UI,Microsoft YaHei,sans-serif;display:flex;min-height:100vh;"
            "align-items:center;justify-content:center\"><main style=\"width:min(520px,calc(100%% - 36px));"
            "padding:38px 32px;border:1px solid #26364a;border-radius:18px;background:#111b29;"
            "text-align:center;box-shadow:0 18px 60px #0008\"><div style=\"font-size:48px;"
            "color:%s\">%s</div><h1 style=\"font-size:22px;margin:12px 0;color:%s\">%s</h1>"
            "<p style=\"line-height:1.8;color:#a9b7c8;margin:0\">%s</p>"
            "<p style=\"font-size:12px;color:#6f8094;margin-top:24px\">TRAE 浏览器授权 · 可安全关闭此页</p>"
            "</main></body></html>" % (
                title, color, icon, color, title, message))
    data = body.encode("utf-8")
    handler.send_response(200 if ok else 400)
    handler.send_header("Content-Type", "text/html; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(data)
    handler.wfile.flush()


def _local_management(handler, write=False):
    try:
        local = ipaddress.ip_address(handler.client_address[0]).is_loopback
    except ValueError:
        local = False
    if not local:
        _error(handler, 403, "TRAE account management is available on this computer only", "local_only")
        return False
    try:
        hostname = urlsplit("http://" + handler.headers.get("Host", "")).hostname
        if hostname not in ("localhost", "127.0.0.1", "::1"):
            raise ValueError("not a local host")
    except ValueError:
        _error(handler, 403, "provider management requires a loopback Host", "local_only")
        return False
    if not handler._panel_ok():
        handler._error(401, "panel password required", "invalid_request_error")
        return False
    if write:
        origin = handler.headers.get("Origin")
        if origin:
            try:
                parsed = urlsplit(origin)
            except ValueError:
                handler._error(403, "invalid origin", "invalid_request_error")
                return False
            host = handler.headers.get("Host", "")
            if parsed.scheme not in ("http", "https") or parsed.netloc != host:
                handler._error(403, "cross-origin provider management is not allowed", "invalid_request_error")
                return False
        if handler.headers.get("Sec-Fetch-Site", "") == "cross-site":
            handler._error(403, "cross-site provider management is not allowed", "invalid_request_error")
            return False
    return True


def management(handler, path, provider, write=False):
    if not _local_management(handler, write):
        return
    try:
        if not write:
            if path == PREFIX:
                return _json(handler, 200, provider.status())
            if path == PREFIX + "/login/poll":
                query = urlsplit("http://localhost" + handler.path).query
                from urllib.parse import parse_qs
                values = parse_qs(query, keep_blank_values=True)
                state = (values.get("state") or [""])[-1]
                return _json(handler, 200, provider.poll_oauth_login(state))
            return _error(handler, 404, "provider route not found", "not_found")
        payload = handler._payload_or_error()
        if payload is None:
            return
        actions = {
            PREFIX + "/login/start": lambda: provider.start_oauth_login(
                _callback_url(handler), payload.get("realm") or "cn"),
            PREFIX + "/login/cancel": lambda: {
                "cancelled": provider.cancel_oauth_login(payload.get("state"))},
            PREFIX + "/import": lambda: provider.import_account(payload),
            PREFIX + "/scan": provider.import_local,
            PREFIX + "/refresh": lambda: provider.refresh(payload.get("id")),
            PREFIX + "/toggle": lambda: provider.set_enabled(payload.get("id"), payload.get("enabled")),
            PREFIX + "/remove": lambda: provider.remove_account(payload.get("id")),
        }
        action = actions.get(path)
        if action is None:
            return _error(handler, 404, "provider route not found", "not_found")
        return _json(handler, 200, action())
    except wb_trae.TraeError as exc:
        # These errors belong to the upstream account, not the local panel
        # session. The existing UI treats HTTP 401/403 as panel logout.
        status = 409 if exc.status in (401, 403) else exc.status
        return _error(handler, status, exc.message, exc.code)
    except (BrokenPipeError, ConnectionError):
        handler.close_connection = True
    except Exception:
        # An exception may contain an upstream response or a local path.
        return _error(handler, 500, "TRAE provider operation failed", "internal_error")


def chat(handler, path, payload, provider):
    if path not in CHAT_PATHS:
        return _error(handler, 400, "TRAE currently accepts Chat Completions requests only", "unsupported_endpoint")
    try:
        if not payload.get("stream", False):
            return _json(handler, 200, provider.chat(payload))
        chunks = iter(provider.stream(payload))
        # Surface auth/model/transport failures as HTTP errors, before a 200.
        try:
            first = next(chunks)
        except StopIteration:
            return _error(handler, 502, "TRAE returned an empty stream", "empty_stream")
    except wb_trae.TraeError as exc:
        return _error(handler, exc.status, exc.message, exc.code)
    except Exception:
        return _error(handler, 502, "TRAE upstream request failed", "upstream_error")

    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Connection", "close")
    handler.end_headers()
    handler.close_connection = True

    def event(value):
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        handler.wfile.write(("data: " + encoded + "\n\n").encode("utf-8"))
        handler.wfile.flush()

    try:
        event(first)
        for chunk in chunks:
            event(chunk)
        handler.wfile.write(b"data: [DONE]\n\n")
        handler.wfile.flush()
    except wb_trae.TraeError as exc:
        try:
            event({"error": {"message": exc.message, "type": "provider_error", "code": exc.code}})
        except (BrokenPipeError, ConnectionError):
            pass
    except (BrokenPipeError, ConnectionError):
        pass
    except Exception:
        try:
            event({"error": {"message": "TRAE stream interrupted", "type": "provider_error", "code": "stream_error"}})
        except (BrokenPipeError, ConnectionError):
            pass
    finally:
        close = getattr(chunks, "close", None)
        if close:
            close()
