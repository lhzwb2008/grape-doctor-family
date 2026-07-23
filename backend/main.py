"""葡萄个人助手家庭版 — FastAPI 后端。"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend import storage
from backend.attachments import extract_attachment_text
from backend.cursor_client import (
    build_chat_prompt,
    create_agent,
    create_run,
    model_id,
    run_with_stream,
)
from backend.dashscope_voice import recognize as asr_recognize
from backend.dashscope_voice import synthesize as tts_synthesize

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

app = FastAPI(title="葡萄个人助手家庭版")
storage.ensure_dirs()

FRONTEND = ROOT / "frontend"
TOKEN_TTL = 60 * 60 * 24 * 30  # 30 days

IMAGE_MIMES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
TEXT_MIMES = {
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
    "application/xml",
    "text/xml",
    "text/html",
}
MAX_ATTACHMENTS = 5
MAX_FILE_BYTES = 12 * 1024 * 1024
MAX_TEXT_CHARS = 80000


def _secret() -> bytes:
    return os.environ.get("SECRET_KEY", "grape-doctor").encode()


def _make_token(user_id: str) -> str:
    exp = str(int(time.time()) + TOKEN_TTL)
    nonce = secrets.token_urlsafe(16)
    payload = f"{user_id}.{exp}.{nonce}"
    sig = hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{sig}"


def _auth_user(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "未登录")
    token = authorization[7:].strip()
    parts = token.split(".")
    if len(parts) != 4:
        raise HTTPException(401, "登录无效，请重新登录")
    user_id, exp_s, nonce, sig = parts
    payload = f"{user_id}.{exp_s}.{nonce}"
    expect = hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expect, sig):
        raise HTTPException(401, "登录无效，请重新登录")
    try:
        exp = int(exp_s)
    except ValueError as e:
        raise HTTPException(401, "登录无效，请重新登录") from e
    if exp < time.time():
        raise HTTPException(401, "登录已过期，请重新登录")
    if not storage.get_member(user_id):
        raise HTTPException(401, "未知账户")
    return user_id


class LoginBody(BaseModel):
    user_id: str
    password: str = Field(min_length=4, max_length=64)


class AttachmentIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    mime: str = Field(min_length=1, max_length=100)
    data: str = Field(min_length=1)  # base64，可带 data URL 前缀


class ChatBody(BaseModel):
    message: str = Field(default="", max_length=8000)
    attachments: list[AttachmentIn] = Field(default_factory=list)


class SessionCreateBody(BaseModel):
    title: str = "新对话"


class AsrBody(BaseModel):
    audio: str = Field(min_length=1)  # base64 或 data URL
    mime: str = Field(default="audio/webm", max_length=100)


class TtsBody(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


def _strip_b64(data: str) -> str:
    if "," in data and data.strip().lower().startswith("data:"):
        return data.split(",", 1)[1]
    return data


def _prepare_attachments(
    attachments: list[AttachmentIn],
) -> tuple[list[dict], str, list[str]]:
    """返回 (cursor_images, prompt_notes, display_names)。不落盘。"""
    if len(attachments) > MAX_ATTACHMENTS:
        raise HTTPException(400, f"一次最多上传 {MAX_ATTACHMENTS} 个附件")

    images: list[dict] = []
    notes: list[str] = []
    names: list[str] = []

    for att in attachments:
        mime = (att.mime or "").split(";")[0].strip().lower()
        name = att.name.strip() or "attachment"
        raw_b64 = _strip_b64(att.data).strip()
        try:
            raw = base64.b64decode(raw_b64, validate=False)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(400, f"附件 {name} 解码失败") from e
        if len(raw) > MAX_FILE_BYTES:
            raise HTTPException(400, f"附件 {name} 超过 12MB 限制")

        names.append(name)

        if mime in IMAGE_MIMES or mime.startswith("image/"):
            if mime not in IMAGE_MIMES:
                raise HTTPException(400, f"不支持的图片类型：{mime}（请用 png/jpeg/gif/webp）")
            images.append({"data": raw_b64, "mimeType": mime})
            notes.append(f"- 图片附件：{name}（已随请求提交，请结合图片内容回答）")
            continue

        try:
            kind, text = extract_attachment_text(name, mime, raw)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(400, f"附件解析失败（{name}）：{e}") from e
        notes.append(f"- {kind} 附件：{name}\n```\n{text}\n```")

    prompt_notes = ""
    if notes:
        prompt_notes = "【本次临时附件，仅本轮可见，不会保存】\n" + "\n".join(notes)
    return images, prompt_notes, names


@app.get("/api/health")
def health():
    return {"ok": True, "model": model_id(), "name": "葡萄个人助手家庭版"}


@app.get("/api/members")
def members():
    return {"members": storage.list_members()}


@app.post("/api/login")
def login(body: LoginBody):
    try:
        member = storage.login(body.user_id, body.password)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    token = _make_token(body.user_id)
    return {"token": token, "member": member}


@app.get("/api/me")
def me(authorization: str | None = Header(default=None)):
    user_id = _auth_user(authorization)
    member = storage.get_member(user_id)
    return {"member": member}


@app.get("/api/sessions")
def sessions(authorization: str | None = Header(default=None)):
    user_id = _auth_user(authorization)
    return {"sessions": storage.list_sessions(user_id)}


@app.post("/api/sessions")
def create_session(
    body: SessionCreateBody,
    authorization: str | None = Header(default=None),
):
    user_id = _auth_user(authorization)
    session = storage.create_session(user_id, body.title)
    return {"session": session}


@app.get("/api/sessions/{session_id}")
def get_session(session_id: str, authorization: str | None = Header(default=None)):
    user_id = _auth_user(authorization)
    try:
        session = storage.get_session(user_id, session_id)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    return {"session": session}


@app.delete("/api/sessions/{session_id}")
def delete_session(session_id: str, authorization: str | None = Header(default=None)):
    user_id = _auth_user(authorization)
    try:
        storage.delete_session(user_id, session_id)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    return {"ok": True}


@app.post("/api/asr")
def asr(body: AsrBody, authorization: str | None = Header(default=None)):
    _auth_user(authorization)
    raw_b64 = _strip_b64(body.audio).strip()
    try:
        raw = base64.b64decode(raw_b64, validate=False)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, "音频解码失败") from e
    mime = (body.mime or "audio/webm").split(";")[0].strip() or "audio/webm"
    try:
        text = asr_recognize(raw, mime)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"语音识别失败：{e}") from e
    return {"text": text}


@app.post("/api/tts")
def tts(body: TtsBody, authorization: str | None = Header(default=None)):
    _auth_user(authorization)
    try:
        audio, mime, timing = tts_synthesize(body.text)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"语音合成失败：{e}") from e
    # 直接返回音频二进制，避免 base64 膨胀；前端可分句调用以降低首包延迟
    return Response(
        content=audio,
        media_type=mime,
        headers={
            "Cache-Control": "no-store",
            "X-TTS-Chars": str(timing.get("chars", 0)),
            "X-TTS-Synth-Ms": str(timing.get("synth_ms", 0)),
            "X-TTS-Download-Ms": str(timing.get("download_ms", 0)),
            "X-TTS-Total-Ms": str(timing.get("total_ms", 0)),
        },
    )


@app.post("/api/sessions/{session_id}/chat")
async def chat(
    session_id: str,
    body: ChatBody,
    authorization: str | None = Header(default=None),
):
    user_id = _auth_user(authorization)
    member = storage.get_member(user_id)
    if not member:
        raise HTTPException(400, "未知账户")

    try:
        session = storage.get_session(user_id, session_id)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e

    message = (body.message or "").strip()
    images, attachment_notes, attach_names = _prepare_attachments(body.attachments or [])
    if not message and not attach_names:
        raise HTTPException(400, "请输入消息或上传附件")

    # 会话只记文字备注，不保存附件二进制
    stored_user = message or "（发送了附件）"
    if attach_names:
        stored_user += "\n📎 " + "、".join(attach_names) + "（仅本轮使用，未保存）"

    is_first = len(session.get("messages") or []) == 0 and not session.get("agent_id")
    storage.append_message(user_id, session_id, "user", stored_user)
    prompt = build_chat_prompt(
        member["name"],
        message,
        is_first=is_first,
        attachment_notes=attachment_notes,
    )
    agent_id = session.get("agent_id")

    queue: asyncio.Queue[str | None] = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def _emit(obj: dict) -> None:
        loop.call_soon_threadsafe(
            queue.put_nowait,
            json.dumps(obj, ensure_ascii=False),
        )

    def _worker() -> None:
        streamed = False
        try:
            nonlocal agent_id
            _emit({"type": "status", "message": "正在连接家庭医生助手…"})
            if agent_id:
                _emit({"type": "status", "message": "正在思考…"})
                run_id = create_run(agent_id, prompt, images=images or None)
            else:
                _emit({"type": "status", "message": "正在唤醒助手（首次稍慢）…"})
                agent_id, run_id = create_agent(prompt, images=images or None)

            _emit({"type": "meta", "agent_id": agent_id, "run_id": run_id})
            _emit({"type": "status", "message": "正在生成回复…"})

            chunks: list[str] = []

            def on_delta(t: str) -> None:
                nonlocal streamed
                streamed = True
                chunks.append(t)
                _emit({"type": "delta", "text": t})

            text, status = run_with_stream(agent_id, run_id, on_assistant=on_delta)
            final = (text or "".join(chunks)).strip()
            if not final:
                final = f"（助手未返回有效内容，状态：{status}）"

            if not streamed and final:
                step = 2
                for i in range(0, len(final), step):
                    _emit({"type": "delta", "text": final[i : i + step]})
                    time.sleep(0.018)

            storage.append_message(user_id, session_id, "assistant", final, agent_id=agent_id)
            _emit({"type": "done", "text": final, "status": status, "agent_id": agent_id})
        except Exception as e:  # noqa: BLE001
            err = str(e)
            storage.append_message(
                user_id,
                session_id,
                "assistant",
                f"抱歉，暂时无法完成回复：{err}",
                agent_id=agent_id,
            )
            _emit({"type": "error", "message": err})
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    async def event_gen():
        yield ": ok\n\n"
        yield f"data: {json.dumps({'type': 'status', 'message': '已收到问题，准备回复…'}, ensure_ascii=False)}\n\n"
        task = asyncio.create_task(asyncio.to_thread(_worker))
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                yield f"data: {item}\n\n"
        finally:
            await task

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/")
def index():
    return FileResponse(FRONTEND / "index.html")


app.mount("/static", StaticFiles(directory=str(FRONTEND)), name="static")


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8765"))
    uvicorn.run("backend.main:app", host=host, port=port, reload=False)
