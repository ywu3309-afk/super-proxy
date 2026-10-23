"""TRAE live model-catalog compatibility extracted from ``cty1735/wb-proxy``.

The upstream project switched from the old ``model_list?type=chat`` endpoint to
the same ``get_detail_param`` calls that the current TRAE client uses.  This
module keeps that protocol conversion independent from the gateway's account
store and native desktop bridge.  It is deliberately stateless: it accepts
decoded JSON payloads and returns sanitized model metadata only.
"""

import json
import os
import time


MODEL_FUNCTIONS = ("chat_v3", "solo_agent", "solo_coder")
MODEL_INTERNAL = frozenset({
    "summary", "fast_apply", "fast_apply_new", "title_generation",
    "input_optimization",
})

DEFAULT_CONTEXT_WINDOW = 128000
DEFAULT_MAX_OUTPUT_TOKENS = 128000
REMOTE_SOURCE = "remote_http"
UPSTREAM_MODEL_FALLBACKS = {
    # The modern direct endpoint accepts the stable provider config for this
    # directory entry; the client-facing id remains deepseek-v4.1-flash.
    "deepseek-v4.1-flash": "DeepSeek-V4-Flash",
}


def catalog_version_code(environ=None):
    """Return the build code used by the upstream catalog request.

    The current upstream implementation uses today's build number so a gateway
    does not stay pinned to the old model generation.  Tests can inject an
    environment mapping or set ``TRAE_CATALOG_VERSION_CODE`` explicitly.
    """
    environ = os.environ if environ is None else environ
    for name in ("TRAE_CATALOG_VERSION_CODE", "TRAE_IDE_VERSION_CODE"):
        value = str(environ.get(name) or "").strip()
        if value:
            return value
    return time.strftime("%Y%m%d")


def catalog_headers(base_headers=None, *, environ=None):
    """Add the modern client build headers without changing auth material."""
    headers = dict(base_headers or {})
    code = catalog_version_code(environ)
    headers["x-ide-version-code"] = code
    headers["x-app-version-code"] = code
    return headers


def request_body(function):
    """Build the exact ``get_detail_param`` body used by TRAE's client."""
    if function not in MODEL_FUNCTIONS:
        raise ValueError("unknown TRAE model function")
    return {
        "function": function,
        "config_names": None,
        "need_prompt": False,
        "current_config_info": None,
        "poly_prompt": True,
        "mode_type": None,
        "agent_type": None,
    }


def _first_int(entry, *names):
    for name in names:
        value = entry.get(name)
        if isinstance(value, bool) or value is None:
            continue
        if isinstance(value, (int, float)) and value > 0:
            return int(value)
        if isinstance(value, str) and value.isdigit():
            return int(value)
    return 0


def _entry_contact(entry):
    contact = entry.get("display_contact_config")
    if isinstance(contact, str) and contact.strip():
        try:
            contact = json.loads(contact)
        except (ValueError, TypeError, RecursionError):
            contact = None
    if isinstance(contact, dict):
        return contact
    features = entry.get("features")
    return features if isinstance(features, dict) else {}


def entry_config_name(entry):
    if not isinstance(entry, dict):
        return ""
    return str(entry.get("config_name") or entry.get("configName")
               or entry.get("model") or entry.get("id")
               or entry.get("name") or "").strip()


def _entry_context(entry):
    value = entry.get("context_window_tokens") or entry.get("contextWindowTokens")
    if isinstance(value, dict):
        for key in ("prod", "dev", "max", "default"):
            number = value.get(key)
            if isinstance(number, (int, float)) and not isinstance(number, bool) and number > 0:
                return int(number)
        for number in value.values():
            if isinstance(number, (int, float)) and not isinstance(number, bool) and number > 0:
                return int(number)
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
        return int(value)
    return _first_int(entry, "context_window", "contextWindow", "max_input_tokens",
                      "maxInputTokens", "token_limit", "max_context_tokens")


def _entry_tags(entry):
    return " ".join(str(entry.get(key) or "").lower() for key in (
        "name", "display_name", "config_name", "description", "category", "type"))


def _format_rate(value):
    try:
        rate = float(value)
    except (TypeError, ValueError):
        return ""
    if rate < 0:
        return ""
    text = ("%f" % rate).rstrip("0").rstrip(".")
    return text or "0"


def _consumption(entry):
    contact = _entry_contact(entry)
    section = contact.get("consumption_rate")
    rate = None
    if isinstance(section, dict) and section.get("enable") is not False:
        data = section.get("data")
        if isinstance(data, dict):
            rate = data.get("rate")
    credits = _format_rate(rate)
    note = ""
    activity = contact.get("activity_discount")
    if isinstance(activity, dict) and activity.get("enable") is not False:
        data = activity.get("data") if isinstance(activity.get("data"), dict) else {}
        current = data.get("current") if isinstance(data.get("current"), dict) else {}
        before = _format_rate(current.get("before_consumption_rate"))
        now = _format_rate(current.get("consumption_rate")) or credits
        if before and now and before != now:
            note = "限时补贴：原价 %sx → %sx" % (before, now)
    if not note and credits:
        note = "来自 TRAE 账号模型目录的消耗倍率"
    return credits, note


def normalise_entry(entry):
    """Convert one upstream entry to a safe gateway model record."""
    if not isinstance(entry, dict):
        return None
    display = entry.get("display_config")
    if not isinstance(display, dict):
        display = {}
    config = entry_config_name(entry)
    if not config or len(config) > 160:
        return None
    if entry.get("enable") is False or entry.get("enabled") is False:
        return None
    if entry.get("config_switch") is False or entry.get("is_invisible_to_user") is True:
        return None
    if config.startswith("custom_model_") or config in MODEL_INTERNAL:
        return None
    lowered = config.lower()
    if ("_advisor" in lowered or lowered.endswith("-auto")
            or lowered.startswith("search_agent") or lowered.startswith("file_search")):
        return None
    name = str(display.get("display_name") or display.get("displayName")
               or entry.get("display_name") or entry.get("displayName")
               or entry.get("name") or config).strip() or config
    if len(name) > 160 or any(ord(ch) < 32 for ch in name):
        return None
    contact = _entry_contact(entry)
    reasoning_section = contact.get("reasoning") if isinstance(contact.get("reasoning"), dict) else {}
    multimodal_section = contact.get("multimodal") if isinstance(contact.get("multimodal"), dict) else {}
    tags = _entry_tags(entry)
    capability = str(display.get("model_capability") or entry.get("model_type") or "")
    reasoning = bool(capability == "reasoning_model" or reasoning_section.get("enable")
                     or entry.get("is_reasoning") or entry.get("reasoning")
                     or entry.get("supports_reasoning") or entry.get("thinking")
                     or "reason" in tags or "思考" in tags)
    vision = bool(display.get("multimodal") or multimodal_section.get("enable")
                  or entry.get("is_vl") or entry.get("multimodal")
                  or entry.get("supports_vision") or "vision" in tags
                  or "vl" in tags or "image" in tags)
    tools = entry.get("supports_tool_call")
    if tools is None:
        tools = entry.get("toolcall_compatible")
    if tools is None:
        tools = True
    credits, credits_note = _consumption(entry)
    return {
        "id": config,
        "name": name,
        "context": _entry_context(entry) or DEFAULT_CONTEXT_WINDOW,
        "max_tokens": _first_int(entry, "max_output_tokens", "maxOutputTokens",
                                  "max_tokens", "maxTokens") or DEFAULT_MAX_OUTPUT_TOKENS,
        "reasoning": reasoning,
        "supports_effort": False,
        "efforts": [],
        "input": ["text", "image"] if vision else ["text"],
        "supports_tool_call": bool(tools),
        "credits": credits,
        "credits_note": credits_note,
        "source": REMOTE_SOURCE,
    }


def extract_entries(data):
    """Find model arrays in the known ``get_detail_param`` wrappers."""
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    if not isinstance(data, dict):
        return []
    for key in ("config_info_list", "config_infos", "configInfos", "models",
                "model_list", "modelList", "configs"):
        value = data.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
        if isinstance(value, dict):
            nested = extract_entries(value)
            if nested:
                return nested
    for key in ("data", "result", "body"):
        nested = data.get(key)
        if isinstance(nested, (list, dict)):
            found = extract_entries(nested)
            if found:
                return found
    return []


def _score(entry):
    score = 0
    display = entry.get("display_config") if isinstance(entry.get("display_config"), dict) else {}
    if str(display.get("display_name") or entry.get("display_name") or "").strip():
        score += 4
    if _consumption(entry)[0]:
        score += 2
    if _entry_context(entry):
        score += 1
    return score


def _merge(merged, order, entry):
    config = entry_config_name(entry)
    if not config:
        return
    previous = merged.get(config)
    if previous is None:
        merged[config] = dict(entry)
        order.append(config)
        return
    if _score(entry) > _score(previous):
        previous.update(entry)
    if entry.get("is_invisible_to_user") is not True:
        previous["is_invisible_to_user"] = entry.get("is_invisible_to_user")


def normalise_payloads(payloads):
    """Merge and sanitize the responses from all model functions."""
    merged, order = {}, []
    for payload in payloads if isinstance(payloads, (list, tuple)) else []:
        for entry in extract_entries(payload):
            _merge(merged, order, entry)
    models, seen_ids, seen_names = [], set(), set()
    for key in order:
        model = normalise_entry(merged[key])
        if not model:
            continue
        model_id = model["id"].lower()
        name = model["name"].lower()
        if model_id in seen_ids or (name and name in seen_names):
            continue
        seen_ids.add(model_id)
        if name:
            seen_names.add(name)
        models.append(model)
    rated = [model for model in models if model.get("credits")]
    return rated or models


def to_gateway_models(models):
    """Attach the current provider's routing/source fields."""
    result = []
    for model in models if isinstance(models, list) else []:
        if not isinstance(model, dict) or not model.get("id"):
            continue
        item = {
            "upstreamId": model["id"],
            "name": model.get("name") or model["id"],
            "route": REMOTE_SOURCE,
            "source": REMOTE_SOURCE,
            "upstreamModel": UPSTREAM_MODEL_FALLBACKS.get(
                str(model["id"]).lower(), model["id"]),
            "context": model.get("context") or DEFAULT_CONTEXT_WINDOW,
            "max_tokens": model.get("max_tokens") or DEFAULT_MAX_OUTPUT_TOKENS,
            "supports_tool_call": model.get("supports_tool_call") is not False,
        }
        # The current gateway only sends image bytes through its native bridge.
        # Keep remote HTTP models text-only unless a future transport explicitly
        # opts in, so the panel never advertises a path that will be rejected.
        if model.get("credits"):
            item["credits"] = model["credits"]
        if model.get("credits_note"):
            item["credits_note"] = model["credits_note"]
        result.append(item)
    return result

