const state = {
  token: localStorage.getItem("grape_token") || "",
  member: JSON.parse(localStorage.getItem("grape_member") || "null"),
  members: [],
  selected: null,
  sessions: [],
  currentId: null,
  sending: false,
  attachments: [], // { id, name, mime, data, previewUrl?, kind }
  recording: false,
  asrBusy: false,
  voiceMode: false,
  cancelRecord: false,
  autoTts: localStorage.getItem("grape_auto_tts") === "1",
};

const MAX_ATTACH = 5;
const MAX_FILE_SIZE = 12 * 1024 * 1024;

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
const stopBtn = $("#stop-btn");
const chatTitle = $("#chat-title");
const deleteBtn = $("#delete-session-btn");
const autoTtsBtn = $("#auto-tts-btn");
const fileInput = $("#file-input");
const attachPreview = $("#attach-preview");
const sidebar = $("#sidebar");
const sidebarMask = $("#sidebar-mask");
const menuBtn = $("#menu-btn");
const sidebarClose = $("#sidebar-close");
const modeBtn = $("#mode-btn");
const holdBtn = $("#hold-btn");
const voiceHint = $("#voice-hint");
const voiceOverlay = $("#voice-overlay");
const secureHint = $("#secure-hint");
const attachBtn = $("#attach-btn");

let mediaRecorder = null;
let mediaStream = null;
let recordChunks = [];
let currentAudio = null;
let sharedAudio = null; // 复用同一 Audio，避免自动播报被浏览器拦截
let audioUnlocked = false;
let ttsPlayToken = 0;
let chatAbort = null;
let recordMode = "none"; // mediarecorder | wav
let audioCtx = null;
let audioProcessor = null;
let audioSource = null;
let wavBuffers = [];
let wavSampleRate = 16000;
let holdStartY = 0;
let holdPointerId = null;
let recSession = 0; // 用于取消尚未完成的异步启动，避免遮罩卡住
let holding = false;
function openSidebar() {
  sidebar?.classList.add("open");
  sidebarMask?.classList.add("show");
  if (sidebarMask) sidebarMask.hidden = false;
}

function closeSidebar() {
  sidebar?.classList.remove("open");
  sidebarMask?.classList.remove("show");
  if (sidebarMask) sidebarMask.hidden = true;
}

menuBtn?.addEventListener("click", openSidebar);
sidebarClose?.addEventListener("click", closeSidebar);
sidebarMask?.addEventListener("click", closeSidebar);

if (window.marked) {
  marked.setOptions({ breaks: true, gfm: true });
}

function renderMarkdown(text) {
  const raw = String(text || "");
  if (!window.marked || !window.DOMPurify) {
    return escapeHtml(raw).replaceAll("\n", "<br>");
  }
  const html = marked.parse(raw);
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
  });
}

function setBubbleContent(el, text, { markdown = false, streaming = false } = {}) {
  el.dataset.rawText = text || "";
  const ttsBtn = el.querySelector(".btn-tts");
  if (markdown && el.classList.contains("assistant")) {
    el.innerHTML = `<div class="md">${renderMarkdown(text)}</div>`;
  } else {
    el.textContent = text;
  }
  if (streaming) el.classList.add("streaming");
  else el.classList.remove("streaming");
  if (ttsBtn && el.classList.contains("assistant") && !streaming) {
    el.appendChild(ttsBtn);
  } else if (el.classList.contains("assistant") && !streaming && text) {
    attachTtsButton(el);
  }
}

function attachTtsButton(bubble) {
  if (!bubble || !bubble.classList.contains("assistant")) return;
  if (bubble.querySelector(".btn-tts")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-tts tap";
  btn.title = "朗读回复";
  btn.setAttribute("aria-label", "朗读回复");
  btn.textContent = "🔊";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    playTts(bubble, btn);
  });
  bubble.appendChild(btn);
}

function stopCurrentAudio() {
  ttsPlayToken += 1; // 取消进行中的分句播放队列
  if (currentAudio) {
    try {
      currentAudio.pause();
      currentAudio.currentTime = 0;
    } catch {
      /* ignore */
    }
    currentAudio = null;
  }
  document.querySelectorAll(".btn-tts.playing, .btn-tts.loading").forEach((b) => {
    b.classList.remove("playing", "loading");
    b.textContent = "🔊";
  });
}

function syncAutoTtsButton() {
  if (!autoTtsBtn) return;
  autoTtsBtn.classList.toggle("on", state.autoTts);
  autoTtsBtn.setAttribute("aria-pressed", state.autoTts ? "true" : "false");
  autoTtsBtn.title = state.autoTts ? "关闭自动播报" : "开启自动播报";
  autoTtsBtn.setAttribute("aria-label", autoTtsBtn.title);
  autoTtsBtn.innerHTML = state.autoTts
    ? '<span class="ico" aria-hidden="true">🔊</span><span class="lbl">自动</span>'
    : '<span class="ico" aria-hidden="true">🔇</span>';
}

async function unlockAudioPlayback() {
  // 必须在用户手势里完成；后续自动播报复用同一 Audio 实例
  try {
    if (!sharedAudio) sharedAudio = new Audio();
    sharedAudio.src =
      "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
    sharedAudio.volume = 0.01;
    await sharedAudio.play();
    sharedAudio.pause();
    sharedAudio.currentTime = 0;
    audioUnlocked = true;
  } catch {
    audioUnlocked = false;
  }
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      if (!window.__grapeAudioCtx) window.__grapeAudioCtx = new AC();
      if (window.__grapeAudioCtx.state === "suspended") {
        await window.__grapeAudioCtx.resume();
      }
    }
  } catch {
    /* ignore */
  }
}

function stripTextForSpeech(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]+`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[*_]{1,3}/g, "")
    .replace(/^>\s+/gm, "")
    .replace(/[#>*`|_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSpeechText(text) {
  // 1.45 -> 1点45，避免被当成英文句号拆开，也更利于中文朗读
  return stripTextForSpeech(text).replace(/(\d)\.(\d)/g, "$1点$2");
}

function isSentenceBreak(text, index) {
  const ch = text[index];
  if ("。！？；!?\n".includes(ch)) return true;
  if (ch !== ".") return false;
  const prev = index > 0 ? text[index - 1] : "";
  const next = index + 1 < text.length ? text[index + 1] : "";
  if (/\d/.test(prev) && /\d/.test(next)) return false;
  if (/[A-Za-z0-9]/.test(prev) && /\d/.test(next)) return false;
  if (prev === "." || next === ".") return false;
  return true;
}

function splitSpeechSegments(text, maxChars = 72) {
  const clean = normalizeSpeechText(text);
  if (!clean) return [];
  const parts = [];
  let buf = "";
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    buf += ch;
    const atBreak = isSentenceBreak(clean, i);
    const tooLong = buf.length >= maxChars;
    if (tooLong && !atBreak) {
      const candidates = ["，", "、", "；", ",", " "].map((x) => buf.lastIndexOf(x));
      const cut = Math.max(...candidates);
      if (cut >= 12) {
        parts.push(buf.slice(0, cut + 1).trim());
        buf = buf.slice(cut + 1);
        continue;
      }
    }
    if ((atBreak || tooLong) && buf.trim()) {
      parts.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  const merged = [];
  for (const seg of parts) {
    const prev = merged[merged.length - 1];
    if (prev && prev.length < 12 && !"。！？!?.;".includes(prev.slice(-1))) {
      merged[merged.length - 1] += seg;
    } else {
      merged.push(seg);
    }
  }
  return merged;
}

function firstSpeechSentence(text) {
  const segs = splitSpeechSegments(text, 72);
  return segs[0] || "";
}

async function fetchTtsBlob(text) {
  const t0 = performance.now();
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${state.token}`,
    },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    let msg = err.detail || `语音合成失败 ${res.status}`;
    if (Array.isArray(msg)) msg = msg.map((x) => x.msg || JSON.stringify(x)).join("；");
    throw new Error(msg);
  }
  const blob = await res.blob();
  const timing = {
    chars: Number(res.headers.get("X-TTS-Chars") || 0),
    synthMs: Number(res.headers.get("X-TTS-Synth-Ms") || 0),
    downloadMs: Number(res.headers.get("X-TTS-Download-Ms") || 0),
    totalMs: Number(res.headers.get("X-TTS-Total-Ms") || 0),
    networkMs: Math.round(performance.now() - t0),
  };
  console.debug("[tts]", timing, text.slice(0, 24));
  return { blob, timing };
}

function playBlob(blob) {
  return new Promise((resolve, reject) => {
    if (!sharedAudio) sharedAudio = new Audio();
    const audio = sharedAudio;
    const url = URL.createObjectURL(blob);
    let settled = false;
    const cleanup = () => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
    };
    const finish = (err) => {
      if (settled) return;
      settled = true;
      audio.onended = null;
      audio.onerror = null;
      audio.oncanplay = null;
      if (currentAudio === audio) currentAudio = null;
      cleanup();
      if (err) reject(err);
      else resolve();
    };

    audio.onended = null;
    audio.onerror = null;
    audio.oncanplay = null;
    audio.pause();
    try {
      audio.currentTime = 0;
    } catch {
      /* ignore */
    }
    audio.src = url;
    audio.volume = 1;
    currentAudio = audio;

    audio.onended = () => finish();
    audio.onerror = () => finish(new Error("语音播放失败"));
    // 等缓冲好再播，避免句首被裁掉几个字
    const startPlay = () => {
      try {
        audio.currentTime = 0;
      } catch {
        /* ignore */
      }
      audio
        .play()
        .then(() => {
          audioUnlocked = true;
        })
        .catch((err) => finish(err));
    };
    if (audio.readyState >= 3) {
      startPlay();
    } else {
      audio.oncanplay = () => {
        audio.oncanplay = null;
        startPlay();
      };
      try {
        audio.load();
      } catch {
        startPlay();
      }
    }
  });
}

function maybeAutoPlayTts(bubble) {
  if (!state.autoTts || !bubble) return;
  const text = (bubble.dataset.rawText || "").trim();
  if (!text) return;
  if (text.startsWith("抱歉") || text.startsWith("（已停止") || text === "（无回复）") return;
  if (!bubble.querySelector(".btn-tts")) attachTtsButton(bubble);
  const ttsBtn = bubble.querySelector(".btn-tts");
  if (!ttsBtn) return;
  playTts(bubble, ttsBtn, { auto: true });
}

function prefetchFirstSentence(bubble, text) {
  if (!state.autoTts || !bubble) return;
  const first = firstSpeechSentence(text);
  if (!first || first.length < 6) return;
  if (bubble.dataset.ttsPrefetch === first) return;
  bubble.dataset.ttsPrefetch = first;
  const p = fetchTtsBlob(first)
    .then((r) => {
      bubble._ttsPrefetch = { text: first, blob: r.blob, timing: r.timing };
      return r;
    })
    .catch((err) => {
      console.debug("[tts] prefetch failed", err);
      bubble._ttsPrefetch = null;
    });
  bubble._ttsPrefetchPromise = p;
}

async function playTts(bubble, btn, { auto = false } = {}) {
  const text = (bubble.dataset.rawText || bubble.textContent || "").trim();
  if (!text || text.startsWith("抱歉") || text === "（无回复）" || text.startsWith("（已停止")) return;

  if (!auto && btn.classList.contains("playing") && currentAudio) {
    stopCurrentAudio();
    return;
  }

  stopCurrentAudio();
  const token = ttsPlayToken;
  btn.classList.add("loading");
  btn.textContent = "…";
  try {
    if (auto && !audioUnlocked) {
      await unlockAudioPlayback();
    }
    const segments = splitSpeechSegments(text);
    if (!segments.length) return;

    btn.classList.remove("loading");
    btn.classList.add("playing");
    btn.textContent = "⏸";

    // 首句若已在流式阶段预取，直接用
    let nextFetch = null;
    const pref = bubble._ttsPrefetch;
    if (pref && pref.text === segments[0] && pref.blob) {
      nextFetch = Promise.resolve({ blob: pref.blob, timing: pref.timing || {} });
    } else if (bubble._ttsPrefetchPromise && bubble.dataset.ttsPrefetch === segments[0]) {
      nextFetch = bubble._ttsPrefetchPromise.then((r) => {
        if (r?.blob) return r;
        return fetchTtsBlob(segments[0]);
      });
    } else {
      nextFetch = fetchTtsBlob(segments[0]);
    }

    for (let i = 0; i < segments.length; i++) {
      if (token !== ttsPlayToken) return;
      const current = await nextFetch;
      if (token !== ttsPlayToken) return;
      if (i + 1 < segments.length) {
        nextFetch = fetchTtsBlob(segments[i + 1]); // 播放当前句时预取下一句
      }
      await playBlob(current.blob);
    }
  } catch (err) {
    if (token !== ttsPlayToken) return;
    btn.classList.remove("loading", "playing");
    btn.textContent = "🔊";
    if (auto && (err?.name === "NotAllowedError" || /interact|user gesture|not allowed/i.test(String(err?.message || "")))) {
      state.autoTts = false;
      localStorage.setItem("grape_auto_tts", "0");
      syncAutoTtsButton();
      alert("浏览器拦截了自动播报，请再点一次右上角开启，并保持页面互动");
      return;
    }
    if (!auto) alert(err.message || "语音合成失败");
  } finally {
    if (token === ttsPlayToken) {
      btn.classList.remove("loading", "playing");
      btn.textContent = "🔊";
    }
  }
}

autoTtsBtn?.addEventListener("click", async () => {
  state.autoTts = !state.autoTts;
  localStorage.setItem("grape_auto_tts", state.autoTts ? "1" : "0");
  syncAutoTtsButton();
  if (state.autoTts) {
    await unlockAudioPlayback();
  } else {
    stopCurrentAudio();
  }
});
syncAutoTtsButton();

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("音频读取失败"));
    reader.readAsDataURL(blob);
  });
}

function isSecureForMic() {
  if (window.isSecureContext) return true;
  const host = location.hostname;
  return host === "localhost" || host === "127.0.0.1";
}

function getMediaDevices() {
  if (navigator.mediaDevices?.getUserMedia) return navigator.mediaDevices;
  const legacy =
    navigator.getUserMedia ||
    navigator.webkitGetUserMedia ||
    navigator.mozGetUserMedia ||
    navigator.msGetUserMedia;
  if (!legacy) return null;
  return {
    getUserMedia: (constraints) =>
      new Promise((resolve, reject) => {
        legacy.call(navigator, constraints, resolve, reject);
      }),
  };
}

function pickRecorderMime() {
  if (!window.MediaRecorder) return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/aac",
    "audio/ogg;codecs=opus",
  ];
  for (const m of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      /* ignore */
    }
  }
  return "";
}

function encodeWav(floatChunks, sampleRate) {
  let len = 0;
  for (const c of floatChunks) len += c.length;
  const samples = new Float32Array(len);
  let offset = 0;
  for (const c of floatChunks) {
    samples.set(c, offset);
    offset += c.length;
  }
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (o, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let p = 44;
  for (let i = 0; i < samples.length; i++, p += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function setVoiceMode(on) {
  state.voiceMode = !!on;
  if (inputEl) inputEl.hidden = state.voiceMode;
  if (holdBtn) holdBtn.hidden = !state.voiceMode;
  if (modeBtn) {
    modeBtn.textContent = state.voiceMode ? "⌨️" : "🎤";
    modeBtn.title = state.voiceMode ? "切换文字输入" : "切换语音输入";
    modeBtn.setAttribute("aria-label", modeBtn.title);
  }
  document.querySelector(".composer")?.classList.toggle("voice-mode", state.voiceMode);
  updateSendState();
}

function setRecordingUi(on, { canceling = false, recognizing = false } = {}) {
  state.recording = !!on && !recognizing;
  holdBtn?.classList.toggle("recording", on && !canceling && !recognizing);
  holdBtn?.classList.toggle("canceling", on && canceling);
  holdBtn?.classList.toggle("busy", recognizing);
  voiceOverlay?.classList.toggle("hidden", !on && !recognizing);
  voiceOverlay?.classList.toggle("canceling", canceling);
  voiceOverlay?.classList.toggle("recognizing", recognizing);
  if (voiceHint) {
    if (recognizing) voiceHint.textContent = "正在识别…";
    else if (!on) voiceHint.textContent = "松开发送，上滑取消";
    else if (canceling) voiceHint.textContent = "松开手指，取消发送";
    else voiceHint.textContent = "松开发送，上滑取消";
  }
  if (holdBtn) {
    if (recognizing) holdBtn.textContent = "识别中…";
    else if (!on) holdBtn.textContent = "按住 说话";
    else holdBtn.textContent = canceling ? "松开 取消" : "松开 结束";
  }
}

function httpsEntryUrl() {
  const host = location.hostname;
  if (host.endsWith("sslip.io") || host.endsWith("nip.io")) {
    return `https://${host}`;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return `https://${host}.sslip.io`;
  }
  return `https://${host}`;
}

function micBlockedReason() {
  if (!isSecureForMic()) {
    return `语音功能需要 HTTPS。请用微信或浏览器打开：${httpsEntryUrl()}`;
  }
  if (!getMediaDevices()) {
    return "当前环境无法使用麦克风，请换用系统浏览器或升级微信后重试";
  }
  return "";
}

function refreshSecureHint() {
  if (!secureHint) return;
  if (!isSecureForMic()) {
    secureHint.innerHTML = `语音需 HTTPS，请访问 <a href="${httpsEntryUrl()}">${httpsEntryUrl()}</a>`;
    secureHint.classList.remove("hidden");
  } else {
    secureHint.classList.add("hidden");
  }
}

async function acquireMicStream() {
  if (!isSecureForMic()) {
    throw new Error(
      "当前为 HTTP 访问，浏览器禁止录音。请使用 HTTPS 打开本站（微信内尤其需要）。"
    );
  }
  const devices = getMediaDevices();
  if (!devices) {
    throw new Error("当前浏览器不支持麦克风，请升级微信或改用系统浏览器");
  }
  try {
    return await devices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
      },
    });
  } catch (err) {
    const name = err?.name || "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      throw new Error("麦克风权限被拒绝，请在系统/微信设置中允许使用麦克风");
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      throw new Error("未检测到麦克风设备");
    }
    throw new Error(err?.message || "无法打开麦克风");
  }
}

function cleanupMic() {
  try {
    audioProcessor?.disconnect();
  } catch {
    /* ignore */
  }
  try {
    audioSource?.disconnect();
  } catch {
    /* ignore */
  }
  if (audioCtx) {
    audioCtx.close().catch(() => {});
  }
  audioProcessor = null;
  audioSource = null;
  audioCtx = null;
  try {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  } catch {
    /* ignore */
  }
  mediaStream?.getTracks().forEach((t) => t.stop());
  mediaStream = null;
  mediaRecorder = null;
  recordMode = "none";
  recordChunks = [];
  wavBuffers = [];
}

async function beginCapture(session) {
  mediaStream = await acquireMicStream();
  if (session !== recSession || !holding) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
    return false;
  }

  recordChunks = [];
  wavBuffers = [];
  const mime = pickRecorderMime();

  if (window.MediaRecorder) {
    try {
      mediaRecorder = mime
        ? new MediaRecorder(mediaStream, { mimeType: mime })
        : new MediaRecorder(mediaStream);
      recordMode = "mediarecorder";
      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordChunks.push(e.data);
      };
      mediaRecorder.start(200);
      if (session !== recSession || !holding) {
        cleanupMic();
        return false;
      }
      setRecordingUi(true);
      return true;
    } catch {
      mediaRecorder = null;
    }
  }

  // iOS / 部分微信：无 MediaRecorder 时用 AudioContext 录 WAV
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) {
    cleanupMic();
    throw new Error("当前浏览器无法录音，请升级微信或改用系统 Safari / Chrome");
  }
  audioCtx = new AC();
  if (audioCtx.state === "suspended") await audioCtx.resume();
  if (session !== recSession || !holding) {
    cleanupMic();
    return false;
  }
  audioSource = audioCtx.createMediaStreamSource(mediaStream);
  const bufferSize = 4096;
  audioProcessor = audioCtx.createScriptProcessor(bufferSize, 1, 1);
  wavSampleRate = audioCtx.sampleRate;
  audioProcessor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    wavBuffers.push(new Float32Array(input));
  };
  const mute = audioCtx.createGain();
  mute.gain.value = 0;
  audioSource.connect(audioProcessor);
  audioProcessor.connect(mute);
  mute.connect(audioCtx.destination);
  recordMode = "wav";
  setRecordingUi(true);
  return true;
}

async function finishCapture({ cancel = false } = {}) {
  const shouldCancel = cancel || state.cancelRecord;
  const mode = recordMode;
  const chunks = recordChunks;
  const wav = wavBuffers;
  const sr = wavSampleRate;
  const mimeType =
    (mediaRecorder && mediaRecorder.mimeType) || pickRecorderMime() || "audio/webm";

  if (mode === "mediarecorder" && mediaRecorder && mediaRecorder.state !== "inactive") {
    await new Promise((resolve) => {
      const done = () => resolve();
      mediaRecorder.onstop = done;
      try {
        mediaRecorder.stop();
      } catch {
        done();
      }
      setTimeout(done, 800);
    });
  }

  cleanupMic();
  setRecordingUi(false);

  if (shouldCancel) return;

  let blob = null;
  let mime = mimeType;
  if (mode === "mediarecorder") {
    if (!chunks.length) return;
    blob = new Blob(chunks, { type: mimeType });
  } else if (mode === "wav") {
    if (!wav.length) return;
    blob = encodeWav(wav, sr);
    mime = "audio/wav";
  } else {
    return;
  }

  // 太短的录音直接忽略，避免误触
  if (blob.size < 800) return;
  await transcribeAudio(blob, mime);
}

async function transcribeAudio(blob, mimeType) {
  state.asrBusy = true;
  updateSendState();
  setRecordingUi(false, { recognizing: true });
  voiceOverlay?.classList.remove("hidden");
  if (voiceHint) voiceHint.textContent = "正在识别…";
  if (holdBtn) holdBtn.textContent = "识别中…";
  try {
    const dataUrl = await blobToBase64(blob);
    const data = await api("/api/asr", {
      method: "POST",
      body: JSON.stringify({
        audio: dataUrl,
        mime: (mimeType || "audio/webm").split(";")[0],
      }),
    });
    const text = (data.text || "").trim();
    if (!text) {
      alert("没有听清，请再说一次");
      return;
    }
    if (state.voiceMode) {
      inputEl.value = text;
      updateSendState();
      await sendMessage();
    } else {
      const cur = inputEl.value.trim();
      inputEl.value = cur ? `${cur}${text}` : text;
      inputEl.style.height = "auto";
      inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
      updateSendState();
      inputEl.focus();
    }
  } catch (err) {
    alert(err.message || "语音识别失败");
  } finally {
    state.asrBusy = false;
    setRecordingUi(false);
    voiceOverlay?.classList.add("hidden");
    if (holdBtn) holdBtn.textContent = "按住 说话";
    updateSendState();
  }
}

async function onHoldStart(e) {
  if (state.sending || state.asrBusy || holding) return;
  e.preventDefault();
  if (e.pointerId != null && holdBtn?.setPointerCapture) {
    try {
      holdBtn.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }
  holding = true;
  holdPointerId = e.pointerId ?? null;
  holdStartY = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
  state.cancelRecord = false;
  const session = ++recSession;
  holdBtn?.classList.add("recording");
  if (holdBtn) holdBtn.textContent = "准备中…";
  try {
    const ok = await beginCapture(session);
    if (!ok) {
      if (session === recSession) {
        setRecordingUi(false);
        holding = false;
      }
      return;
    }
  } catch (err) {
    if (session === recSession) {
      cleanupMic();
      setRecordingUi(false);
      holding = false;
      alert(err.message || "无法开始录音");
    }
  }
}

function onHoldMove(e) {
  if (!holding || !state.recording) return;
  const y = e.clientY ?? e.touches?.[0]?.clientY ?? holdStartY;
  const canceling = holdStartY - y > 60;
  state.cancelRecord = canceling;
  setRecordingUi(true, { canceling });
}

async function onHoldEnd(e) {
  e?.preventDefault?.();
  if (!holding) return;
  const cancel = state.cancelRecord;
  holding = false;
  holdPointerId = null;
  // 使任何仍在启动中的会话失效
  recSession += 1;
  if (!state.recording && recordMode === "none") {
    cleanupMic();
    setRecordingUi(false);
    return;
  }
  await finishCapture({ cancel });
}

modeBtn?.addEventListener("click", () => {
  if (state.sending || state.asrBusy || holding || state.recording) return;
  const next = !state.voiceMode;
  if (next) {
    const reason = micBlockedReason();
    if (reason && !isSecureForMic()) {
      alert(reason);
      refreshSecureHint();
      return;
    }
  }
  setVoiceMode(next);
});

if (holdBtn) {
  holdBtn.addEventListener("pointerdown", onHoldStart);
  holdBtn.addEventListener("pointermove", onHoldMove);
  holdBtn.addEventListener("pointerup", onHoldEnd);
  holdBtn.addEventListener("pointercancel", onHoldEnd);
  holdBtn.addEventListener("lostpointercapture", onHoldEnd);
  holdBtn.addEventListener("contextmenu", (e) => e.preventDefault());
}

stopBtn?.addEventListener("click", () => {
  if (!state.sending || !chatAbort) return;
  chatAbort.abort();
});

refreshSecureHint();
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
  clearAttachments();
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
    row.querySelector(".meta").addEventListener("click", () => {
      openSession(s.id);
      closeSidebar();
    });
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
  clearAttachments();
  await refreshSessions();
  await openSession(data.session.id);
}

async function openSession(id) {
  const data = await api(`/api/sessions/${id}`);
  state.currentId = id;
  chatTitle.textContent = data.session.title || "新对话";
  deleteBtn.classList.remove("hidden");
  clearAttachments();
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

$("#new-session-btn").addEventListener("click", () => {
  createSession();
  closeSidebar();
});
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
    appendBubble(m.role, m.content, { markdown: m.role === "assistant" });
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

function appendBubble(role, content, { markdown = false, streaming = false, previews = [] } = {}) {
  const el = document.createElement("div");
  el.className = `bubble ${role}` + (streaming ? " streaming" : "");
  if (role === "assistant" && (markdown || streaming)) {
    setBubbleContent(el, content, { markdown: true, streaming });
  } else {
    el.dataset.rawText = content || "";
    el.textContent = content;
  }
  if (role === "user" && previews.length) {
    const box = document.createElement("div");
    box.className = "user-attach";
    for (const p of previews) {
      if (p.previewUrl) {
        const img = document.createElement("img");
        img.src = p.previewUrl;
        img.alt = p.name;
        box.appendChild(img);
      } else {
        const chip = document.createElement("span");
        chip.className = "file-chip";
        chip.textContent = `📄 ${p.name}`;
        box.appendChild(chip);
      }
    }
    el.appendChild(box);
  }
  if (role === "assistant" && !streaming && content) {
    attachTtsButton(el);
  }
  messagesEl.appendChild(el);
  scrollBottom();
  return el;
}

function scrollBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function updateSendState() {
  const hasText = !!inputEl.value.trim();
  const hasFile = state.attachments.length > 0;
  const canSend =
    !state.sending &&
    !state.asrBusy &&
    !holding &&
    !state.recording &&
    !!state.currentId &&
    (hasText || hasFile) &&
    !state.voiceMode;

  sendBtn.disabled = !canSend;
  sendBtn.classList.toggle("hidden", state.sending || state.voiceMode);
  stopBtn?.classList.toggle("hidden", !state.sending);

  if (attachBtn) attachBtn.disabled = state.sending || holding || state.recording || state.asrBusy;
  if (modeBtn) modeBtn.disabled = state.sending || holding || state.recording || state.asrBusy;
  if (holdBtn) holdBtn.disabled = state.sending || state.asrBusy;
  if (inputEl) inputEl.readOnly = state.sending;
}

function clearAttachments() {
  for (const a of state.attachments) {
    if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
  }
  state.attachments = [];
  renderAttachPreview();
  updateSendState();
}

function renderAttachPreview() {
  attachPreview.innerHTML = "";
  if (!state.attachments.length) {
    attachPreview.classList.add("hidden");
    return;
  }
  attachPreview.classList.remove("hidden");
  for (const a of state.attachments) {
    const chip = document.createElement("div");
    chip.className = "attach-chip";
    if (a.previewUrl) {
      chip.innerHTML = `<img src="${a.previewUrl}" alt="" /><div class="meta">${escapeHtml(a.name)}</div>`;
    } else {
      chip.innerHTML = `<div class="meta">📄 ${escapeHtml(a.name)}</div>`;
    }
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "rm";
    rm.textContent = "×";
    rm.addEventListener("click", () => {
      state.attachments = state.attachments.filter((x) => x.id !== a.id);
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      renderAttachPreview();
      updateSendState();
    });
    chip.appendChild(rm);
    attachPreview.appendChild(chip);
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(`读取失败：${file.name}`));
    reader.readAsDataURL(file);
  });
}

$("#attach-btn").addEventListener("click", () => fileInput.click());

async function addFiles(fileList) {
  const files = [...(fileList || [])];
  for (const file of files) {
    if (state.attachments.length >= MAX_ATTACH) {
      alert(`一次最多 ${MAX_ATTACH} 个附件`);
      break;
    }
    if (file.size > MAX_FILE_SIZE) {
      alert(`${file.name || "文件"} 超过 12MB，已跳过`);
      continue;
    }
    try {
      const dataUrl = await readFileAsBase64(file);
      const mime = file.type || "application/octet-stream";
      const isImage = mime.startsWith("image/");
      state.attachments.push({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: file.name || `paste-${Date.now()}${isImage ? ".png" : ""}`,
        mime,
        data: dataUrl,
        previewUrl: isImage ? URL.createObjectURL(file) : null,
        kind: isImage ? "image" : "file",
      });
    } catch (err) {
      alert(err.message);
    }
  }
  renderAttachPreview();
  updateSendState();
}

fileInput.addEventListener("change", async () => {
  await addFiles(fileInput.files);
  fileInput.value = "";
});

inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
  updateSendState();
});

inputEl.addEventListener("keydown", (e) => {
  // 中文输入法选词常按回车；改为 Option/Alt+Enter 发送，普通回车换行
  if (e.key !== "Enter") return;
  if (e.isComposing || e.keyCode === 229) return;
  if (e.altKey || e.metaKey) {
    e.preventDefault();
    if (state.sending) return;
    if (!sendBtn.disabled) sendMessage();
  }
});

// 粘贴图片/文件（剪贴板 items + files）
inputEl.addEventListener("paste", async (e) => {
  if (state.sending) return;
  const cd = e.clipboardData;
  if (!cd) return;

  const fromItems = [...(cd.items || [])]
    .filter((i) => i.kind === "file")
    .map((i) => i.getAsFile())
    .filter(Boolean);
  const fromFiles = [...(cd.files || [])];
  const seen = new Set();
  const files = [];
  for (const f of [...fromItems, ...fromFiles]) {
    const key = `${f.name}-${f.size}-${f.lastModified || 0}-${f.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(f);
  }
  if (!files.length) return;

  e.preventDefault();
  await addFiles(files);
});

// 拖拽文件到输入区
["dragenter", "dragover"].forEach((evt) => {
  inputEl.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
});
inputEl.addEventListener("drop", async (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (state.sending) return;
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) await addFiles(files);
});

$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  if (state.sending) return;
  sendMessage();
});

async function sendMessage() {
  const text = inputEl.value.trim();
  const pending = [...state.attachments];
  if ((!text && !pending.length) || state.sending || !state.currentId) return;

  messagesEl.querySelector(".welcome")?.remove();

  state.sending = true;
  chatAbort = new AbortController();
  // 发送手势里再解锁一次，提高自动播报成功率（尤其微信）
  if (state.autoTts) unlockAudioPlayback();
  updateSendState();
  inputEl.value = "";
  inputEl.style.height = "auto";

  const previews = pending.map((a) => ({
    name: a.name,
    previewUrl: a.previewUrl,
  }));
  appendBubble("user", text || "（附件）", { previews });

  // 清空待发送附件（内存释放在请求后）
  state.attachments = [];
  renderAttachPreview();

  const bubble = appendBubble("assistant", "正在连接…", { markdown: true, streaming: true });
  bubble.dataset.status = "1";

  let aborted = false;
  try {
    const res = await fetch(`/api/sessions/${state.currentId}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.token}`,
      },
      body: JSON.stringify({
        message: text,
        attachments: pending.map((a) => ({
          name: a.name,
          mime: a.mime,
          data: a.data,
        })),
      }),
      signal: chatAbort.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      let msg = err.detail || `发送失败 ${res.status}`;
      if (Array.isArray(msg)) msg = msg.map((x) => x.msg || JSON.stringify(x)).join("；");
      throw new Error(msg);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalText = "";
    let gotDelta = false;
    let lastRender = 0;

    while (true) {
      let readResult;
      try {
        readResult = await reader.read();
      } catch (err) {
        if (err?.name === "AbortError" || chatAbort?.signal?.aborted) {
          aborted = true;
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          break;
        }
        throw err;
      }
      const { done, value } = readResult;
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
        if (payload.type === "status" && payload.message && !gotDelta) {
          setBubbleContent(bubble, payload.message, { markdown: false, streaming: true });
          scrollBottom();
        } else if (payload.type === "delta" && payload.text) {
          if (!gotDelta) {
            gotDelta = true;
            finalText = "";
          }
          if (payload.text.startsWith(finalText) && payload.text.length >= finalText.length) {
            finalText = payload.text;
          } else {
            finalText += payload.text;
          }
          // 自动播报：首句一完整就开始后台合成，缩短“说完才等 TTS”的空窗
          if (state.autoTts && /[。！？!?]/.test(finalText)) {
            prefetchFirstSentence(bubble, finalText);
          }
          const now = Date.now();
          if (now - lastRender > 40) {
            setBubbleContent(bubble, finalText, { markdown: true, streaming: true });
            lastRender = now;
            scrollBottom();
          }
        } else if (payload.type === "done") {
          finalText = payload.text || finalText;
          setBubbleContent(bubble, finalText, { markdown: true, streaming: false });
          scrollBottom();
        } else if (payload.type === "error") {
          setBubbleContent(bubble, `抱歉，暂时无法完成回复：${payload.message}`, {
            markdown: false,
            streaming: false,
          });
        }
      }
    }

    if (aborted) {
      const partial = finalText.trim();
      setBubbleContent(
        bubble,
        partial ? `${partial}\n\n（已停止生成）` : "（已停止生成）",
        { markdown: !!partial, streaming: false }
      );
    } else if (finalText) {
      setBubbleContent(bubble, finalText, { markdown: true, streaming: false });
      maybeAutoPlayTts(bubble);
    } else if (!bubble.textContent || bubble.dataset.status === "1") {
      setBubbleContent(bubble, "（无回复）", { markdown: false, streaming: false });
    }
    delete bubble.dataset.status;
    await refreshSessions();
    const cur = state.sessions.find((s) => s.id === state.currentId);
    if (cur) chatTitle.textContent = cur.title || "新对话";
  } catch (err) {
    if (err?.name === "AbortError" || chatAbort?.signal?.aborted) {
      setBubbleContent(bubble, "（已停止生成）", { markdown: false, streaming: false });
    } else {
      setBubbleContent(bubble, `抱歉，出错了：${err.message}`, { markdown: false, streaming: false });
    }
  } finally {
    for (const a of pending) {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    }
    chatAbort = null;
    state.sending = false;
    updateSendState();
    if (!state.voiceMode) inputEl.focus();
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
