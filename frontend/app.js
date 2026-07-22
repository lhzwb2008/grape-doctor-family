const state = {
  token: localStorage.getItem("grape_token") || "",
  member: JSON.parse(localStorage.getItem("grape_member") || "null"),
  members: [],
  selected: null,
  sessions: [],
  currentId: null,
  sending: false,
};

const $ = (sel) => document.querySelector(sel);
const loginView = $("#login-view");
const chatView = $("#chat-view");
const memberGrid = $("#member-grid");
const loginForm = $("#login-form");
const passwordInput = $("#password-input");
const passwordLabel = $("#password-label");
const loginHint = $("#login-hint");
const loginError = $("#login-error");
const selectedChip = $("#selected-chip");
const sessionList = $("#session-list");
const messagesEl = $("#messages");
const welcomeEl = $("#welcome");
const inputEl = $("#input");
const sendBtn = $("#send-btn");
const chatTitle = $("#chat-title");
const deleteBtn = $("#delete-session-btn");

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    let msg = data.detail || data.message || `请求失败 ${res.status}`;
    if (Array.isArray(msg)) {
      msg = msg.map((x) => x.msg || JSON.stringify(x)).join("；");
    } else if (typeof msg !== "string") {
      msg = JSON.stringify(msg);
    }
    throw new Error(msg);
  }
  return data;
}

function showLogin() {
  loginView.classList.remove("hidden");
  chatView.classList.add("hidden");
}

function showChat() {
  loginView.classList.add("hidden");
  chatView.classList.remove("hidden");
  $("#side-user").textContent = `${state.member.emoji} ${state.member.name}`;
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function loadMembers() {
  const data = await api("/api/members");
  state.members = data.members;
  memberGrid.innerHTML = "";
  for (const m of state.members) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "member-card";
    btn.style.setProperty("--member-color", m.color);
    btn.innerHTML = `
      <div class="member-emoji">${m.emoji}</div>
      <div class="member-name">${m.name}</div>
      <div class="member-status ${m.has_password ? "set" : "new"}">
        ${m.has_password ? "已设密码" : "首次设置密码"}
      </div>`;
    btn.addEventListener("click", () => selectMember(m));
    memberGrid.appendChild(btn);
  }
}

function selectMember(m) {
  state.selected = m;
  for (const el of memberGrid.children) el.classList.remove("active");
  const cards = [...memberGrid.children];
  const idx = state.members.findIndex((x) => x.id === m.id);
  if (cards[idx]) cards[idx].classList.add("active");

  loginForm.classList.remove("hidden");
  selectedChip.style.setProperty("--member-color", m.color);
  selectedChip.textContent = `${m.emoji} ${m.name}`;
  if (m.has_password) {
    passwordLabel.textContent = "输入登录密码";
    loginHint.textContent = "请输入该账户密码以进入私有对话空间。";
  } else {
    passwordLabel.textContent = "设置登录密码";
    loginHint.textContent = "首次进入请设置专属密码，之后需输入密码才能进入。";
  }
  loginError.classList.add("hidden");
  passwordInput.value = "";
  passwordInput.focus();
}

$("#back-btn").addEventListener("click", () => {
  state.selected = null;
  loginForm.classList.add("hidden");
  for (const el of memberGrid.children) el.classList.remove("active");
});

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.selected) return;
  loginError.classList.add("hidden");
  const btn = $("#login-btn");
  btn.disabled = true;
  btn.textContent = "登录中…";
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        user_id: state.selected.id,
        password: passwordInput.value,
      }),
    });
    state.token = data.token;
    state.member = data.member;
    localStorage.setItem("grape_token", state.token);
    localStorage.setItem("grape_member", JSON.stringify(state.member));
    showChat();
    await bootChat();
  } catch (err) {
    loginError.textContent = err.message;
    loginError.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "进入助手";
  }
});

$("#logout-btn").addEventListener("click", () => {
  state.token = "";
  state.member = null;
  state.currentId = null;
  localStorage.removeItem("grape_token");
  localStorage.removeItem("grape_member");
  showLogin();
  loadMembers();
});

async function bootChat() {
  await refreshSessions();
  if (state.sessions.length === 0) {
    await createSession();
  } else {
    await openSession(state.sessions[0].id);
  }
}

async function refreshSessions() {
  const data = await api("/api/sessions");
  state.sessions = data.sessions;
  renderSessions();
}

function renderSessions() {
  sessionList.innerHTML = "";
  for (const s of state.sessions) {
    const row = document.createElement("div");
    row.className = "session-item" + (s.id === state.currentId ? " active" : "");
    row.innerHTML = `
      <div class="meta">
        <div class="title">${escapeHtml(s.title || "新对话")}</div>
        <div class="time">${fmtTime(s.updated_at)}</div>
      </div>
      <button class="del" title="删除" type="button">✕</button>`;
    row.querySelector(".meta").addEventListener("click", () => openSession(s.id));
    row.querySelector(".del").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteSession(s.id);
    });
    sessionList.appendChild(row);
  }
}

async function createSession() {
  const data = await api("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ title: "新对话" }),
  });
  await refreshSessions();
  await openSession(data.session.id);
}

async function openSession(id) {
  const data = await api(`/api/sessions/${id}`);
  state.currentId = id;
  chatTitle.textContent = data.session.title || "新对话";
  deleteBtn.classList.remove("hidden");
  renderSessions();
  renderMessages(data.session.messages || []);
}

async function deleteSession(id) {
  if (!confirm("确定删除该对话？删除后无法恢复。")) return;
  await api(`/api/sessions/${id}`, { method: "DELETE" });
  if (state.currentId === id) state.currentId = null;
  await refreshSessions();
  if (state.sessions.length) {
    await openSession(state.sessions[0].id);
  } else {
    await createSession();
  }
}

$("#new-session-btn").addEventListener("click", () => createSession());
deleteBtn.addEventListener("click", () => {
  if (state.currentId) deleteSession(state.currentId);
});

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderMessages(messages) {
  messagesEl.innerHTML = "";
  if (!messages.length) {
    messagesEl.appendChild(welcomeEl.cloneNode(true));
    bindSuggests(messagesEl.querySelector(".welcome"));
    return;
  }
  for (const m of messages) {
    appendBubble(m.role, m.content);
  }
  scrollBottom();
}

function bindSuggests(root) {
  if (!root) return;
  root.querySelectorAll("[data-q]").forEach((btn) => {
    btn.addEventListener("click", () => {
      inputEl.value = btn.dataset.q;
      updateSendState();
      sendMessage();
    });
  });
}

function appendBubble(role, content, streaming = false) {
  const el = document.createElement("div");
  el.className = `bubble ${role}` + (streaming ? " streaming" : "");
  el.textContent = content;
  messagesEl.appendChild(el);
  scrollBottom();
  return el;
}

function showTyping() {
  const el = document.createElement("div");
  el.className = "typing";
  el.id = "typing";
  el.innerHTML = "<i></i><i></i><i></i>";
  messagesEl.appendChild(el);
  scrollBottom();
}

function hideTyping() {
  $("#typing")?.remove();
}

function scrollBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function updateSendState() {
  sendBtn.disabled = state.sending || !inputEl.value.trim() || !state.currentId;
}

inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
  updateSendState();
});

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) sendMessage();
  }
});

$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessage();
});

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || state.sending || !state.currentId) return;

  // remove welcome
  messagesEl.querySelector(".welcome")?.remove();

  state.sending = true;
  updateSendState();
  inputEl.value = "";
  inputEl.style.height = "auto";
  appendBubble("user", text);
  showTyping();

  try {
    const res = await fetch(`/api/sessions/${state.currentId}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.token}`,
      },
      body: JSON.stringify({ message: text }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `发送失败 ${res.status}`);
    }

    hideTyping();
    const bubble = appendBubble("assistant", "", true);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const part of parts) {
        const line = part.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        let payload;
        try {
          payload = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (payload.type === "delta" && payload.text) {
          // SSE 可能推送增量或累计文本；这里做简单拼接，并去重累计
          if (payload.text.startsWith(finalText)) {
            finalText = payload.text;
          } else {
            finalText += payload.text;
          }
          bubble.textContent = finalText;
          scrollBottom();
        } else if (payload.type === "done") {
          finalText = payload.text || finalText;
          bubble.textContent = finalText;
          bubble.classList.remove("streaming");
        } else if (payload.type === "error") {
          bubble.textContent = `抱歉，暂时无法完成回复：${payload.message}`;
          bubble.classList.remove("streaming");
        }
      }
    }
    bubble.classList.remove("streaming");
    if (!bubble.textContent) bubble.textContent = "（无回复）";
    await refreshSessions();
    const cur = state.sessions.find((s) => s.id === state.currentId);
    if (cur) chatTitle.textContent = cur.title || "新对话";
  } catch (err) {
    hideTyping();
    appendBubble("assistant", `抱歉，出错了：${err.message}`);
  } finally {
    state.sending = false;
    updateSendState();
    inputEl.focus();
  }
}

async function init() {
  await loadMembers();
  if (state.token && state.member) {
    try {
      await api("/api/me");
      showChat();
      await bootChat();
      return;
    } catch {
      localStorage.removeItem("grape_token");
      localStorage.removeItem("grape_member");
      state.token = "";
      state.member = null;
    }
  }
  showLogin();
}

init();
