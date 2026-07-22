"""百炼 DashScope：ASR（qwen3-asr-flash）+ TTS（CosyVoice）。"""

from __future__ import annotations

import base64
import json
import os
import re
import urllib.error
import urllib.request
from typing import Any


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def api_key() -> str:
    key = _env("DASHSCOPE_API_KEY")
    if not key:
        raise RuntimeError("缺少 DASHSCOPE_API_KEY，请在 .env 中配置百炼 API Key")
    return key


def base_url() -> str:
    raw = _env("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com").rstrip("/")
    for suffix in ("/compatible-mode/v1", "/compatible-mode"):
        if raw.endswith(suffix):
            return raw[: -len(suffix)]
    return raw


def asr_model() -> str:
    return _env("DASHSCOPE_ASR_MODEL", "qwen3-asr-flash")


def tts_model() -> str:
    return _env("DASHSCOPE_TTS_MODEL", "cosyvoice-v2")


def tts_voice() -> str:
    # 龙小淳：常用知性女声（cosyvoice-v2）
    return _env("DASHSCOPE_TTS_VOICE", "longxiaochun_v2")


def tts_format() -> str:
    return _env("DASHSCOPE_TTS_FORMAT", "mp3")


def tts_sample_rate() -> int:
    try:
        return int(_env("DASHSCOPE_TTS_SAMPLE_RATE", "24000"))
    except ValueError:
        return 24000


def _http_post(url: str, body: dict[str, Any], *, timeout: float = 90) -> dict[str, Any]:
    req = urllib.request.Request(
        url,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key()}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {raw[:600]}") from exc


def _download(url: str, *, timeout: float = 60) -> bytes:
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _mime_to_data_uri(mime: str, raw: bytes) -> str:
    mime = (mime or "audio/webm").split(";")[0].strip().lower() or "audio/webm"
    b64 = base64.b64encode(raw).decode("ascii")
    return f"data:{mime};base64,{b64}"


def recognize(audio_bytes: bytes, mime: str = "audio/webm") -> str:
    """同步语音识别，返回文本。"""
    if not audio_bytes:
        raise ValueError("音频为空")
    if len(audio_bytes) > 10 * 1024 * 1024:
        raise ValueError("音频超过 10MB 限制")

    data_uri = _mime_to_data_uri(mime, audio_bytes)
    url = f"{base_url()}/compatible-mode/v1/chat/completions"
    body: dict[str, Any] = {
        "model": asr_model(),
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_audio",
                        "input_audio": {"data": data_uri},
                    }
                ],
            }
        ],
        "stream": False,
        "asr_options": {
            "language": "zh",
            "enable_itn": True,
        },
    }
    data = _http_post(url, body, timeout=90)
    choices = data.get("choices") or []
    if not choices:
        raise RuntimeError(f"ASR 无识别结果: {json.dumps(data, ensure_ascii=False)[:400]}")
    msg = (choices[0].get("message") or {}) if isinstance(choices[0], dict) else {}
    text = (msg.get("content") or "").strip()
    return text


_MD_STRIP_RE = re.compile(
    r"```[\s\S]*?```|`[^`]+`|!\[[^\]]*\]\([^)]*\)|\[[^\]]*\]\([^)]*\)|"
    r"^#{1,6}\s+|^\s*[-*+]\s+|^\s*\d+\.\s+|[*_]{1,3}|^>\s+",
    re.MULTILINE,
)


def strip_for_speech(text: str) -> str:
    """去掉常见 Markdown，便于朗读。"""
    t = _MD_STRIP_RE.sub(" ", text or "")
    t = re.sub(r"[#>*`|_]+", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def synthesize(text: str) -> tuple[bytes, str]:
    """文本转语音，返回 (audio_bytes, mime)。"""
    clean = strip_for_speech(text)
    if not clean:
        raise ValueError("没有可朗读的文本")
    if len(clean) > 2000:
        clean = clean[:2000]

    url = f"{base_url()}/api/v1/services/audio/tts/SpeechSynthesizer"
    body: dict[str, Any] = {
        "model": tts_model(),
        "input": {
            "text": clean,
            "voice": tts_voice(),
            "format": tts_format(),
            "sample_rate": tts_sample_rate(),
            "rate": 1.0,
        },
    }
    data = _http_post(url, body, timeout=90)
    audio = (data.get("output") or {}).get("audio") or {}
    audio_url = audio.get("url")
    if audio_url:
        raw = _download(audio_url)
    else:
        # 部分接口直接返回 base64
        b64 = audio.get("data") or data.get("output", {}).get("audio")
        if isinstance(b64, str) and b64:
            raw = base64.b64decode(b64)
        else:
            raise RuntimeError(f"TTS 响应缺少音频: {json.dumps(data, ensure_ascii=False)[:400]}")

    fmt = (tts_format() or "mp3").lower()
    mime = "audio/mpeg" if fmt == "mp3" else f"audio/{fmt}"
    return raw, mime
