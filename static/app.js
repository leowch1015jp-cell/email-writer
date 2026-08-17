const STORAGE_KEY = "yixin-draft-v1";
const SETTINGS_KEY = "yixin-settings-v1";

const EMAIL_TYPES = [
  { id: "reply", label: "回覆來電", hint: "根據對方來信寫回覆" },
  { id: "request", label: "工作請求", hint: "請對方做一件事、給資源或拍板" },
  { id: "followup", label: "跟進催促", hint: "禮貌提醒尚未回覆的事項" },
  { id: "meeting", label: "會議安排", hint: "約時間、發議程或改期" },
  { id: "update", label: "進度彙報", hint: "同步進展、風險和下一步" },
  { id: "thanks", label: "感謝", hint: "致謝並可選帶一句後續" },
  { id: "apology", label: "道歉說明", hint: "解釋情況並給出補救" },
  { id: "decline", label: "婉拒", hint: "拒絕請求但保持關係" },
  { id: "intro", label: "介紹引薦", hint: "介紹背景、目的和連接方式" },
  { id: "custom", label: "自訂", hint: "在中文想法裡說明這封信要做什麼" },
];

const TYPE_IDS = new Set(EMAIL_TYPES.map((item) => item.id));
const TONE_IDS = new Set(["professional", "formal", "friendly"]);
const LANGUAGE_IDS = new Set(["english", "chinese", "bilingual"]);

const TYPE_GUIDANCE = {
  reply: "這是回覆。先讀對方來信，針對來信內容作答，主題用 Re: 開頭（若原主題已有 Re: 就不要再疊）。",
  request: "寫清楚請求：背景、具體想請對方做什麼、以及下一步。",
  followup: "簡短禮貌地提醒未回覆事項，讓對方容易直接回覆。",
  meeting: "提出或確認時間，說明目的，必要時寫準備事項。",
  update: "先寫現況，再寫風險、需要對方做什麼、以及下一步。",
  thanks: "具體說明感謝什麼，盡量短。",
  apology: "承認問題，解釋但不找藉口，並給出補救。",
  decline: "明確婉拒，必要時給簡短理由，並保持關係。",
  intro: "清楚介紹是誰、為什麼聯繫、以及建議的下一步。",
  custom: "根據使用者筆記自行判斷最合適的電郵形態。",
};

const els = {
  types: document.querySelector("#email-types"),
  recipient: document.querySelector("#recipient"),
  sender: document.querySelector("#sender"),
  tone: document.querySelector("#tone"),
  language: document.querySelector("#language"),
  originalEmail: document.querySelector("#original-email"),
  opening: document.querySelector("#opening"),
  idea: document.querySelector("#idea"),
  closing: document.querySelector("#closing"),
  generate: document.querySelector("#generate"),
  record: document.querySelector("#record"),
  voiceStatus: document.querySelector("#voice-status"),
  keyStatus: document.querySelector("#key-status"),
  openSettings: document.querySelector("#open-settings"),
  closeSettings: document.querySelector("#close-settings"),
  settings: document.querySelector("#settings"),
  settingsForm: document.querySelector("#settings-form"),
  apiKey: document.querySelector("#api-key"),
  model: document.querySelector("#model"),
  modelCustom: document.querySelector("#model-custom"),
  modelCustomField: document.querySelector("#model-custom-field"),
  provider: document.querySelector("#provider"),
  empty: document.querySelector("#letter-empty"),
  error: document.querySelector("#letter-error"),
  content: document.querySelector("#letter-content"),
  loading: document.querySelector("#letter-loading"),
  loadingText: document.querySelector("#loading-text"),
  subject: document.querySelector("#subject"),
  body: document.querySelector("#body"),
  copySubject: document.querySelector("#copy-subject"),
  copyBody: document.querySelector("#copy-body"),
  copyAll: document.querySelector("#copy-all"),
};

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const state = {
  type: "request",
  subject: "",
  body: "",
  hasServerKey: false,
  recording: false,
  recognition: null,
  finalTranscript: "",
  mediaRecorder: null,
  mediaStream: null,
  audioChunks: [],
  recordTick: null,
};

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function currentDraft() {
  return {
    type: state.type,
    recipient: els.recipient.value,
    sender: els.sender.value,
    tone: els.tone.value,
    language: els.language.value,
    originalEmail: els.originalEmail.value,
    opening: els.opening.value,
    idea: els.idea.value,
    closing: els.closing.value,
  };
}

function applyDraft(draft) {
  state.type = TYPE_IDS.has(draft.type) ? draft.type : state.type || "request";
  els.recipient.value = draft.recipient || "";
  els.sender.value = draft.sender || "";
  els.tone.value = TONE_IDS.has(draft.tone) ? draft.tone : els.tone.value || "professional";
  els.language.value = LANGUAGE_IDS.has(draft.language)
    ? draft.language
    : els.language.value || "english";
  els.originalEmail.value = draft.originalEmail || "";
  els.opening.value = draft.opening || "";
  els.idea.value = draft.idea || "";
  els.closing.value = draft.closing || "";
}

function persistDraft() {
  saveJson(STORAGE_KEY, currentDraft());
}

const MODELS = {
  gemini: [
    { id: "gemini-2.5-flash", label: "gemini-2.5-flash（推薦）" },
    { id: "gemini-2.0-flash", label: "gemini-2.0-flash" },
    { id: "gemini-2.5-pro", label: "gemini-2.5-pro" },
  ],
  openrouter: [
    { id: "google/gemini-2.5-flash", label: "google/gemini-2.5-flash（推薦）" },
    { id: "google/gemini-2.0-flash", label: "google/gemini-2.0-flash" },
    { id: "openai/gpt-4o-mini", label: "openai/gpt-4o-mini" },
    { id: "openai/gpt-4o", label: "openai/gpt-4o" },
    { id: "anthropic/claude-3.5-sonnet", label: "anthropic/claude-3.5-sonnet" },
    { id: "moonshotai/kimi-k2.5", label: "moonshotai/kimi-k2.5" },
    { id: "custom", label: "自訂模型…" },
  ],
};

function inferProvider(apiKey, fallback) {
  if (apiKey.startsWith("sk-or-")) return "openrouter";
  if (apiKey.startsWith("AIza")) return "gemini";
  return fallback === "openrouter" || fallback === "gemini" ? fallback : "gemini";
}

function fillModelOptions(provider, selected) {
  const list = MODELS[provider] || MODELS.gemini;
  els.model.innerHTML = "";
  const known = new Set(list.map((item) => item.id));
  const useCustom = provider === "openrouter" && selected && !known.has(selected);
  for (const item of list) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.label;
    els.model.append(option);
  }
  if (useCustom) {
    els.model.value = "custom";
    els.modelCustom.value = selected;
  } else {
    els.model.value = known.has(selected) ? selected : list[0].id;
    els.modelCustom.value = selected && !known.has(selected) ? selected : "";
  }
  syncCustomModelField();
}

function syncCustomModelField() {
  const show = els.provider.value === "openrouter" && els.model.value === "custom";
  els.modelCustomField.hidden = !show;
}

function defaultModel(provider) {
  return provider === "openrouter" ? "google/gemini-2.5-flash" : "gemini-2.5-flash";
}

function normalizeModel(provider, model) {
  const ids = (MODELS[provider] || []).map((item) => item.id).filter((id) => id !== "custom");
  if (ids.includes(model)) return model;
  if (provider === "openrouter" && model && model.includes("/")) return model;
  return defaultModel(provider);
}

function selectedModel() {
  if (els.provider.value === "openrouter" && els.model.value === "custom") {
    return els.modelCustom.value.trim();
  }
  return els.model.value;
}

function getSettings() {
  const saved = loadJson(SETTINGS_KEY, {
    apiKey: "",
    model: "gemini-2.5-flash",
    provider: "gemini",
  });
  const provider = inferProvider(saved.apiKey || "", saved.provider);
  return {
    apiKey: saved.apiKey || "",
    provider,
    model: normalizeModel(
      provider,
      saved.model || defaultModel(provider)
    ),
  };
}

function hasAnyKey() {
  return Boolean(getSettings().apiKey || state.hasServerKey);
}

function updateKeyStatus() {
  const ready = hasAnyKey();
  const provider = getSettings().provider;
  const name = provider === "openrouter" ? "OpenRouter" : "Gemini";
  els.keyStatus.textContent = ready ? `${name} 已就緒` : "尚未新增 API 金鑰";
  els.keyStatus.classList.toggle("ready", ready);
}

function setVoiceStatus(text, live = false) {
  els.voiceStatus.hidden = !text;
  els.voiceStatus.textContent = text;
  els.voiceStatus.classList.toggle("live", live);
}

function renderTypes() {
  els.types.innerHTML = "";
  for (const type of EMAIL_TYPES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "type-chip";
    button.textContent = type.label;
    button.title = type.hint;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(type.id === state.type));
    button.addEventListener("click", () => {
      state.type = type.id;
      persistDraft();
      renderTypes();
    });
    els.types.append(button);
  }
}

function showLetter({
  loading = false,
  loadingText = "正在把想法寫成電郵…",
  error = "",
  subject = "",
  body = "",
} = {}) {
  els.loading.hidden = !loading;
  els.loadingText.textContent = loadingText;
  els.error.hidden = !error;
  els.error.textContent = error;
  const hasDraft = Boolean(subject || body);
  els.content.hidden = !hasDraft || loading;
  els.empty.hidden = loading || hasDraft || Boolean(error);
  els.copySubject.disabled = !subject;
  els.copyBody.disabled = !body;
  els.copyAll.disabled = !(subject || body);
  if (hasDraft) {
    els.subject.textContent = subject;
    els.body.textContent = body;
  }
}

async function askModel(prompt, audio) {
  const settings = getSettings();
  const response = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      apiKey: settings.apiKey,
      model: settings.model,
      provider: settings.provider,
      audio: audio || undefined,
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || "產生失敗，請稍後再試。");
  }
  return data;
}

function buildPrompt(draft) {
  const type = EMAIL_TYPES.find((item) => item.id === draft.type) || EMAIL_TYPES[0];
  const languageMap = {
    english: "主題和正文用自然、專業的英文寫。",
    chinese: "主題和正文用得體的繁體中文寫，不要用簡體字。",
    bilingual:
      "主題用英文。正文先寫英文，再在一行「---」下面寫繁體中文版。同一段裡不要中英混寫。",
  };

  return [
    "你是一位細心的電郵撰稿人，服務對象是產品經理。",
    "把口語化的中文筆記寫成一封可以直接發出的電郵。若輸出中文，必須使用繁體中文。",
    "",
    `電郵類型：${type.label}（${draft.type}）`,
    TYPE_GUIDANCE[draft.type],
    `語氣：${draft.tone}`,
    languageMap[draft.language] || languageMap.english,
    draft.recipient ? `收件人：${draft.recipient}` : "收件人未指定，使用中性稱呼。",
    draft.sender ? `署名：${draft.sender}` : "署名未指定。",
    "",
    "對方來信（若有，必須先讀再寫回覆；不要忽略來信裡的問題、日期、請求）：",
    draft.originalEmail.trim() || "（無，這是一封新電郵，不是回覆）",
    "",
    "開頭補充（如有，必須寫進問候或前幾句，不要忽略）：",
    draft.opening.trim() || "（無）",
    "",
    "中文想法：",
    draft.idea.trim(),
    "",
    "結尾補充（如有，必須寫進請求、最後幾句或簽名，不要忽略）：",
    draft.closing.trim() || "（無）",
    "",
    "規則：",
    "- 不要編造筆記裡沒有的日期、數字、產品名或承諾。",
    "- 若有對方來信：這是回覆。針對來信作答，不要複述整封原信。主題用 Re: 加上原主題（原主題已有 Re: 則不要再疊）。",
    "- 若來信有問問題，必須逐一回應。",
    "- 簡潔、像人寫的。除非開頭補充要求，否則不要用「I hope this email finds you well」這類套話。",
    "- 不要把主題再寫進正文。",
    "- 只返回 JSON，鍵為 subject 和 body。",
    "- body 必須是純文字，使用真實換行，不要用 Markdown。",
  ].join("\n");
}

function buildInterpretPrompt(transcript, draft) {
  return [
    "你是產品經理的電郵助手。使用者剛用粵語或普通話口述了一段想法。",
    "請理解這段口述（若有錄音請先聽錄音），並填寫寫電郵表單。不要寫完整電郵，只整理素材。中文內容一律使用繁體中文。",
    "",
    "當前表單（口述沒有明確覆蓋的項請保持原值）：",
    JSON.stringify(draft, null, 2),
    "",
    "口述原文：",
    transcript,
    "",
    "請返回 JSON，鍵如下：",
    "- type: reply, request, followup, meeting, update, thanks, apology, decline, intro, custom 之一。若表單已有對方來信，優先用 reply",
    "- recipient: 收件人姓名或稱呼，沒有則空字串",
    "- sender: 只有口述裡明確提到自己怎麼署名才填寫，否則空字串",
    "- tone: professional, formal, friendly 之一",
    "- language: english, chinese, bilingual 之一。使用者沒說就保持當前值",
    "- opening: 稱呼、背景、寒暄。沒有新內容則空字串",
    "- idea: 用通順繁體中文整理後的核心想法，必填",
    "- closing: 請求、截止時間、簽名。沒有新內容則空字串",
    "",
    "規則：",
    "- idea 必須根據口述整理，不要原樣堆口語，但不要編造沒有說的事實。",
    "- 空字串表示這一項不要改。",
    "- 只返回 JSON。",
  ].join("\n");
}

function mergeInterpreted(data, draft, transcript) {
  return {
    type: TYPE_IDS.has(data.type) ? data.type : draft.type,
    recipient: String(data.recipient || "").trim() || draft.recipient,
    sender: String(data.sender || "").trim() || draft.sender,
    tone: TONE_IDS.has(data.tone) ? data.tone : draft.tone,
    language: LANGUAGE_IDS.has(data.language) ? data.language : draft.language,
    opening: String(data.opening || "").trim() || draft.opening,
    originalEmail: draft.originalEmail,
    idea: String(data.idea || "").trim() || transcript,
    closing: String(data.closing || "").trim() || draft.closing,
  };
}

async function generateEmail() {
  const draft = currentDraft();
  if (!draft.idea.trim()) {
    showLetter({ error: "請先在「中文想法」裡寫幾句要回覆或要說的事，或點「開始錄音」。" });
    els.idea.focus();
    return;
  }

  if (!hasAnyKey()) {
    showLetter({
      error:
        "還沒有 API 金鑰。點右上角「設定」貼上 Gemini 或 OpenRouter 金鑰，或寫進專案的 .env 檔案後重新啟動服務。",
    });
    els.settings.showModal();
    return;
  }

  els.generate.disabled = true;
  showLetter({ loading: true, loadingText: "正在把想法寫成電郵…" });

  try {
    const data = await askModel(buildPrompt(draft));
    state.subject = data.subject || "";
    state.body = data.body || "";
    showLetter({ subject: state.subject, body: state.body });
  } catch (error) {
    showLetter({ error: error.message || String(error) });
  } finally {
    els.generate.disabled = false;
  }
}

async function fillFromTranscript(transcript, audio) {
  if (transcript) {
    els.idea.value = transcript;
    persistDraft();
  }

  if (!hasAnyKey()) {
    if (transcript) {
      setVoiceStatus("已把錄音寫進「中文想法」。新增金鑰後，AI 會按理解自動填類型、開頭和結尾。");
      showLetter({
        error:
          "錄音已轉成文字。新增 API 金鑰後，再錄音一次，AI 就能按理解幫你填表並寫成電郵。",
      });
    } else {
      const message =
        "這個視窗未能辨識說話。請用 Chrome 打開 http://127.0.0.1:8787，允許麥克風；有金鑰的話，錄音會交俾 AI 辨識粵語／普通話。";
      setVoiceStatus(message);
      showLetter({ error: message });
    }
    els.settings.showModal();
    return;
  }

  els.generate.disabled = true;
  els.record.disabled = true;
  setVoiceStatus("正在按 AI 的理解填寫內容…");
  showLetter({ loading: true, loadingText: "正在按你說的話整理並寫成電郵…" });

  try {
    const draft = currentDraft();
    const spoken = transcript || "（沒有即時逐字稿，請直接聽錄音，用繁體中文整理。）";
    const data = await askModel(buildInterpretPrompt(spoken, draft), audio);
    applyDraft(mergeInterpreted(data, draft, transcript || ""));
    renderTypes();
    persistDraft();
    setVoiceStatus("已按 AI 的理解填好左側內容，正在寫成電郵…");
    await generateEmail();
    if (!els.error.hidden) {
      setVoiceStatus("左側已按理解填好，但寫成電郵時出錯。");
      return;
    }
    setVoiceStatus("已根據錄音填好內容，並寫成電郵。");
  } catch (error) {
    showLetter({ error: error.message || String(error) });
    setVoiceStatus(error.message || "整理失敗，請再錄一次。");
  } finally {
    els.generate.disabled = false;
    els.record.disabled = false;
  }
}

function collectTranscript(event) {
  let interim = "";
  for (let i = event.resultIndex; i < event.results.length; i += 1) {
    const text = event.results[i][0].transcript;
    if (event.results[i].isFinal) {
      state.finalTranscript += text;
    } else {
      interim += text;
    }
  }
  const live = `${state.finalTranscript} ${interim}`.replace(/\s+/g, " ").trim();
  if (live) {
    els.idea.value = live;
    persistDraft();
    setVoiceStatus(`正在聽：${live}`, true);
  }
}

function pickRecorderMime() {
  if (typeof MediaRecorder === "undefined") return "";
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function explainMicError(error) {
  const name = error && error.name;
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "沒有麥克風權限。請允許使用咪，或用 Chrome 打開 http://127.0.0.1:8787 再試。";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "找不到麥克風，請檢查裝置後重試。";
  }
  if (name === "NotReadableError") {
    return "麥克風被其他程式占用，請關閉後再試。";
  }
  return "這個預覽視窗多數用不到咪。請用 Chrome 打開 http://127.0.0.1:8787，然後再按「開始錄音」。";
}

function stopSpeechCaption() {
  if (!state.recognition) return;
  try {
    state.recognition.onend = null;
    state.recognition.stop();
  } catch {
    // already stopped
  }
  state.recognition = null;
}

function startSpeechCaption() {
  if (!SpeechRecognition) return;
  const recognition = new SpeechRecognition();
  recognition.lang = "zh-HK";
  recognition.continuous = true;
  recognition.interimResults = true;
  state.recognition = recognition;
  recognition.onresult = collectTranscript;
  recognition.onerror = () => {};
  recognition.onend = () => {
    if (state.recording && state.recognition === recognition) {
      try {
        recognition.start();
      } catch {
        // ignore restart races
      }
    }
  };
  try {
    recognition.start();
  } catch {
    state.recognition = null;
  }
}

function stopRecording() {
  const recorder = state.mediaRecorder;
  state.recording = false;
  els.record.classList.remove("live");
  els.record.textContent = "開始錄音";
  if (state.recordTick) {
    window.clearInterval(state.recordTick);
    state.recordTick = null;
  }
  stopSpeechCaption();
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
    return true;
  }
  if (state.mediaStream) {
    for (const track of state.mediaStream.getTracks()) track.stop();
    state.mediaStream = null;
  }
  return false;
}

async function handleRecordedAudio() {
  const chunks = state.audioChunks.splice(0);
  const mime = (state.mediaRecorder && state.mediaRecorder.mimeType) || "audio/webm";
  state.mediaRecorder = null;
  if (state.mediaStream) {
    for (const track of state.mediaStream.getTracks()) track.stop();
    state.mediaStream = null;
  }

  const transcript = (els.idea.value.trim() || state.finalTranscript.trim());
  const blob = chunks.length ? new Blob(chunks, { type: mime.split(";")[0] }) : null;
  if ((!blob || blob.size < 200) && !transcript) {
    const message = "沒有錄到聲音。請用 Chrome 打開本頁、允許麥克風，靠近咪再錄一次。";
    setVoiceStatus(message);
    showLetter({ error: message });
    return;
  }

  let audio;
  if (blob && blob.size >= 200 && hasAnyKey()) {
    audio = {
      mimeType: (blob.type || mime).split(";")[0],
      data: await blobToBase64(blob),
    };
  }
  await fillFromTranscript(transcript, audio);
}

async function startRecording() {
  state.finalTranscript = "";
  state.audioChunks = [];

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickRecorderMime();
      const recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
      state.mediaStream = stream;
      state.mediaRecorder = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size) state.audioChunks.push(event.data);
      };
      recorder.onstop = () => {
        handleRecordedAudio().catch((error) => {
          const message = error.message || String(error);
          setVoiceStatus(message);
          showLetter({ error: message });
        });
      };
      recorder.start(250);
    } catch (error) {
      const message = explainMicError(error);
      setVoiceStatus(message);
      showLetter({ error: message });
      return;
    }
  } else if (!SpeechRecognition) {
    const message =
      "這個視窗不能錄音。請用 Chrome 打開 http://127.0.0.1:8787，允許麥克風後再試。";
    setVoiceStatus(message);
    showLetter({ error: message });
    return;
  }

  state.recording = true;
  els.record.classList.add("live");
  els.record.textContent = "停止錄音";
  const started = Date.now();
  setVoiceStatus("正在錄音，說完後點「停止錄音」。", true);
  state.recordTick = window.setInterval(() => {
    if (!state.recording) return;
    const seconds = Math.round((Date.now() - started) / 1000);
    if (!state.finalTranscript) {
      setVoiceStatus(`正在錄音 ${seconds} 秒，說完後點「停止錄音」。`, true);
    }
  }, 1000);
  startSpeechCaption();
}

async function toggleRecording() {
  if (state.recording) {
    const waitingForAudio = stopRecording();
    if (waitingForAudio) {
      setVoiceStatus("正在處理錄音…");
      return;
    }
    const transcript = els.idea.value.trim() || state.finalTranscript.trim();
    await fillFromTranscript(transcript);
    return;
  }
  await startRecording();
}

async function copyText(text) {
  if (!text) return;
  await navigator.clipboard.writeText(text);
}

function flashButton(button, label) {
  const original = button.textContent;
  button.textContent = label;
  window.setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

async function loadStatus() {
  try {
    const response = await fetch("/api/status");
    const data = await response.json();
    state.hasServerKey = Boolean(data.hasServerKey);
    const settings = getSettings();
    if (!settings.apiKey && data.provider) {
      els.provider.value = data.provider;
    }
    if (!settings.apiKey && data.model) {
      fillModelOptions(els.provider.value, data.model);
    }
  } catch {
    state.hasServerKey = false;
  }
  updateKeyStatus();
}

function bind() {
  const draftFields = [
    els.recipient,
    els.sender,
    els.tone,
    els.language,
    els.originalEmail,
    els.opening,
    els.idea,
    els.closing,
  ];
  for (const field of draftFields) {
    field.addEventListener("input", persistDraft);
  }
  els.originalEmail.addEventListener("input", () => {
    if (els.originalEmail.value.trim() && (state.type === "request" || !state.type)) {
      state.type = "reply";
      renderTypes();
      persistDraft();
    }
  });

  els.generate.addEventListener("click", generateEmail);
  els.record.addEventListener("click", toggleRecording);
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      generateEmail();
    }
  });

  els.openSettings.addEventListener("click", () => {
    const settings = getSettings();
    els.apiKey.value = settings.apiKey;
    els.provider.value = settings.provider;
    fillModelOptions(settings.provider, settings.model);
    els.settings.showModal();
    els.apiKey.focus();
  });
  els.closeSettings.addEventListener("click", () => els.settings.close());
  els.provider.addEventListener("change", () => {
    const fallback =
      els.provider.value === "openrouter" ? "google/gemini-2.5-flash" : "gemini-2.5-flash";
    fillModelOptions(els.provider.value, fallback);
  });
  els.model.addEventListener("change", syncCustomModelField);
  els.apiKey.addEventListener("input", () => {
    const provider = inferProvider(els.apiKey.value.trim(), els.provider.value);
    if (provider !== els.provider.value) {
      els.provider.value = provider;
      fillModelOptions(provider, defaultModel(provider));
    }
  });
  els.settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const apiKey = els.apiKey.value.trim();
    const provider = inferProvider(apiKey, els.provider.value);
    saveJson(SETTINGS_KEY, {
      apiKey,
      provider,
      model: normalizeModel(provider, selectedModel()),
    });
    updateKeyStatus();
    els.settings.close();
  });

  els.copySubject.addEventListener("click", async () => {
    await copyText(state.subject);
    flashButton(els.copySubject, "已複製");
  });
  els.copyBody.addEventListener("click", async () => {
    await copyText(state.body);
    flashButton(els.copyBody, "已複製");
  });
  els.copyAll.addEventListener("click", async () => {
    const parts = [];
    if (state.subject) parts.push(`主題：${state.subject}`);
    if (state.body) parts.push(state.body);
    await copyText(parts.join("\n\n"));
    flashButton(els.copyAll, "已複製");
  });
}

applyDraft(loadJson(STORAGE_KEY, { type: "request" }));
const savedSettings = getSettings();
els.provider.value = savedSettings.provider;
fillModelOptions(savedSettings.provider, savedSettings.model);
renderTypes();
bind();
loadStatus();
showLetter();
