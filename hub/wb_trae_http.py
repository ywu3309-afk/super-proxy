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
            _PROVIDERS[root] = wb_trae.TraeProvider(root)
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
            if path != PREFIX:
                return _error(handler, 404, "provider route not found", "not_found")
            return _json(handler, 200, provider.status())
        payload = handler._payload_or_error()
        if payload is None:
            return
        actions = {
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
