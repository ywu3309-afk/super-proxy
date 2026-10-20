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
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$")
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
    "NATIVE_CLIENT_UNAVAILABLE": (503, "native_client_unavailable", "当前 TRAE 原生客户端不可用，请重新打开工作窗口。"),
    "CATALOG_UNAVAILABLE": (503, "catalog_unavailable", "TRAE 未返回可用的原生模型目录。"),
    "INCOMPLETE_RESPONSE": (502, "incomplete_stream", "TRAE 原生响应未完整结束，未重放请求。"),
    "EMPTY_RESPONSE": (502, "empty_stream", "TRAE 未返回有效文本，未作为成功回答返回。"),
    "UPSTREAM_ERROR": (502, "upstream_error", "TRAE 原生对话失败，停止流程已执行，未重放请求。"),
}


class NativeBridgeError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _failure(code):
    return NativeBridgeError(*_ERRORS.get(code, (502, "native_request_failed", "TRAE 原生操作未完成，未重放请求。")))


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
        if len(body) > _LIMIT:
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
            clean.append({"upstreamId": mid, "name": name, "route": "native_client", "source": "native_client"})
            seen.add(mid)
        return {"models": clean, "source": "native_client", "fetchedAt": value.get("fetchedAt")}

    def chat(self, uid, model, messages, *, max_chars):
        # The observed native API accepts one user text, not OpenAI's structured
        # role array. Preserve the entire transcript explicitly as quoted JSON.
        history = [{"role": m["role"], "content": "".join(b["text"] for b in m["content"])} for m in messages]
        prompt = ("以下 JSON 数组是完整对话记录，role 表示消息角色。遵循 system 消息，基于记录仅回答最后的 user 消息，"
                  "不要复述记录，不调用 TRAE 内置工具。若记录要求输出外部工具协议 JSON，只生成该 JSON 文本，"
                  "工具由外部客户端执行。\n" + json.dumps(history, ensure_ascii=False, separators=(",", ":")))
        if len(prompt.encode("utf-16-le")) // 2 > 65536:
            raise NativeBridgeError(413, "request_too_large", "原生文本桥接的完整对话超过 65,536 个 UTF-16 字符。")
        value = self._call("chat", {"uid": uid, "model": model, "prompt": prompt, "maxChars": max_chars}, 120000)
        if (value.get("model") != model or value.get("finish_reason") != "stop"
                or not isinstance(value.get("upstreamModel"), str)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}", value["upstreamModel"])
                or not isinstance(value.get("response"), str) or not value["response"].strip()
                or not isinstance(value.get("reasoning_content", ""), str)):
            raise _failure("UPSTREAM_MODEL_UNCONFIRMED")
        if len(value["response"]) + len(value.get("reasoning_content", "")) > max_chars:
            raise _failure("OUTPUT_LIMIT")
        usage = value.get("usage", {})
        value["usage"] = {key: usage[key] for key in ("prompt_tokens", "completion_tokens", "total_tokens")
                          if isinstance(usage, dict) and type(usage.get(key)) is int and 0 <= usage[key] <= 2**53 - 1}
        return {key: value[key] for key in ("response", "reasoning_content", "usage", "finish_reason", "upstreamModel", "model") if key in value}
