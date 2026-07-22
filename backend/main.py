"""葡萄个人助手家庭版 — FastAPI 后端。"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend import storage
from backend.cursor_client import (
    build_chat_prompt,
    create_agent,
    create_run,
    model_id,
    run_with_stream,
)

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

app = FastAPI(title="葡萄个人助手家庭版")
storage.ensure_dirs()

FRONTEND = ROOT / "frontend"
TOKEN_TTL = 60 * 60 * 24 * 30  # 30 days


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


class ChatBody(BaseModel):
    message: str = Field(min_length=1, max_length=8000)


class SessionCreateBody(BaseModel):
    title: str = "新对话"


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

    message = body.message.strip()
    if not message:
        raise HTTPException(400, "消息不能为空")

    is_first = len(session.get("messages") or []) == 0 and not session.get("agent_id")
    storage.append_message(user_id, session_id, "user", message)
    prompt = build_chat_prompt(member["name"], message, is_first=is_first)
    agent_id = session.get("agent_id")

    queue: asyncio.Queue[str | None] = asyncio.Queue()
    loop = asyncio.get_event_loop()

    def _worker() -> None:
        try:
            nonlocal agent_id
            if agent_id:
                run_id = create_run(agent_id, prompt)
            else:
                agent_id, run_id = create_agent(prompt)

            loop.call_soon_threadsafe(
                queue.put_nowait,
                json.dumps({"type": "meta", "agent_id": agent_id, "run_id": run_id}, ensure_ascii=False),
            )

            chunks: list[str] = []

            def on_delta(t: str) -> None:
                chunks.append(t)
                loop.call_soon_threadsafe(
                    queue.put_nowait,
                    json.dumps({"type": "delta", "text": t}, ensure_ascii=False),
                )

            text, status = run_with_stream(agent_id, run_id, on_assistant=on_delta)
            final = (text or "".join(chunks)).strip()
            if not final:
                final = f"（助手未返回有效内容，状态：{status}）"

            storage.append_message(user_id, session_id, "assistant", final, agent_id=agent_id)
            loop.call_soon_threadsafe(
                queue.put_nowait,
                json.dumps(
                    {"type": "done", "text": final, "status": status, "agent_id": agent_id},
                    ensure_ascii=False,
                ),
            )
        except Exception as e:  # noqa: BLE001
            err = str(e)
            storage.append_message(
                user_id,
                session_id,
                "assistant",
                f"抱歉，暂时无法完成回复：{err}",
                agent_id=agent_id,
            )
            loop.call_soon_threadsafe(
                queue.put_nowait,
                json.dumps({"type": "error", "message": err}, ensure_ascii=False),
            )
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    async def event_gen():
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
            "Cache-Control": "no-cache",
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
