"""Private loopback client for the desktop-owned TRAE native text bridge.

Only an ephemeral desktop bearer is sent here, never the TRAE access token.
No proxies, redirects, retries, or cross-account fallback are used.
"""
import http.client
import json
import os
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
import unicodedata


_LIMIT = 1024 * 1024
_REQUEST_LIMIT = 16 * 1024 * 1024
_NATIVE_PROMPT_LIMIT = 65536
_NATIVE_PROMPT_BUDGET = 60000
_HISTORY_NOTICE = "Earlier conversation turns were omitted to fit the native TRAE context limit. Use the retained system instructions and latest user request."
_REQUEST_TOO_LARGE_SUGGEST = "该通道上限 60000 字符，请精简系统提示或改用 workbuddy 模型。"
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$")
_CJK_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf]")
_ERRORS = {
    "BAD_REQUEST": (400, "invalid_request", "TRAE 原生桥接请求格式无效。"),
    "BUSY": (429, "native_busy", "TRAE 本机桥接正在处理其他请求，请稍后再试。"),
    "TIMEOUT": (504, "stream_timeout", "TRAE 原生请求超时，未将不完整结果作为成功返回，未重放请求。"),
    "UID_MISMATCH": (409, "wrong_current_account", "TRAE 当前登录账号与网关所选账号不一致，请切换至相同账号后刷新。"),
    "TRAE_NOT_RUNNING": (503, "trae_not_running", "请先运行官方 TRAE CN，并登录网关所选的同一个账号。"),
    "RENDERER_BUSY": (503, "renderer_busy", "TRAE 窗口已有调试连接，请关闭该调试连接后重试。"),
    "WINDOW_NOT_FOUND": (503, "native_window_not_found", "请打开一个 TRAE 工作窗口后重试。"),
    "MODULE_NOT_FOUND": (503, "native_module_not_found", "当前 TRAE 窗口的原生模块不可用，请打开工作窗口后重试。"),
    "INSPECTOR_BUSY": (503, "native_inspector_busy", "TRAE 临时调试端口被其他进程占用。"),
    "INSPECTOR_UNAVAILABLE": (503, "native_inspector_unavailable", "无法连接当前 TRAE 原生运行时。"),
    "INSPECTOR_CLEANUP_FAILED": (503, "native_cleanup_failed", "TRAE 临时运行时连接未完成清理，未重放请求。"),
    "STOP_FAILED": (502, "stop_failed", "TRAE 停止请求未确认完成，未重放请求。"),
    "OUTPUT_LIMIT": (502, "output_limit", "TRAE 输出达到本地限制，已停止请求，未重放。"),
    "EVENT_LIMIT": (502, "response_too_large", "TRAE 事件达到本地限制，已停止请求，未重放。"),
    "TOOL_NOT_ALLOWED": (422, "unsupported_upstream_feature", "原生文本桥接出现非 finish 工具调用，已停止请求。"),
    "UPSTREAM_MODEL_MISMATCH": (502, "upstream_model_mismatch", "TRAE 实际模型配置与所选模型不一致，已停止请求。"),
    "UPSTREAM_MODEL_UNCONFIRMED": (502, "upstream_model_unconfirmed", "TRAE 未确认实际模型配置，未作为成功回答返回。"),
    "MODEL_UNAVAILABLE": (503, "model_unavailable", "所选模型不在当前 TRAE 原生目录中，请刷新模型。"),
    "IMAGE_NOT_SUPPORTED": (422, "image_not_supported", "当前 TRAE 模型未声明图片能力。"),
    "IMAGE_UPLOAD_FAILED": (502, "image_upload_failed", "图片上传失败，未开始模型生成。"),
    "NATIVE_CLIENT_UNAVAILABLE": (503, "native_client_unavailable", "当前 TRAE 原生客户端不可用，请重新打开工作窗口。"),
    "CATALOG_UNAVAILABLE": (503, "catalog_unavailable", "TRAE 未返回可用的原生模型目录。"),
    "INCOMPLETE_RESPONSE": (502, "incomplete_stream", "TRAE 原生响应未完整结束，未重放请求。"),
    "EMPTY_RESPONSE": (502, "empty_stream", "TRAE 未返回有效文本，未作为成功回答返回。"),
    "UPSTREAM_ERROR": (502, "upstream_error", "TRAE 原生对话失败，停止流程已执行，未重放请求。"),
}


class NativeBridgeError(Exception):
    def __init__(self, status, code, message, extra=None):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message
        self.extra = extra if isinstance(extra, dict) else None


def _failure(code):
    return NativeBridgeError(*_ERRORS.get(code, (502, "native_request_failed", "TRAE 原生操作未完成，未重放请求。")))


def _utf16_length(value):
    """Return the JavaScript/TRAE native UTF-16 code-unit length."""
    return len(value.encode("utf-16-le")) // 2


def _estimate_tokens(value):
    """Estimate token count when the native TRAE client omits usage.

    TRAE's native renderer does not always emit a ``token_usage`` event.  The
    OpenAI-compatible surface still needs a useful non-zero usage value for
    clients such as DSH, so use the same conservative text heuristic as the
    gateway's other provider paths.  The caller labels this value as estimated;
    it is never presented as an upstream billing figure.
    """
    if not value:
        return 0
    if not isinstance(value, str):
        value = str(value)
    cjk = len(value) - len(_CJK_RE.sub("", value))
    other = len(value) - cjk
    return cjk + max(1, int(other / 3.6))


def _native_history_prompt(history):
    return ("以下 JSON 数组是完整对话记录，role 表示消息角色。遵循 system 消息，基于记录仅回答最后的 user 消息，"
            "不要复述记录，不调用 TRAE 内置工具。若记录要求输出外部工具协议 JSON，只生成该 JSON 文本，"
            "工具由外部客户端执行。\n" + json.dumps(history, ensure_ascii=False, separators=(",", ":")))


def _head_units(text, units):
    """Prefix of `text` within `units` UTF-16 code units, never splitting a pair."""
    used = 0
    for index, char in enumerate(text):
        step = _utf16_length(char)
        if used + step > units:
            return text[:index]
        used += step
    return text


def _tail_units(text, units):
    """Suffix of `text` within `units` UTF-16 code units, never splitting a pair."""
    used = 0
    for index in range(len(text) - 1, -1, -1):
        step = _utf16_length(text[index])
        if used + step > units:
            return text[index + 1:]
        used += step
    return text


def _middle_truncated(text, keep):
    """Keep head (2/3) and tail (1/3) of `text` within `keep` UTF-16 units."""
    marker_format = "\n…[系统提示中段已省略 {omitted} 字符]…\n"
    if keep >= _utf16_length(text):
        return text
    probe = marker_format.format(omitted=0)
    marker_units = _utf16_length(probe)
    if keep <= marker_units:
        return _head_units(text, keep)
    head_units = (keep - marker_units) * 2 // 3
    tail_units = keep - marker_units - head_units
    head_text = _head_units(text, head_units)
    tail_text = _tail_units(text, tail_units)
    marker = marker_format.format(omitted=max(len(text) - len(head_text) - len(tail_text), 0))
    result = head_text + marker + tail_text
    if _utf16_length(result) > keep:
        overflow = _utf16_length(result) - keep
        result = head_text + marker + _tail_units(tail_text, max(0, _utf16_length(tail_text) - overflow))
    return result


def _truncate_system_messages(messages, budget):
    """Ladder ③: keep head+tail of eligible system/developer messages.

    A system message is eligible only when its own content fits inside the
    whole budget (a larger one is never sliced), and only when at least a
    quarter of its content would be retained.  Returns a new list, or None
    when no eligible truncation exists.
    """
    current = [dict(item) for item in messages]
    while True:
        size = _utf16_length(_native_history_prompt(current))
        if size <= budget:
            return current
        best = None
        best_units = 0
        for index, item in enumerate(current):
            if not isinstance(item, dict) or item.get("role") not in ("system", "developer"):
                continue
            content = item.get("content")
            if not isinstance(content, str):
                continue
            units = _utf16_length(content)
            if units > budget:
                continue
            if units > best_units:
                best, best_units = index, units
        if best is None:
            return None
        content = current[best]["content"]
        keep = best_units - (size - budget) - 48
        if keep < max(2000, best_units // 4):
            return None
        current[best] = {**current[best], "content": _middle_truncated(content, keep)}


def _compact_native_history(history):
    """Fit the transcript into the native UTF-16 budget with a traceable ladder.

    Ladder (returned trim level):
      0 - nothing trimmed
      1 - complete old ordinary turns dropped (with a marker notice)
      3 - an eligible system/developer prompt middle-truncated (head+tail)
    A system message larger than the whole budget is never sliced; the caller
    receives request_too_large with actionable diagnostics instead.
    """
    prompt = _native_history_prompt(history)
    if _utf16_length(prompt) <= _NATIVE_PROMPT_BUDGET:
        return history, 0

    last_user = max((index for index, item in enumerate(history)
                     if item.get("role") == "user"), default=None)
    protected = {index for index, item in enumerate(history)
                 if item.get("role") in ("system", "developer")}
    if last_user is not None:
        protected.add(last_user)
    elif history:
        protected.add(len(history) - 1)

    # Level 1: remove oldest ordinary messages first.  This keeps the retained
    # list in its original order and never creates a partial JSON/tool definition.
    selected = list(history)
    omitted = False
    for index in range(len(history)):
        if index in protected:
            continue
        selected[index] = None
        omitted = True
        compacted = [item for item in selected if item is not None]
        if _utf16_length(_native_history_prompt(compacted)) <= _NATIVE_PROMPT_BUDGET:
            selected = compacted
            break

    compacted = [item for item in selected if item is not None]
    if omitted:
        marker = {"role": "system", "content": _HISTORY_NOTICE}
        if _utf16_length(_native_history_prompt([marker, *compacted])) <= _NATIVE_PROMPT_BUDGET:
            return [marker, *compacted], 1
        if _utf16_length(_native_history_prompt(compacted)) <= _NATIVE_PROMPT_BUDGET:
            return compacted, 1

    # Level 3: middle-truncate an eligible system/developer prompt.
    truncated = _truncate_system_messages(compacted, _NATIVE_PROMPT_BUDGET)
    if truncated is not None and _utf16_length(_native_history_prompt(truncated)) <= _NATIVE_PROMPT_BUDGET:
        return truncated, 3

    raise NativeBridgeError(413, "request_too_large", "工具定义或当前消息本身超过 TRAE 原生上下文限制。",
                            extra={"context_chars": _utf16_length(_native_history_prompt(compacted)),
                                   "budget_chars": _NATIVE_PROMPT_BUDGET,
                                   "suggest": _REQUEST_TOO_LARGE_SUGGEST})


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise _failure("NATIVE_FAILED")


class NativeTraeClient:
    def __init__(self, url=None, token=None, *, opener=None):
        url = os.environ.get("WB_TRAE_BRIDGE_URL", "") if url is None else url
        token = os.environ.get("WB_TRAE_BRIDGE_TOKEN", "") if token is None else token
        self.configured = False
        try:
            parsed = urllib.parse.urlsplit(url)
            valid = (parsed.scheme == "http" and parsed.hostname == "127.0.0.1"
                     and parsed.port is not None and 1 <= parsed.port <= 65535
                     and not parsed.username and not parsed.password and parsed.path in ("", "/")
                     and not parsed.query and not parsed.fragment
                     and isinstance(token, str) and re.fullmatch(r"[a-f0-9]{64}", token))
            if valid:
                self._url = "http://127.0.0.1:" + str(parsed.port)
                self._token = token
                self.configured = True
        except (ValueError, TypeError):
            pass
        self._opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())

    def _call(self, operation, payload, timeout_ms):
        if not self.configured:
            raise NativeBridgeError(503, "native_bridge_unavailable", "新模型需要桌面版的本机 TRAE 桥接，请从新版桌面程序启动网关。")
        if not isinstance(payload.get("uid"), str) or not _ID.fullmatch(payload["uid"]):
            raise NativeBridgeError(409, "native_uid_required", "请使用“扫描本机 TRAE”同步带有用户标识的账号。")
        body = json.dumps({**payload, "timeoutMs": timeout_ms}, ensure_ascii=False).encode("utf-8")
        if len(body) > _REQUEST_LIMIT:
            raise NativeBridgeError(413, "request_too_large", "TRAE 原生桥接请求过大。")
        url = self._url + "/" + operation
        request = urllib.request.Request(url, data=body, method="POST", headers={
            "Authorization": "Bearer " + self._token, "Content-Type": "application/json",
            "Connection": "close", "Accept": "application/json"})
        try:
            try:
                response = self._opener.open(request, timeout=timeout_ms / 1000 + 45)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                if response.geturl() != url:
                    raise _failure("NATIVE_FAILED")
                raw = response.read(_LIMIT + 1)
                if len(raw) > _LIMIT:
                    raise _failure("NATIVE_FAILED")
                try:
                    value = json.loads(raw)
                except (ValueError, UnicodeError, RecursionError):
                    raise _failure("NATIVE_FAILED") from None
                if not isinstance(value, dict):
                    raise _failure("NATIVE_FAILED")
                if not 200 <= response.getcode() < 300 or value.get("error") or value.get("ok") is False:
                    error = value.get("error")
                    raise _failure(error.get("code") if isinstance(error, dict) else None)
                return value
        except NativeBridgeError:
            raise
        except (OSError, ValueError, urllib.error.URLError, http.client.HTTPException, socket.timeout, TimeoutError):
            raise NativeBridgeError(503, "native_bridge_unavailable", "本机 TRAE 桥接连接中断，未重放请求。") from None

    def catalog(self, uid):
        value = self._call("catalog", {"uid": uid}, 45000)
        models = value.get("models")
        if value.get("source") != "native_client" or not isinstance(models, list) or not 0 < len(models) <= 4096:
            raise _failure("CATALOG_UNAVAILABLE")
        clean, seen = [], set()
        for model in models:
            if not isinstance(model, dict) or not isinstance(model.get("upstreamId"), str) or not _ID.fullmatch(model["upstreamId"]):
                raise _failure("CATALOG_UNAVAILABLE")
            mid, name = model["upstreamId"], model.get("name")
            if (not isinstance(name, str) or not 0 < len(name) <= 160 or name != name.strip()
                    or any(unicodedata.category(c).startswith("C") for c in name) or mid in seen):
                raise _failure("CATALOG_UNAVAILABLE")
            entry = {"upstreamId": mid, "name": name, "route": "native_client", "source": "native_client"}
            if "supports_vision" in model:
                entry["supports_vision"] = mid == "deepseek-v4.1-flash" and model["supports_vision"] is True
            clean.append(entry)
            seen.add(mid)
        return {"models": clean, "source": "native_client", "fetchedAt": value.get("fetchedAt")}

    def chat(self, uid, model, messages, *, max_chars, images=None):
        # The observed native API accepts one user text, not OpenAI's structured
        # role array. Preserve the entire transcript explicitly as quoted JSON.
        history = [{"role": m["role"], "content": "".join(b["text"] for b in m["content"])} for m in messages]
        compacted, trim = _compact_native_history(history)
        prompt = _native_history_prompt(compacted)
        body = {"uid": uid, "model": model, "prompt": prompt, "maxChars": max_chars}
        if images:
            body["images"] = images
        value = self._call("chat", body, 120000)
        if (value.get("model") != model or value.get("finish_reason") != "stop"
                or not isinstance(value.get("upstreamModel"), str)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}", value["upstreamModel"])
                or not isinstance(value.get("response"), str) or not value["response"].strip()
                or not isinstance(value.get("reasoning_content", ""), str)):
            raise _failure("UPSTREAM_MODEL_UNCONFIRMED")
        # Response and reasoning each get the full character budget; the
        # renderer-side event budget is separate and unchanged upstream.
        if len(value["response"]) > max_chars or len(value.get("reasoning_content", "")) > max_chars:
            raise _failure("OUTPUT_LIMIT")
        raw_usage = value.get("usage")
        usage = {
            key: raw_usage[key]
            for key in ("prompt_tokens", "completion_tokens", "total_tokens")
            if (isinstance(raw_usage, dict)
                and type(raw_usage.get(key)) is int
                and 0 <= raw_usage[key] <= 2**53 - 1)
        }
        if ("total_tokens" not in usage
                and "prompt_tokens" in usage
                and "completion_tokens" in usage
                and usage["prompt_tokens"] + usage["completion_tokens"] <= 2**53 - 1):
            usage["total_tokens"] = usage["prompt_tokens"] + usage["completion_tokens"]

        usage_estimated = usage.get("total_tokens", 0) <= 0
        if usage_estimated:
            prompt_tokens = max(1, _estimate_tokens(prompt))
            completion_tokens = (_estimate_tokens(value["response"])
                                 + _estimate_tokens(value.get("reasoning_content", "")))
            usage = {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens,
            }

        result = {
            "response": value["response"],
            "reasoning_content": value.get("reasoning_content", ""),
            "usage": usage,
            "finish_reason": value["finish_reason"],
            "upstreamModel": value["upstreamModel"],
            "model": value["model"],
        }
        if trim:
            result["context_trim"] = trim
        if usage_estimated:
            result["usageEstimated"] = True
        return result
