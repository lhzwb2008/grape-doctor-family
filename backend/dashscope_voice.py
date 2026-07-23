"""百炼 DashScope：ASR（qwen3-asr-flash）+ TTS（CosyVoice）。"""

from __future__ import annotations

import base64
import json
import os
import re
import time
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


def tts_rate() -> float:
    try:
        return float(_env("DASHSCOPE_TTS_RATE", "1.1"))
    except ValueError:
        return 1.1


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


def split_speech_segments(text: str, *, max_chars: int = 72) -> list[str]:
    """按句拆分，控制单段长度，降低首包等待。"""
    clean = strip_for_speech(text)
    if not clean:
        return []
    parts: list[str] = []
    buf: list[str] = []
    for ch in clean:
        buf.append(ch)
        joined = "".join(buf)
        at_break = ch in "。！？；!?.;\n"
        too_long = len(joined) >= max_chars
        if at_break or too_long:
            seg = joined.strip()
            if seg:
                parts.append(seg)
            buf = []
    tail = "".join(buf).strip()
    if tail:
        parts.append(tail)
    # 合并过碎且未收尾的片段，避免把完整短句和下句粘在一起
    merged: list[str] = []
    for seg in parts:
        if (
            merged
            and len(merged[-1]) < 12
            and merged[-1][-1] not in "。！？!?.;"
        ):
            merged[-1] = f"{merged[-1]}{seg}"
        else:
            merged.append(seg)
    return merged


def synthesize(text: str) -> tuple[bytes, str, dict[str, float | int]]:
    """文本转语音，返回 (audio_bytes, mime, timing)。"""
    clean = strip_for_speech(text)
    if not clean:
        raise ValueError("没有可朗读的文本")
    if len(clean) > 500:
        # 单次请求限制更短，鼓励前端分句；后端兜底截断
        clean = clean[:500]

    url = f"{base_url()}/api/v1/services/audio/tts/SpeechSynthesizer"
    body: dict[str, Any] = {
        "model": tts_model(),
        "input": {
            "text": clean,
            "voice": tts_voice(),
            "format": tts_format(),
            "sample_rate": tts_sample_rate(),
            "rate": float(tts_rate()),
        },
    }
    t0 = time.perf_counter()
    data = _http_post(url, body, timeout=90)
    t1 = time.perf_counter()
    audio = (data.get("output") or {}).get("audio") or {}
    audio_url = audio.get("url")
    if audio_url:
        raw = _download(audio_url)
        t2 = time.perf_counter()
    else:
        b64 = audio.get("data")
        if isinstance(b64, str) and b64:
            raw = base64.b64decode(b64)
            t2 = time.perf_counter()
        else:
            raise RuntimeError(f"TTS 响应缺少音频: {json.dumps(data, ensure_ascii=False)[:400]}")

    fmt = (tts_format() or "mp3").lower()
    mime = "audio/mpeg" if fmt == "mp3" else f"audio/{fmt}"
    timing = {
        "chars": len(clean),
        "synth_ms": int((t1 - t0) * 1000),
        "download_ms": int((t2 - t1) * 1000),
        "total_ms": int((t2 - t0) * 1000),
    }
    print(
        f"[tts] chars={timing['chars']} synth_ms={timing['synth_ms']} "
        f"download_ms={timing['download_ms']} bytes={len(raw)}",
        flush=True,
    )
    return raw, mime, timing
