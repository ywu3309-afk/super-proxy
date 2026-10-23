"""HTTP boundary for the standalone external-channel registry."""

import ipaddress
import json
from urllib.parse import urlsplit

import wb_external

PREFIX = "/providers/external"


def _json(handler, status, value):
    body = json.dumps(value, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)
    handler.wfile.flush()


def _error(handler, status, message, code="external_error"):
    handler._handle_expect_continue()
    handler._discard_body()
    return _json(handler, status, {"error": {"message": message, "type": "provider_error", "code": code}})


def _local_management(handler, write=False):
    try:
        local = ipaddress.ip_address(handler.client_address[0]).is_loopback
    except ValueError:
        local = False
    if not local:
        _error(handler, 403, "第三方通道管理仅允许本机访问", "local_only")
        return False
    try:
        hostname = urlsplit("http://" + handler.headers.get("Host", "")).hostname
    except ValueError:
        hostname = None
    if hostname not in ("localhost", "127.0.0.1", "::1"):
        _error(handler, 403, "第三方通道管理要求 loopback Host", "local_only")
        return False
    if not handler._panel_ok():
        handler._error(401, "panel password required", "invalid_request_error")
        return False
    if write and handler.headers.get("Sec-Fetch-Site", "") == "cross-site":
        handler._error(403, "cross-site provider management is not allowed", "invalid_request_error")
        return False
    return True


def management(handler, path, store, write=False):
    if not _local_management(handler, write):
        return
    try:
        if not write:
            if path != PREFIX:
                return _error(handler, 404, "第三方通道路由不存在", "not_found")
            return _json(handler, 200, {"channels": store.list(), "pool_mode": "standalone"})
        payload = handler._payload_or_error()
        if payload is None:
            return
        if path == PREFIX + "/save":
            result = store.save(payload)
        elif path == PREFIX + "/delete":
            result = store.delete(payload.get("id"))
        elif path == PREFIX + "/toggle":
            result = store.toggle(payload.get("id"), payload.get("enabled"))
        elif path == PREFIX + "/probe":
            result = store.probe(payload.get("id"))
        elif path == PREFIX + "/models/save":
            result = store.save_model(payload)
        elif path == PREFIX + "/models/delete":
            result = store.delete_model(payload.get("channel_id"), payload.get("model_id"))
        else:
            return _error(handler, 404, "第三方通道路由不存在", "not_found")
        return _json(handler, 200, result)
    except wb_external.ExternalError as exc:
        return _error(handler, exc.status, exc.message, exc.code)
    except Exception:
        return _error(handler, 500, "第三方通道操作失败", "internal_error")

