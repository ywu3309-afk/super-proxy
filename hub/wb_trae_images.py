"""Bounded inline images for the one verified TRAE vision route.

Image bytes stay outside the structured-text transcript. No URL is fetched and
no image or resource is persisted by this module.
"""
import base64
import binascii
import copy
import re
import struct

VISION_MODEL = "trae/deepseek-v4.1-flash"
MAX_IMAGES = 4
MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_TOTAL_BYTES = 8 * 1024 * 1024
MAX_REQUEST_BYTES = 16 * 1024 * 1024
_DATA = re.compile(r"data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})\Z")


class ImageInputError(Exception):
    def __init__(self, message, code="invalid_messages", status=422):
        super().__init__(message)
        self.message, self.code, self.status = message, code, status


def _bad():
    raise ImageInputError("图片必须为有效的 PNG、JPEG 或 WebP dataURI。")


def dimensions(raw, media_type):
    """Validate format headers and bounded dimensions, not a full image decode."""
    try:
        if media_type == "image/png":
            if (len(raw) < 45 or raw[:8] != b"\x89PNG\r\n\x1a\n" or raw[8:16] != b"\0\0\0\rIHDR"
                    or raw[-12:] != b"\0\0\0\0IEND\xaeB`\x82"):
                _bad()
            width, height = struct.unpack(">II", raw[16:24])
        elif media_type == "image/jpeg":
            if len(raw) < 12 or raw[:2] != b"\xff\xd8" or raw[-2:] != b"\xff\xd9":
                _bad()
            index, found = 2, None
            while index < len(raw) - 2:
                if raw[index] != 255:
                    _bad()
                while index < len(raw) and raw[index] == 255:
                    index += 1
                marker = raw[index]
                index += 1
                if marker in (0xD9, 0xDA):
                    break
                if marker == 0x01 or 0xD0 <= marker <= 0xD7:
                    continue
                size = int.from_bytes(raw[index:index + 2], "big")
                if size < 2 or index + size > len(raw):
                    _bad()
                if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                    if size < 8:
                        _bad()
                    found = struct.unpack(">HH", raw[index + 3:index + 7])
                    break
                index += size
            if found is None:
                _bad()
            height, width = found
        elif media_type == "image/webp":
            if (len(raw) < 26 or raw[:4] != b"RIFF" or raw[8:12] != b"WEBP"
                    or int.from_bytes(raw[4:8], "little") + 8 != len(raw)):
                _bad()
            kind, size = raw[12:16], int.from_bytes(raw[16:20], "little")
            if size < 5 or 20 + size > len(raw):
                _bad()
            if kind == b"VP8X" and size == 10:
                width = int.from_bytes(raw[24:27], "little") + 1
                height = int.from_bytes(raw[27:30], "little") + 1
            elif kind == b"VP8L" and raw[20] == 0x2F:
                bits = int.from_bytes(raw[21:25], "little")
                width, height = (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
            elif kind == b"VP8 " and size >= 10 and raw[23:26] == b"\x9d\x01\x2a":
                width, height = (int.from_bytes(raw[26:28], "little") & 0x3FFF,
                                 int.from_bytes(raw[28:30], "little") & 0x3FFF)
            else:
                _bad()
        else:
            _bad()
    except (IndexError, struct.error):
        _bad()
    if not (0 < width <= 16384 and 0 < height <= 16384 and width * height <= 40_000_000):
        _bad()
    return width, height


def image(part, image_id):
    if not isinstance(part, dict) or set(part) != {"type", "image_url"}:
        _bad()
    value = part["image_url"]
    if (not isinstance(value, dict) or set(value) - {"url", "detail"}
            or value.get("detail", "auto") not in ("auto", "low", "high") or not isinstance(value.get("url"), str)):
        _bad()
    match = _DATA.fullmatch(value["url"])
    if not match:
        _bad()
    media_type, encoded = match.groups()
    if len(encoded) > 4 * ((MAX_IMAGE_BYTES + 2) // 3):
        raise ImageInputError("单张图片超过 4 MiB。", "request_too_large", 413)
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        _bad()
    if base64.b64encode(raw).decode("ascii") != encoded:
        _bad()
    if len(raw) > MAX_IMAGE_BYTES:
        raise ImageInputError("单张图片超过 4 MiB。", "request_too_large", 413)
    width, height = dimensions(raw, media_type)
    return {"id": image_id, "mediaType": media_type, "data": encoded, "width": width, "height": height}, len(raw)


def split_messages(messages, model):
    """Return copied history with ordered image refs, plus private image bytes."""
    if not isinstance(messages, list):
        return messages, []
    output, images, total = [], [], 0
    for message in messages:
        if not isinstance(message, dict) or not isinstance(message.get("content"), list):
            output.append(copy.deepcopy(message))
            continue
        row, parts = copy.deepcopy(message), []
        for part in message["content"]:
            if isinstance(part, dict) and part.get("type") == "image_ref":
                raise ImageInputError("image_ref 是内部协议，不能作为请求内容。")
            if not isinstance(part, dict) or part.get("type") != "image_url":
                parts.append(copy.deepcopy(part))
                continue
            if model != VISION_MODEL:
                raise ImageInputError("当前 TRAE 模型未接通图片输入。", "unsupported_feature")
            if message.get("role") != "user":
                raise ImageInputError("TRAE 图片仅支持 user 消息。")
            if len(images) >= MAX_IMAGES:
                raise ImageInputError("每次请求最多 4 张图片。", "request_too_large", 413)
            item, size = image(part, "image_" + str(len(images) + 1))
            total += size
            if total > MAX_TOTAL_BYTES:
                raise ImageInputError("图片解码总量超过 8 MiB。", "request_too_large", 413)
            images.append(item)
            parts.append({"type": "image_ref", "image_id": item["id"]})
        row["content"] = parts
        output.append(row)
    return output, images
