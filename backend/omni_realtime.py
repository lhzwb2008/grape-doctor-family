"""百炼 Qwen-Omni Realtime 配置与会话说明。"""

from __future__ import annotations

import os

from backend.cursor_client import SYSTEM_PREAMBLE


def realtime_model() -> str:
    return os.environ.get("DASHSCOPE_OMNI_MODEL", "qwen3.5-omni-flash-realtime").strip()


def realtime_voice() -> str:
    return os.environ.get("DASHSCOPE_OMNI_VOICE", "Tina").strip() or "Tina"


def realtime_ws_url() -> str:
    """上游 Realtime WebSocket 地址（含 model 查询参数）。"""
    base = os.environ.get(
        "DASHSCOPE_REALTIME_URL",
        "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    ).strip().rstrip("?")
    model = realtime_model()
    sep = "&" if "?" in base else "?"
    if "model=" in base:
        return base
    return f"{base}{sep}model={model}"


def call_instructions(member_name: str) -> str:
    base = SYSTEM_PREAMBLE.format(member_name=member_name or "家人")
    return (
        base
        + "\n你正在与用户进行实时语音通话。请用口语化、简短分句的方式回答，"
        "每次尽量控制在几句话内，方便听清；需要时可追问关键信息。"
        "不要输出 Markdown 标记或列表符号。"
    )


def session_update_payload(member_name: str) -> dict:
    """发给上游的 session.update 内容。"""
    vad = os.environ.get("DASHSCOPE_OMNI_VAD", "semantic_vad").strip() or "semantic_vad"
    turn: dict | None
    if vad == "none" or vad == "manual":
        turn = None
    elif vad == "server_vad":
        turn = {
            "type": "server_vad",
            "threshold": 0.1,
            "prefix_padding_ms": 500,
            "silence_duration_ms": 900,
        }
    else:
        turn = {
            "type": "semantic_vad",
            "threshold": 0.1,
            "prefix_padding_ms": 500,
            "silence_duration_ms": 900,
        }

    session: dict = {
        "modalities": ["text", "audio"],
        "voice": realtime_voice(),
        "instructions": call_instructions(member_name),
        "input_audio_format": "pcm",
        "output_audio_format": "pcm",
        "input_audio_transcription": {
            "model": os.environ.get(
                "DASHSCOPE_OMNI_ASR_MODEL",
                "qwen3-asr-flash-realtime",
            ).strip(),
        },
        "turn_detection": turn,
    }
    return {"type": "session.update", "session": session}
