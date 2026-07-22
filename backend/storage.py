"""本地文件存储：账户密码 + 私有会话。"""

from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import bcrypt

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
USERS_DIR = DATA_DIR / "users"
SESSIONS_DIR = DATA_DIR / "sessions"

MEMBERS = [
    {"id": "grape-dad", "name": "葡萄爸爸", "emoji": "👨", "color": "#00C2FF"},
    {"id": "grape", "name": "葡萄", "emoji": "🍇", "color": "#7C4DFF"},
    {"id": "grape-mom", "name": "葡萄妈妈", "emoji": "👩", "color": "#FF4D8D"},
    {"id": "grape-grandpa", "name": "葡萄爷爷", "emoji": "👴", "color": "#00E5A0"},
    {"id": "grape-grandma", "name": "葡萄奶奶", "emoji": "👵", "color": "#FFB020"},
    {"id": "grape-gpa-m", "name": "葡萄外公", "emoji": "🧓", "color": "#2EE6D6"},
    {"id": "grape-gma-m", "name": "葡萄外婆", "emoji": "👵", "color": "#FF6B4A"},
]

_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_dirs() -> None:
    USERS_DIR.mkdir(parents=True, exist_ok=True)
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    for m in MEMBERS:
        (SESSIONS_DIR / m["id"]).mkdir(parents=True, exist_ok=True)


def list_members() -> list[dict[str, Any]]:
    ensure_dirs()
    result = []
    for m in MEMBERS:
        user_path = USERS_DIR / f"{m['id']}.json"
        has_password = user_path.exists()
        result.append({**m, "has_password": has_password})
    return result


def _user_path(user_id: str) -> Path:
    return USERS_DIR / f"{user_id}.json"


def _session_dir(user_id: str) -> Path:
    d = SESSIONS_DIR / user_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def _session_path(user_id: str, session_id: str) -> Path:
    return _session_dir(user_id) / f"{session_id}.json"


def get_member(user_id: str) -> dict[str, Any] | None:
    for m in MEMBERS:
        if m["id"] == user_id:
            return m
    return None


def user_has_password(user_id: str) -> bool:
    return _user_path(user_id).exists()


def set_password(user_id: str, password: str) -> None:
    if not get_member(user_id):
        raise ValueError("未知账户")
    if len(password) < 4:
        raise ValueError("密码至少 4 位")
    ensure_dirs()
    hashed = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    with _lock:
        if _user_path(user_id).exists():
            raise ValueError("该账户已设置密码，请直接登录")
        data = {
            "id": user_id,
            "password_hash": hashed,
            "created_at": _now(),
            "updated_at": _now(),
        }
        _user_path(user_id).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def verify_password(user_id: str, password: str) -> bool:
    path = _user_path(user_id)
    if not path.exists():
        return False
    data = json.loads(path.read_text(encoding="utf-8"))
    return bcrypt.checkpw(password.encode("utf-8"), data["password_hash"].encode("utf-8"))


def login(user_id: str, password: str) -> dict[str, Any]:
    member = get_member(user_id)
    if not member:
        raise ValueError("未知账户")
    if not user_has_password(user_id):
        set_password(user_id, password)
        return {**member, "first_login": True}
    if not verify_password(user_id, password):
        raise ValueError("密码错误")
    return {**member, "first_login": False}


def list_sessions(user_id: str) -> list[dict[str, Any]]:
    if not get_member(user_id):
        raise ValueError("未知账户")
    ensure_dirs()
    items: list[dict[str, Any]] = []
    for p in sorted(_session_dir(user_id).glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            items.append(
                {
                    "id": data["id"],
                    "title": data.get("title") or "新对话",
                    "created_at": data.get("created_at"),
                    "updated_at": data.get("updated_at"),
                    "message_count": len(data.get("messages") or []),
                }
            )
        except Exception:
            continue
    return items


def create_session(user_id: str, title: str = "新对话") -> dict[str, Any]:
    if not get_member(user_id):
        raise ValueError("未知账户")
    ensure_dirs()
    session_id = uuid.uuid4().hex[:12]
    data = {
        "id": session_id,
        "user_id": user_id,
        "title": title,
        "agent_id": None,
        "messages": [],
        "created_at": _now(),
        "updated_at": _now(),
    }
    _session_path(user_id, session_id).write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return data


def get_session(user_id: str, session_id: str) -> dict[str, Any]:
    path = _session_path(user_id, session_id)
    if not path.exists():
        raise FileNotFoundError("会话不存在")
    return json.loads(path.read_text(encoding="utf-8"))


def _write_session(session: dict[str, Any]) -> None:
    user_id = session["user_id"]
    session_id = session["id"]
    session["updated_at"] = _now()
    _session_path(user_id, session_id).write_text(
        json.dumps(session, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def save_session(session: dict[str, Any]) -> None:
    with _lock:
        _write_session(session)


def delete_session(user_id: str, session_id: str) -> None:
    with _lock:
        path = _session_path(user_id, session_id)
        if not path.exists():
            raise FileNotFoundError("会话不存在")
        path.unlink()


def append_message(
    user_id: str,
    session_id: str,
    role: str,
    content: str,
    *,
    agent_id: str | None = None,
) -> dict[str, Any]:
    with _lock:
        session = get_session(user_id, session_id)
        session["messages"].append(
            {
                "id": uuid.uuid4().hex[:10],
                "role": role,
                "content": content,
                "created_at": _now(),
            }
        )
        if agent_id:
            session["agent_id"] = agent_id
        if role == "user" and (not session.get("title") or session["title"] == "新对话"):
            title = content.strip().replace("\n", " ")
            session["title"] = (title[:28] + "…") if len(title) > 28 else title
        _write_session(session)
        return session
