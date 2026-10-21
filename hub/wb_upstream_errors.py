"""Bounded, allowlisted diagnostics for WorkBuddy upstream rejections.

This module classifies an error response only. It does not alter, retry or
route requests, and never returns the upstream's arbitrary response fields.
"""
import json
import re


MAX_ERROR_DETAIL = 8192
_REQUEST_ID = re.compile(r"(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})", re.ASCII)
_MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,127}", re.ASCII)
_CHANNEL_MESSAGE = (
    "WorkBuddy 上游拒绝了本次请求的渠道校验（11128）。这不等于余额不足，"
    "重新发送也不一定成功；请在官方 WorkBuddy 客户端使用同一模型核对。"
)


def classify_workbuddy_error(status, detail, model=None):
    """Return an OpenAI error inner object for a confirmed HTTP400/11128.

    Only a complete JSON object with the explicit top-level upstream code is
    authoritative. Truncated JSON, prose, nested metadata and other statuses
    are deliberately not inferred. The caller retains its existing fallback.
    """
    if type(status) is not int or status != 400:
        return None
    if not isinstance(detail, str) or len(detail) > MAX_ERROR_DETAIL:
        return None
    try:
        payload = json.loads(detail)
    except (ValueError, TypeError, RecursionError):
        return None
    if not isinstance(payload, dict):
        return None
    code = payload.get("code")
    if not ((type(code) is int and code == 11128)
            or (isinstance(code, str) and code in ("11128", "11-128"))):
        return None
    result = {
        "message": _CHANNEL_MESSAGE,
        "type": "invalid_request_error",
        "code": "upstream_channel_rejected",
        "provider": "workbuddy",
        "upstream_code": 11128,
    }
    request_id = payload.get("requestId")
    if isinstance(request_id, str) and len(request_id) <= 36 and _REQUEST_ID.fullmatch(request_id):
        result["upstream_request_id"] = request_id
    if isinstance(model, str) and len(model) <= 128 and _MODEL.fullmatch(model):
        result["model"] = model
    return result


def read_http_error_detail(exc, limit=MAX_ERROR_DETAIL):
    """Read at most ``limit`` bytes once; never request an unbounded read.

    UTF-8 replacement preserves an inspectable error string if the byte cap
    cuts a multibyte character. An incomplete JSON body remains unclassified.
    Transport/read errors are left to the caller rather than silently hidden.
    """
    if type(limit) is not int or not 1 <= limit <= MAX_ERROR_DETAIL:
        raise ValueError("error detail limit must be an integer from 1 to 8192")
    raw = exc.read(limit)
    if not isinstance(raw, bytes):
        raise TypeError("HTTP error body must be bytes")
    return raw[:limit].decode("utf-8", "replace")
