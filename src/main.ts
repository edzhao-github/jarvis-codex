import { answerProfileQuestion, profileQuestion, resolveProfileMap } from "./profile-map";
import { anatomyMarkup, anatomyRequest, mountAnatomy } from "./anatomy";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { icon, mountOrb, shortcuts, workers, workspaceContext } from "./workspace-view";
import "./style.css";
import "./workspace.css";
import { cityMapMarkup, drawRoute, mountCityMap } from "./city-map";
import { mountCitySearch } from "./city-search";
import { completeMapEndpoint, failedMapFollowUp, mapDestinationChange, mapFollowUp, mapIntent, mapIntentFromClassification, readMapAction, type MapIntent, type PendingMapAddress } from "./map-intent";
import { mountSystemStats, systemStatsMarkup } from "./system-stats";

type Mode = "booting" | "ready" | "voice-starting" | "listening" | "working" | "speaking" | "degraded" | "stopped";
type Message = { id?: number | string; method?: string; params?: any };
type Session = { threadId: string; cwd: string };
type DirectVoice = {
  codexConnected: boolean;
  voiceActive: boolean;
  phase: string;
  protocol: string;
  threadId?: string;
  realtimeSessionId?: string;
};
type WakeStatus = {
  enabled: boolean;
  ready: boolean;
  authorization: string;
};
type WakeEvent = {
  ok: boolean;
  error?: string;
  cold?: boolean;
};
type PermissionMode = "safe" | "auto" | "full";

const state = {
  mode: "booting" as Mode,
  session: null as Session | null,
  directVoice: null as DirectVoice | null,
  wake: null as WakeStatus | null,
  level: 0,
  manualStop: false,
  agentWorking: false,
};

const WORKSPACE_KEY = "jarvis.workspace";
const MAP_CITY_KEY = "jarvis.mapCity";
const DEFAULT_MAP_CITY = "大连";
let mapCity = localStorage.getItem(MAP_CITY_KEY)?.trim() || DEFAULT_MAP_CITY;
const THREAD_KEY_PREFIX = "jarvis.threadId:";
const PERMISSION_KEY = "jarvis.permissionMode";
const permissionLabels: Record<PermissionMode, string> = {
  safe: "安全模式 · 需要时确认",
  auto: "自动办公 · 当前目录自主执行",
  full: "完全访问 · 高风险",
};
function storedPermissionMode(): PermissionMode {
  const value = localStorage.getItem(PERMISSION_KEY);
  return value === "safe" || value === "full" ? value : "auto";
}
let workspace = "";
let permissionMode = storedPermissionMode();
const savedThreadId = () => localStorage.getItem(`${THREAD_KEY_PREFIX}${workspace}`);
let peer: RTCPeerConnection | null = null;
let microphoneStream: MediaStream | null = null;
let remoteStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let microphoneAnalyser: AnalyserNode | null = null;
let remoteAnalyser: AnalyserNode | null = null;
const meterSamples = new Uint8Array(512);
let lastSpeakerActivity = -Infinity;
const voiceInUse = () => voiceStartInFlight || peer !== null || state.directVoice?.voiceActive === true;
let userTranscriptBuffer = "";
let assistantTranscriptBuffer = "";
let agentMessageBuffer = "";
let voiceStartInFlight = false;
let recoverableColdStartError = false;
const voiceAudio = new Audio();
voiceAudio.autoplay = true;
let mapReplyMuted = false;
let mapMuteUntil = 0;
let mapLookupPending = false;
let mapPromptQueue: { text: string; readyAt: number } | null = null;
let lastRemoteSpeech = -Infinity;
let microphoneHoldUntil = 0;
let mapSpeechStartUntil = 0;
let activeMapKey = "";
let mapContext: MapIntent | null = null;
let pendingMapAddress: PendingMapAddress | null = null;
let intentRevision = 0;
let lastMapFailure: { revision: number; message: string } | null = null;
const hasMapFailure = () => lastMapFailure?.revision === intentRevision;
const previewParams = new URLSearchParams(window.location.search);
const tauriInternals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
const currentWindow = typeof tauriInternals?.invoke === "function" ? getCurrentWindow() : null;
const previewModeValue = previewParams.get("preview");
const previewActionValue = previewParams.get("action");
const visualPreviewMode: Mode = ["booting", "ready", "voice-starting", "listening", "working", "speaking", "degraded", "stopped"].includes(previewModeValue ?? "")
  ? previewModeValue as Mode
  : "ready";
if (!currentWindow) {
  document.documentElement.classList.add("visual-preview");
  if (previewParams.get("grid") === "1") document.documentElement.classList.add("transparency-grid");
}

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
<main class="shell" data-mode="booting" data-view="workspace">
  <canvas id="particle-field" width="1440" height="900" aria-hidden="true"></canvas>
  <header class="topbar hud-panel">
    <div class="brand"><i aria-hidden="true">◈</i><div><strong>J.A.R.V.I.S</strong><em>PERSONAL LOCAL AGENT</em></div></div>
    <div class="clock"><time id="clock"></time><span id="calendar-date"></span></div>
    <div class="topbar-status">
      ${systemStatsMarkup}
      <div class="status" role="status"><span id="runtime-label">本地</span><i></i><b id="mode-label">INITIALIZING</b></div>
    </div>
    <div class="window-actions">
      <button id="switch-view" class="icon-button" aria-label="切换到机械猫" title="切换到机械猫">${icon("view")}</button>
      <button id="settings" class="icon-button" aria-label="设置" title="设置">${icon("settings")}</button>
    </div>
  </header>
  <section class="stage" aria-label="贾维斯核心">
    <div class="workspace-core">
      <div class="core-status"><span></span><b id="core-state">SYSTEM BOOT</b><span></span></div>
      <canvas id="core-orb" aria-hidden="true"></canvas>
      ${cityMapMarkup}
      ${anatomyMarkup}
    </div>
    <div class="avatar-window">
      <div class="character-aura"></div>
      <div class="character-rig">
        <div class="assembly-orbits" aria-hidden="true"><i></i><i></i><i></i></div>
        <div class="armor-shards" aria-hidden="true"></div>
        <img id="jarvis-character" class="helmet-character" src="/assets/jarvis-character-cat.png" alt="Jarvis mechanical cat">
        <div class="helmet-scan"></div>
        <div class="assembly-flash" aria-hidden="true"></div>
      </div>
    </div>
    <div class="identity"><span>JARVIS CORE</span><b id="identity-state">SYSTEM BOOT</b></div>
  </section>
  <aside class="workers" aria-label="Agent 调度与工作汇报">
    <section>
      <h2 class="rail-title">Agent 调度</h2>
      ${workers.map(([role, name, glyph], index) => `
        <article class="worker${index === 0 ? " active" : ""}" data-role="${role}">
          <span>${icon(glyph)}</span><div><b>${name}</b><small>${index === 0 ? "连接中" : "待命"}</small></div><i></i>
        </article>`).join("")}
    </section>
    <section class="work-report">
      <h2 class="rail-title">工作汇报</h2>
      <div class="work-count"><strong id="completed-count">0</strong><span>本次启动已完成</span></div>
      <p id="work-status">等待指令</p>
      <canvas id="wave" width="540" height="126" aria-hidden="true"></canvas>
      <small>语音信号</small>
    </section>
  </aside>
  ${workspaceContext}
  <section class="dialogue hud-panel" aria-label="最新对话">
    <div class="dialogue-user"><b>YOU</b><p id="user-transcript">“嗨，Jarvis”</p></div>
    <div class="dialogue-reply"><b class="jarvis">JARVIS</b><p id="assistant-transcript">正在启动贾维斯…</p></div>
  </section>
  <footer class="controls">
    <div class="quick-actions" aria-label="快捷指令">${shortcuts.map(([label, prompt]) => `<button type="button" data-prompt="${prompt}">${label}</button>`).join("")}</div>
    <button id="mic" class="control mic" type="button" aria-label="切换语音" title="切换语音"><span aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="8.25" y="3" width="7.5" height="11.5" rx="3.75"></rect><path d="M5.5 11.25v.75a6.5 6.5 0 0 0 13 0v-.75M12 18.5V22M8.75 22h6.5"></path></svg></span></button>
    <form id="command-form" class="command"><input id="command-input" aria-label="文字指令" placeholder="说「Hey Jarvis」，或在这里打字" autocomplete="off"><button type="submit" aria-label="发送指令" title="发送指令">↵</button></form>
    <button id="stop" class="control stop" type="button" aria-label="停止语音和任务" title="停止语音和任务"><span aria-hidden="true"><svg viewBox="0 0 24 24"><rect class="stop-mark" x="6.5" y="6.5" width="11" height="11" rx="1.8"></rect></svg></span></button>
  </footer>
  <div id="degraded-banner" class="degraded-banner" hidden><b>JARVIS NEEDS PERMISSION</b><span id="degraded-copy">首次使用请允许麦克风和语音识别。</span></div>
  <dialog id="approval"><h2>高风险操作确认</h2><p id="approval-copy">Codex 请求执行需要确认的动作。</p><div><button id="deny">拒绝</button><button id="approve">允许一次</button></div></dialog>
  <dialog id="settings-dialog"><h2>JARVIS SYSTEM</h2><dl><dt>Wake phrase</dt><dd>嗨 Jarvis / Hey Jarvis</dd><dt>Wake listener</dt><dd id="wake-auth">检测中</dd><dt>Codex thread</dt><dd id="thread-id">—</dd><dt>Workspace</dt><dd id="workspace">—</dd><dt>Permission</dt><dd id="permission-mode-label">—</dd><dt>Voice kernel</dt><dd id="voice-auth">检测中</dd></dl><label class="workspace-setting">工作目录<input id="workspace-setting" autocomplete="off" spellcheck="false"></label><label class="workspace-setting map-city-setting">地图默认城市<input id="map-city-setting" maxlength="30" autocomplete="off" spellcheck="false"></label><fieldset class="permission-setting"><legend>Codex 操作权限</legend><label><input type="radio" name="permission-mode" value="safe"><span><b>安全模式</b><small>超出当前目录或高风险操作时询问</small></span></label><label class="recommended"><input type="radio" name="permission-mode" value="auto"><span><b>自动办公</b><small>当前目录内自主执行，越界操作直接阻止</small></span><em>推荐</em></label><label class="danger"><input type="radio" name="permission-mode" value="full"><span><b>完全访问</b><small>不限制目录且不询问，请谨慎使用</small></span></label></fieldset><p>权限切换会停止当前任务并重建 Codex 运行时，但会继续使用当前工作目录保存的 thread。</p><p>修改工作目录后，下次重启 Jarvis 生效。每个工作目录会续接自己的 Codex thread。</p><p>“新开线程”会结束当前任务并创建一个全新的 Codex thread；原线程仍保留在 Codex 历史记录中。</p><p>唤醒词在本机识别；Jarvis 页面通过 Codex app-server V3 WebRTC 进入官方 Voice 线程。认证复用本机 Codex 登录，不读取凭据、不模拟点击，也不建立第二套 GPT-Live。</p><div class="settings-actions"><button id="new-thread" class="new-thread">＋ 新开线程</button><span></span><button id="save-settings">保存</button><button id="close-settings">关闭</button></div></dialog>
</main>`;

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const shell = $<HTMLElement>(".shell");
const transcript = $("#user-transcript");
const response = $("#assistant-transcript");
const banner = $("#degraded-banner") as HTMLDivElement;
const mic = $("#mic") as HTMLButtonElement;
const approval = $("#approval") as HTMLDialogElement;
const settings = $("#settings-dialog") as HTMLDialogElement;
const characterRig = $<HTMLElement>(".character-rig");
const hoverControls = $<HTMLElement>(".controls");
const settingsButton = $<HTMLButtonElement>("#settings");
const switchViewButton = $<HTMLButtonElement>("#switch-view");
const commandInput = $<HTMLInputElement>("#command-input");
const dateFormatter = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" });
const timeFormatter = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
let completedCount = 0;

function updateClock() {
  const now = new Date();
  const clock = $<HTMLTimeElement>("#clock");
  clock.dateTime = now.toISOString();
  clock.textContent = timeFormatter.format(now);
  $("#calendar-date").textContent = dateFormatter.format(now);
}
updateClock();
window.setInterval(updateClock, 1000);
mountSystemStats(currentWindow ? () => invoke("system_stats") : null, voiceInUse);

mountOrb($<HTMLCanvasElement>("#core-orb"), () => state, voiceInUse);

const cityView = $<HTMLElement>("#city-view");
const routeButton = $<HTMLButtonElement>("#open-city");
const closeCity = $<HTMLButtonElement>("#close-city");
const city = mountCityMap($<HTMLCanvasElement>("#city-canvas"), $<HTMLElement>("#city-start"), $<HTMLElement>("#city-end"), $<HTMLButtonElement>("#orbit-city"));

const anatomy = mountAnatomy($<HTMLElement>(".anatomy-view"), () => {
  closeAnatomy();
  commandInput.focus();
});

function closeAnatomy() {
  anatomy.close();
  shell.removeAttribute("data-anatomy-open");
}

function handleAnatomy(text: string) {
  const subject = anatomyRequest(text);
  if (subject === undefined) return false;
  ++intentRevision;
  citySearch.close();
  pendingMapAddress = null;
  const name = subject ? anatomy.open(subject) : null;
  if (name) {
    if (!cityView.hidden) setCityOpen(false, false);
    if (shell.dataset.view === "avatar") switchViewButton.click();
    shell.setAttribute("data-anatomy-open", "");
    $<HTMLButtonElement>(".anatomy-view [data-explode]").focus();
  }
  const message = name ? `已打开${name}的拆解演示。` : subject
    ? "这个对象还没有拆解演示。现在可以查看咖啡机或机械键盘。"
    : "你想拆解什么？现在可以查看咖啡机或机械键盘。";
  response.textContent = message;
  speakMapPrompt(message);
  return true;
}

const citySearch = mountCitySearch((scene, origin, destination) => {
  if (cityView.hidden) setCityOpen(true, false);
  pendingMapAddress = null;
  mapContext = citySearch.input();
  const originLabel = origin ? origin.name + (origin.approximate ? "附近" : "") : null;
  const destinationLabel = destination.name + (destination.approximate ? "附近" : "");
  city.setScene(scene, originLabel, destinationLabel);
  drawRoute($<HTMLCanvasElement>("#route-map"), scene);
  $("#city-location").textContent = destination.area || "在线地图";
  $("#city-title").textContent = originLabel ? `起点：${originLabel} → 目的地：${destinationLabel}` : destinationLabel;
  response.textContent = destination.approximate
    ? `已显示「${destination.name}」附近的地图。`
    : `已显示「${destination.name}」的全息地图。`;

  $("#route-title").textContent = origin ? `去${destinationLabel}` : destinationLabel;
  const time = $<HTMLElement>("#route-time");
  time.hidden = !origin;
  if (origin) {
    const minutes = Math.max(1, Math.round(scene.durationSeconds / 60));
    const distance = (scene.distanceMeters / 1000).toFixed(1);
    $("#city-distance").textContent = `驾车约 ${minutes} 分钟 · ${distance} km`;
    $("#route-distance").textContent = `驾车 · ${distance} km`;
    $("#route-time span").textContent = String(minutes);
    const summary = `从「${origin.name}」到「${destination.name}」，约${distance}公里，驾车约${minutes}分钟。`;
    response.textContent = summary;
    speakMapPrompt(summary);
  } else {
    $("#city-distance").textContent = "";
    $("#route-distance").textContent = "在线地图";
    speakMapPrompt(response.textContent);
  }
}, (message, failed, missing) => {
  if (!failed) {
    response.textContent = message;
    return;
  }
  if (missing) pendingMapAddress = { ...citySearch.input(), missing };
  const { origin, route } = citySearch.input();
  reportMapFailure(`${origin || route ? "这次路线没生成。" : "这次没能打开地图。"}${message}`);
});

function reportMapFailure(message: string) {
  lastMapFailure = { revision: intentRevision, message };
  mapLookupPending = false;
  activeMapKey = "";
  mapPromptQueue = null;
  response.textContent = message;
  if (!currentWindow || !peer || state.manualStop) return;

  mapReplyMuted = true;
  voiceAudio.muted = true;
  setMode("listening");
  const holdUntil = performance.now() + 16_000;
  mapSpeechStartUntil = holdUntil;
  syncMicrophone();
  void invoke("speak_map_failure", { text: message }).catch((error) => {
    console.warn("Jarvis 地图失败提示播报失败", error);
  }).finally(() => {
    if (mapSpeechStartUntil !== holdUntil) return;
    mapSpeechStartUntil = 0;
    syncMicrophone();
  });
}

function beginUserCommand(text: string) {
  const failure = hasMapFailure() ? lastMapFailure : null;
  const revision = ++intentRevision;
  mapPromptQueue = null;
  if (failure) clearMapMute();
  const followUp = failure ? failedMapFollowUp(text) : null;
  if (failure && followUp) {
    const message = followUp === "landmark" && pendingMapAddress
      ? `${failure.message.split("。", 1)[0]}。这个地标还不能帮我确定${pendingMapAddress.missing === "origin" ? "起点" : "目的地"}。你可以直接说地点名称或所在区，我再查一次。`
      : failure.message;
    reportMapFailure(message);
    return null;
  }
  return revision;
}

function speakMapPrompt(text: string) {
  mapLookupPending = false;
  activeMapKey = "";
  if (!currentWindow || !peer || state.manualStop) {
    clearMapMute();
    return;
  }
  queueSpokenReply(text);
}

function queueSpokenReply(text: string) {
  const now = performance.now();
  muteMapReply();
  mapPromptQueue = { text, readyAt: now + 750 };
}

function playMapPrompt(text: string) {
  assistantTranscriptBuffer = "";
  mapSpeechStartUntil = performance.now() + 4000;
  syncMicrophone();
  clearMapMute();
  void invoke("speak_map_prompt", { text }).catch((error) => {
    mapSpeechStartUntil = 0;
    syncMicrophone();
    console.warn("Jarvis 地图语音播报失败", error);
  });
}

function syncMicrophone(now = performance.now()) {
  const track = microphoneStream?.getAudioTracks()[0];
  if (!track) return;
  const enabled = now >= Math.max(microphoneHoldUntil, mapSpeechStartUntil);
  if (track.enabled !== enabled) track.enabled = enabled;
}

function setCityOpen(open: boolean, focus = true) {
  if (open) closeAnatomy();
  cityView.hidden = !open;
  shell.toggleAttribute("data-city-open", open);
  routeButton.setAttribute("aria-expanded", String(open));
  if (open) {
    city.show();
    if (focus) closeCity.focus();
  } else {
    ++intentRevision;
    pendingMapAddress = null;
    citySearch.close();
    mapLookupPending = false;
    activeMapKey = "";
    mapPromptQueue = null;
    city.hide();
    if (focus) routeButton.focus();
  }
}

function isOpenMapCommand(text: string) {
  const command = text.normalize("NFKC").replace(/\s+/g, "")
    .replace(/^(?:(?:嗨|嘿|Hey)[,，、]*)?(?:Jarvis|贾维斯|喵维斯)[,，、:：]*/i, "")
    .replace(/[。！!？?，,]+$/, "");
  return /^(?:请|麻烦)?(?:帮我|给我)?(?:打开|显示|查看|看看)(?:一下)?(?:立体|全息)?(?:路线|地图)(?:吧|一下)?$/.test(command);
}

function openRecentMap() {
  if (mapContext) {
    if (shell.dataset.view === "avatar") switchViewButton.click();
    setCityOpen(true);
    return;
  }
  if (mapLookupPending) return;
  commandInput.focus();
  const message = "请说出要查看的地点，或提供起点和终点来规划路线。";
  response.textContent = message;
  speakMapPrompt(message);
}

async function openMapRequest(intent: MapIntent) {
  const revision = intentRevision;
  if (currentWindow) {
    response.textContent = "正在读取用户档案，核对路线地点…";
    try {
      const profile = await invoke<string | null>("read_user_profile", { cwd: workspace });
      if (revision !== intentRevision || state.manualStop) return;
      intent = resolveProfileMap(intent, profile);
    } catch {
      if (revision === intentRevision && !state.manualStop) {
        reportMapFailure("用户档案读取失败，尚未开始查询路线。请检查文件后重试。");
      }
      return;
    }
  }
  if (revision !== intentRevision || state.manualStop) return;
  const key = JSON.stringify([Boolean(intent.route || intent.origin),
    ...[intent.origin ?? "", intent.destination].map((place) => place.normalize("NFKC").replace(/\s+/g, "").toLowerCase())]);
  if (activeMapKey === key) return;
  lastMapFailure = null;
  activeMapKey = key;
  pendingMapAddress = null;
  mapPromptQueue = null;
  mapLookupPending = true;
  if (peer) muteMapReply();
  if (shell.dataset.view === "avatar") switchViewButton.click();
  void citySearch.show(intent, mapCity);
}

let mapClassification: Promise<MapIntent | null> = Promise.resolve(null);
async function interpretMapRequest(text: string, revision: number): Promise<MapIntent | null> {
  const correction = mapDestinationChange(text, pendingMapAddress ?? mapContext) ?? completeMapEndpoint(text, pendingMapAddress);
  if (correction) return correction;
  const direct = mapIntent(text);
  const followUp = mapFollowUp(text);
  if (direct && (direct.origin || !followUp)) return direct;
  if (!currentWindow) return direct;
  mapClassification = mapClassification.then(() => {
    if (revision !== intentRevision || state.manualStop) return null;
    const context = followUp === "area" ? pendingMapAddress : followUp ? pendingMapAddress ?? mapContext : null;
    return invoke<MapIntent | null>("classify_map_intent", { text, context })
      .then(intent => mapIntentFromClassification(intent && context?.route ? { ...intent, route: true } : intent,
        text, Boolean(context?.origin || context?.route)))
      .catch(() => direct);
  });
  return mapClassification;
}

async function handleProfileQuestion(text: string, revision: number): Promise<boolean> {
  const question = profileQuestion(text);
  if (!question || !currentWindow) return false;
  const connection = peer;
  if (connection) {
    muteMapReply();
    voiceAudio.muted = true;
    mapMuteUntil = performance.now() + 16_000;
  }
  let message: string;
  try {
    const profile = await invoke<string | null>("read_user_profile", { cwd: workspace });
    message = answerProfileQuestion(question, profile);
  } catch {
    message = "这次没能读取《用户档案.md》，请检查文件后再试。";
  }
  if (revision !== intentRevision || state.manualStop) return true;
  response.textContent = message;
  if (connection && connection === peer) queueSpokenReply(message);
  return true;
}

async function handleSpokenCommand(text: string) {
  const connection = peer;
  if (!connection || state.manualStop || !text || /^(?:[嗯啊哦呃唔]+[。！!，,]*|\[[a-z _-]+\]?)$/i.test(text)) return;
  const revision = beginUserCommand(text);
  if (revision === null) return;
  if (await handleProfileQuestion(text, revision) || revision !== intentRevision) return;
  if (handleAnatomy(text)) return;
  if (isOpenMapCommand(text)) {
    openRecentMap();
    return;
  }
  // Hold likely map replies while semantic classification runs.
  if (mapFollowUp(text) || mapIntent(text) || completeMapEndpoint(text, pendingMapAddress) ||
      mapDestinationChange(text, pendingMapAddress ?? mapContext)) {
    muteMapReply();
    mapMuteUntil = performance.now() + 16_000;
  }
  const intent = await interpretMapRequest(text, revision);
  if (revision === intentRevision && !intent && !mapLookupPending && !mapPromptQueue) clearMapMute();
  if (!intent || peer !== connection || state.manualStop || revision !== intentRevision) return;
  transcript.textContent = text;
  openMapRequest(intent);
}

function muteMapReply() {
  mapReplyMuted = true;
  mapMuteUntil = performance.now() + 2400;
  // Let audio that's already audible finish before suppressing the map reply.
  if (performance.now() - lastRemoteSpeech >= 750) voiceAudio.muted = true;
}

function clearMapMute() {
  mapReplyMuted = false;
  voiceAudio.muted = false;
}

routeButton.addEventListener("click", () => {
  if (!cityView.hidden) {
    setCityOpen(false);
    return;
  }
  ++intentRevision;
  openRecentMap();
});
closeCity.addEventListener("click", () => setCityOpen(false));
$("#reset-city").addEventListener("click", city.reset);
const citySource = $<HTMLButtonElement>("#city-source");
const citySourceDetails = $<HTMLElement>("#city-source-details");
citySource.addEventListener("click", () => {
  citySourceDetails.hidden = !citySourceDetails.hidden;
  citySource.setAttribute("aria-expanded", String(!citySourceDetails.hidden));
});
cityView.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setCityOpen(false);
});

switchViewButton.addEventListener("click", () => {
  const view = shell.dataset.view === "workspace" ? "avatar" : "workspace";
  shell.dataset.view = view;
  const label = view === "avatar" ? "返回工作台" : "切换到机械猫";
  switchViewButton.title = label;
  switchViewButton.setAttribute("aria-label", label);
  if (view === "avatar") prepareVisualParticles();
});

for (const button of document.querySelectorAll<HTMLButtonElement>(".quick-actions button")) {
  button.addEventListener("click", () => {
    commandInput.value = button.dataset.prompt ?? "";
    commandInput.focus();
    commandInput.setSelectionRange(commandInput.value.length, commandInput.value.length);
  });
}
let controlsHideTimer: number | undefined;
let characterActionTimer: number | undefined;

function revealControls() {
  if (controlsHideTimer !== undefined) window.clearTimeout(controlsHideTimer);
  shell.classList.add("controls-visible");
}

function scheduleControlsHide() {
  if (controlsHideTimer !== undefined) window.clearTimeout(controlsHideTimer);
  controlsHideTimer = window.setTimeout(() => shell.classList.remove("controls-visible"), 1500);
}

type CharacterAction = "acknowledge" | "approval" | "complete" | "error";

function triggerCharacterAction(action: CharacterAction, duration = 1100) {
  if (characterActionTimer !== undefined) window.clearTimeout(characterActionTimer);
  for (const name of ["acknowledge", "approval", "complete", "error"] as const) {
    shell.classList.remove(`action-${name}`);
  }
  void shell.clientWidth;
  shell.classList.add(`action-${action}`);
  characterActionTimer = window.setTimeout(() => shell.classList.remove(`action-${action}`), duration);
}

for (const area of [characterRig, hoverControls, settingsButton, switchViewButton]) {
  area.addEventListener("pointerenter", revealControls);
  area.addEventListener("pointerleave", scheduleControlsHide);
}
shell.addEventListener("focusin", (event) => {
  if (event.target instanceof Element && (hoverControls.contains(event.target) || settingsButton.contains(event.target) || switchViewButton.contains(event.target))) revealControls();
});
shell.addEventListener("focusout", scheduleControlsHide);

let approvalId: number | string | undefined;
const copy: Record<Mode, [string, string]> = {
  booting: ["INITIALIZING", "SYSTEM BOOT"], ready: ["READY", "CODEX VOICE STANDBY"],
  "voice-starting": ["VOICE LINKING", "OPENING CODEX VOICE"], listening: ["LISTENING", "OFFICIAL VOICE ONLINE"],
  working: ["CODEX WORKING", "TASK EXECUTION"], speaking: ["JARVIS SPEAKING", "VOICE OUTPUT"],
  degraded: ["PERMISSION NEEDED", "WAKE SYSTEM OFFLINE"], stopped: ["INTERRUPTED", "ALL SYSTEMS HALTED"],
};

function setMode(mode: Mode) {
  state.mode = mode; shell.setAttribute("data-mode", mode);
  if (!currentWindow) mic.classList.toggle("active", mode === "listening" || mode === "speaking");
  $("#mode-label").textContent = copy[mode][0]; $("#identity-state").textContent = copy[mode][1];
  $("#core-state").textContent = copy[mode][1];
  $("#work-status").textContent = mode === "working" ? "Codex 正在执行任务" : mode === "stopped" ? "任务已中断" : "等待指令";
  if (mode === "voice-starting" && shell.dataset.view === "avatar") {
    shell.classList.remove("is-forming");
    void shell.clientWidth;
    shell.classList.add("is-forming");
    startParticleFormation();
  }
}
function setWorker(role: string, label: string, active = true) {
  const card = document.querySelector<HTMLElement>(`.worker[data-role="${role}"]`);
  if (!card) return;
  card.classList.toggle("active", active); card.querySelector("small")!.textContent = label;
}
function roleOf(params: any) {
  const text = JSON.stringify(params ?? {}).toLowerCase();
  return text.includes("research") ? "researcher" : text.includes("review") ? "reviewer" :
    text.includes("developer") || text.includes("commandexecution") || text.includes("filechange") ? "developer" : "orchestrator";
}
const waveCanvas = $<HTMLCanvasElement>("#wave");
const waveContext = waveCanvas.getContext("2d")!;
let lastWaveFrame = -Infinity;

function drawWave(now: number) {
  requestAnimationFrame(drawWave);
  if (shell.dataset.view !== "workspace" || document.hidden || now - lastWaveFrame < (voiceInUse() ? 80 : 40)) return;
  lastWaveFrame = now;
  const canvas = waveCanvas;
  const context = waveContext;
  context.clearRect(0, 0, canvas.width, canvas.height);
  const time = performance.now() / 370, amplitude = 5 + state.level * 42 + (state.mode === "speaking" ? 22 : 0);
  for (let layer = 0; layer < (voiceInUse() ? 2 : 4); layer++) {
    context.beginPath();
    for (let x = 0; x <= canvas.width; x += 3) {
      const envelope = .28 + .72 * Math.sin(x / canvas.width * Math.PI);
      const y = canvas.height / 2 + (Math.sin(x * .034 + time * 2.2 + layer * .8) +
        Math.sin(x * .014 - time + layer) * .55) * (amplitude + 6) * envelope;
      if (x === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.strokeStyle = state.mode === "working" ? "#ffc08a" : state.mode === "stopped" ? "#fc7069" : "#99dbff";
    context.globalAlpha = .8 - layer * .15;
    context.shadowColor = context.strokeStyle;
    context.shadowBlur = voiceInUse() ? 0 : 9;
    context.lineWidth = 1.6;
    context.stroke();
  }
  context.globalAlpha = 1;
}
requestAnimationFrame(drawWave);

type VisualParticle = {
  fromX: number;
  fromY: number;
  targetX: number;
  targetY: number;
  size: number;
  phase: number;
  delay: number;
  curve: number;
  amber: boolean;
};

const particleCanvas = $("#particle-field") as HTMLCanvasElement;
const particleContext = particleCanvas.getContext("2d")!;
const characterImage = $("#jarvis-character") as HTMLImageElement;
const armorShardLayer = $<HTMLElement>(".armor-shards");
const armorShardSpecs = [
  ["polygon(35% 4%,65% 4%,63% 23%,37% 23%)", 0, -390, -8, 80],
  ["polygon(17% 9%,37% 4%,38% 31%,22% 35%)", -430, -280, -24, 0],
  ["polygon(63% 4%,83% 9%,78% 35%,62% 31%)", 430, -280, 24, 20],
  ["polygon(37% 22%,63% 22%,61% 45%,39% 45%)", 30, -320, 10, 170],
  ["polygon(20% 31%,39% 27%,43% 48%,19% 49%)", -470, -120, -32, 100],
  ["polygon(61% 27%,80% 31%,81% 49%,57% 48%)", 470, -120, 32, 120],
  ["polygon(16% 45%,43% 44%,46% 57%,20% 59%)", -520, -20, -18, 220],
  ["polygon(57% 44%,84% 45%,80% 59%,54% 57%)", 520, -20, 18, 240],
  ["polygon(42% 43%,58% 43%,59% 70%,41% 70%)", 0, 390, -10, 300],
  ["polygon(19% 56%,42% 54%,41% 73%,24% 78%)", -480, 180, -28, 280],
  ["polygon(58% 54%,81% 56%,76% 78%,59% 73%)", 480, 180, 28, 300],
  ["polygon(24% 73%,42% 68%,45% 84%,31% 88%)", -340, 330, 22, 390],
  ["polygon(58% 68%,76% 73%,69% 88%,55% 84%)", 340, 330, -22, 410],
  ["polygon(41% 68%,59% 68%,56% 88%,44% 88%)", 40, 430, 14, 470],
  ["polygon(31% 85%,45% 82%,44% 96%,36% 94%)", -250, 460, -30, 500],
  ["polygon(55% 82%,69% 85%,64% 94%,56% 96%)", 250, 460, 30, 520],
  ["polygon(43% 86%,57% 86%,56% 98%,44% 98%)", 0, 520, -12, 560],
  ["polygon(12% 25%,24% 19%,22% 45%,14% 52%)", -560, -210, -38, 180],
  ["polygon(76% 19%,88% 25%,86% 52%,78% 45%)", 560, -210, 38, 200],
] as const;

for (const [clip, translateX, translateY, rotation, delay] of armorShardSpecs) {
  const shard = document.createElement("i");
  shard.className = "armor-shard";
  shard.style.setProperty("--shard-clip", clip);
  shard.style.setProperty("--shard-x", `${translateX}px`);
  shard.style.setProperty("--shard-y", `${translateY}px`);
  shard.style.setProperty("--shard-rotation", `${rotation}deg`);
  shard.style.setProperty("--shard-delay", `${delay}ms`);
  if (Math.abs(rotation) >= 28 || delay % 3 === 0) shard.classList.add("amber-edge");
  armorShardLayer.append(shard);
}

let visualParticles: VisualParticle[] = [];
let formationStartedAt = -10_000;
let particleTargetBounds = { left: 0, top: 0, width: 1, height: 1 };
const FORMATION_DURATION = 3200;

function scatterParticleFromWindowEdge(particle: VisualParticle) {
  const edge = Math.floor(Math.random() * 4);
  const inset = Math.random() * 24;
  if (edge === 0) {
    particle.fromX = inset;
    particle.fromY = Math.random() * particleCanvas.height;
  } else if (edge === 1) {
    particle.fromX = particleCanvas.width - inset;
    particle.fromY = Math.random() * particleCanvas.height;
  } else {
    particle.fromX = Math.random() * particleCanvas.width;
    particle.fromY = edge === 2 ? inset : particleCanvas.height - inset;
  }
}

function syncParticleCanvasSize() {
  const bounds = shell.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
  if (particleCanvas.width !== width) particleCanvas.width = width;
  if (particleCanvas.height !== height) particleCanvas.height = height;
}

function prepareVisualParticles() {
  if (shell.dataset.view !== "avatar") return;
  if (!characterImage.naturalWidth) return;
  syncParticleCanvasSize();
  const sample = document.createElement("canvas");
  sample.width = particleCanvas.width;
  sample.height = particleCanvas.height;
  const context = sample.getContext("2d", { willReadFrequently: true })!;
  const shellBounds = shell.getBoundingClientRect();
  const characterBounds = characterImage.getBoundingClientRect();
  const left = characterBounds.left - shellBounds.left;
  const top = characterBounds.top - shellBounds.top;
  particleTargetBounds = { left, top, width: characterBounds.width, height: characterBounds.height };
  context.drawImage(characterImage, left, top, characterBounds.width, characterBounds.height);
  const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
  visualParticles = [];
  for (let y = 0; y < sample.height; y += 7) {
    for (let x = 0; x < sample.width; x += 7) {
      const alpha = pixels[(y * sample.width + x) * 4 + 3];
      if (alpha < 46 || Math.random() > .82) continue;
      const particle: VisualParticle = {
        fromX: 0,
        fromY: 0,
        targetX: x + (Math.random() - .5) * 5,
        targetY: y + (Math.random() - .5) * 5,
        size: Math.random() > .965 ? 2.6 + Math.random() * 1.8 : .45 + Math.random() * 1.65,
        phase: Math.random() * Math.PI * 2,
        delay: Math.random() * .3,
        curve: (Math.random() - .5) * (90 + Math.random() * 190),
        amber: Math.random() < .16,
      };
      scatterParticleFromWindowEdge(particle);
      visualParticles.push(particle);
    }
  }
}

function startParticleFormation() {
  if (!visualParticles.length) prepareVisualParticles();
  formationStartedAt = performance.now();
  for (const particle of visualParticles) scatterParticleFromWindowEdge(particle);
}

function easeFormation(value: number) {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * (3 - 2 * clamped);
}

function particlePosition(particle: VisualParticle, progress: number) {
  const eased = easeFormation(progress);
  const deltaX = particle.targetX - particle.fromX;
  const deltaY = particle.targetY - particle.fromY;
  const distance = Math.max(1, Math.hypot(deltaX, deltaY));
  const bend = Math.sin(eased * Math.PI) * particle.curve;
  return {
    x: particle.fromX + deltaX * eased - deltaY / distance * bend,
    y: particle.fromY + deltaY * eased + deltaX / distance * bend,
  };
}

function drawFormationEnergy(now: number, rawProgress: number) {
  if (rawProgress < 0 || rawProgress > 1.12) return;
  const progress = Math.max(0, Math.min(1, rawProgress));
  const centerX = particleTargetBounds.left + particleTargetBounds.width / 2;
  const centerY = particleTargetBounds.top + particleTargetBounds.height / 2;
  const intensity = Math.sin(progress * Math.PI);
  const outerRadius = Math.max(particleCanvas.width, particleCanvas.height) * .56;
  const targetRadius = Math.max(particleTargetBounds.width, particleTargetBounds.height) * .48;
  const radius = outerRadius + (targetRadius - outerRadius) * easeFormation(progress);

  particleContext.save();
  particleContext.globalCompositeOperation = "lighter";
  particleContext.translate(centerX, centerY);
  particleContext.scale(1, .72);
  for (let index = 0; index < 4; index += 1) {
    const ringRadius = radius + index * 34;
    particleContext.beginPath();
    particleContext.setLineDash([16 + index * 5, 34 + index * 7]);
    particleContext.lineDashOffset = (index % 2 ? 1 : -1) * now / (12 + index * 3);
    particleContext.arc(0, 0, ringRadius, 0, Math.PI * 2);
    particleContext.lineWidth = index === 0 ? 1.8 : .75;
    particleContext.strokeStyle = index === 2
      ? `rgba(255,155,47,${intensity * .48})`
      : `rgba(34,199,255,${intensity * (.56 - index * .08)})`;
    particleContext.stroke();
  }
  particleContext.restore();

  const shock = Math.max(0, Math.min(1, (progress - .68) / .25));
  if (shock > 0 && shock < 1) {
    particleContext.save();
    particleContext.globalCompositeOperation = "lighter";
    particleContext.beginPath();
    particleContext.ellipse(
      centerX,
      centerY,
      targetRadius * (.65 + shock * 1.35),
      targetRadius * (.48 + shock * .95),
      0,
      0,
      Math.PI * 2,
    );
    particleContext.strokeStyle = `rgba(134,229,255,${(1 - shock) * .85})`;
    particleContext.shadowColor = "#22c7ff";
    particleContext.shadowBlur = 28;
    particleContext.lineWidth = 2.4;
    particleContext.stroke();
    particleContext.restore();
  }
}

function drawParticleField(now: number) {
  if (shell.dataset.view !== "avatar") {
    requestAnimationFrame(drawParticleField);
    return;
  }
  particleContext.clearRect(0, 0, particleCanvas.width, particleCanvas.height);
  if (visualParticles.length) {
    const rawProgress = (now - formationStartedAt) / FORMATION_DURATION;
    const forming = rawProgress >= 0 && rawProgress < 1.08;
    const idleStrength = state.mode === "speaking" ? .18 + state.level * .48 : state.mode === "working" ? .12 : .045;
    particleContext.globalCompositeOperation = "lighter";
    for (const particle of visualParticles) {
      const localRaw = forming ? (rawProgress - particle.delay) / (1 - particle.delay) : 1;
      const progress = Math.max(0, Math.min(1, localRaw));
      const point = particlePosition(particle, progress);
      const previous = particlePosition(particle, Math.max(0, progress - (.035 + particle.size * .008)));
      const drift = forming ? 0 : Math.sin(now / 760 + particle.phase) * (1.1 + state.level * 3.2);
      const x = point.x + drift;
      const y = point.y + Math.cos(now / 830 + particle.phase) * (forming ? 0 : 1.4);
      const alpha = forming
        ? localRaw < 0
          ? .12 + Math.sin(now / 180 + particle.phase) * .08
          : .34 + Math.sin(progress * Math.PI) * .66
        : idleStrength;
      const color = state.mode === "working"
        ? "255,155,47"
        : state.mode === "stopped"
          ? "255,73,62"
          : particle.amber
            ? "255,155,47"
            : "34,199,255";
      if (forming) {
        particleContext.beginPath();
        particleContext.moveTo(previous.x, previous.y);
        particleContext.lineTo(x, y);
        particleContext.strokeStyle = `rgba(${color},${alpha * (particle.size > 2.5 ? .62 : .28)})`;
        particleContext.lineWidth = particle.size > 2.5 ? 1.5 : .65;
        particleContext.stroke();
      }
      particleContext.beginPath();
      particleContext.arc(x, y, particle.size * (forming ? 1.3 : 1), 0, Math.PI * 2);
      particleContext.fillStyle = `rgba(${color},${alpha})`;
      particleContext.fill();
    }
    if (forming) drawFormationEnergy(now, rawProgress);
    particleContext.globalCompositeOperation = "source-over";
  }
  requestAnimationFrame(drawParticleField);
}

if (characterImage.complete && characterImage.naturalWidth) prepareVisualParticles();
else characterImage.addEventListener("load", prepareVisualParticles, { once: true });
new ResizeObserver(() => prepareVisualParticles()).observe(shell);
requestAnimationFrame(drawParticleField);

function analyserLevel(analyser: AnalyserNode | null) {
  if (!analyser) return 0;
  analyser.getByteTimeDomainData(meterSamples);
  let energy = 0;
  for (const sample of meterSamples) {
    const normalized = (sample - 128) / 128;
    energy += normalized * normalized;
  }
  return Math.min(1, Math.sqrt(energy / meterSamples.length) * 5);
}

function updateAudioMeters() {
  const now = performance.now();
  if (!currentWindow) {
    state.level = state.mode === "speaking"
      ? .52 + Math.sin(now / 125) * .16
      : state.mode === "working"
        ? .2 + Math.sin(now / 310) * .08
        : state.mode === "listening"
          ? .08 + Math.sin(now / 430) * .035
          : 0;
  } else {
    const remoteLevel = analyserLevel(remoteAnalyser);
    if (remoteLevel > .045) lastRemoteSpeech = now;
    if (mapReplyMuted && now - lastRemoteSpeech >= 750) voiceAudio.muted = true;
    if (mapPromptQueue && now >= mapPromptQueue.readyAt &&
        now - lastRemoteSpeech >= 750) {
      const { text } = mapPromptQueue;
      mapPromptQueue = null;
      playMapPrompt(text);
    } else if (mapReplyMuted && !hasMapFailure() && !mapLookupPending && !mapPromptQueue &&
        now > mapMuteUntil && now - lastRemoteSpeech >= 750) {
      clearMapMute();
    }
    const speakerLevel = voiceAudio.muted ? 0 : remoteLevel;
    if (speakerLevel > .045) {
      microphoneHoldUntil = Math.max(microphoneHoldUntil, now + 900);
      mapSpeechStartUntil = 0;
    }
    syncMicrophone(now);
    state.level = Math.max(state.level * .75, analyserLevel(microphoneAnalyser), speakerLevel);
    if (speakerLevel > .08) lastSpeakerActivity = now;
    if (state.directVoice?.voiceActive && !state.agentWorking && !state.manualStop) {
      if (speakerLevel > .08 && state.mode === "listening") setMode("speaking");
      if (state.mode === "speaking" && now - lastSpeakerActivity > 340) setMode("listening");
    }
  }

  if (shell.dataset.view === "avatar" && !document.hidden) {
    shell.style.setProperty("--voice-pulse", String(1 + state.level * .026));
    shell.style.setProperty("--voice-glow", String(.45 + state.level * .55));
  }
}
window.setInterval(updateAudioMeters, 50);

function updateVoiceInfo(info: DirectVoice) {
  state.directVoice = info;
  mic.classList.toggle("active", info.voiceActive);
  $("#voice-auth").textContent = info.codexConnected
    ? `${info.protocol} · ${info.voiceActive ? "connected" : info.phase}`
    : `${info.protocol} · standby`;
  if (info.threadId) {
    state.session = { threadId: info.threadId, cwd: workspace };
    $("#thread-id").textContent = info.threadId;
    localStorage.setItem(`${THREAD_KEY_PREFIX}${workspace}`, info.threadId);
  }
}

async function handle(message: Message) {
  if (message.id !== undefined && message.method) {
    triggerCharacterAction("approval", 1800);
    approvalId = message.id; $("#approval-copy").textContent = `Codex 请求：${message.method}`; approval.showModal(); return;
  }
  const method = message.method, params = message.params;
  if (method === "thread/realtime/sdp") {
    if (!peer || !params?.sdp) return;
    try {
      await peer.setRemoteDescription({ type: "answer", sdp: params.sdp });
    } catch (error) {
      triggerCharacterAction("error");
      setMode("degraded");
      response.textContent = `Codex Voice SDP 连接失败：${String(error)}`;
    }
  } else if (method === "thread/realtime/started") {
    updateVoiceInfo({
      codexConnected: true,
      voiceActive: true,
      phase: "connected",
      protocol: "Codex app-server V3 · WebRTC",
      threadId: params?.threadId,
      realtimeSessionId: params?.realtimeSessionId,
    });
    banner.hidden = true;
    setMode("listening");
    triggerCharacterAction("acknowledge");
    setWorker("orchestrator", "Official Voice online");
    response.textContent = "Codex 官方 Voice 已上线。你现在可以直接和 Jarvis 对话。";
  } else if (method === "thread/realtime/transcript/delta") {
    const delta = typeof params?.delta === "string" ? params.delta : "";
    if (params?.role === "assistant") {
      if (mapReplyMuted || hasMapFailure()) return;
      microphoneHoldUntil = performance.now() + 900;
      syncMicrophone();
      assistantTranscriptBuffer += delta;
      response.textContent = assistantTranscriptBuffer;
      if (!state.agentWorking && !state.manualStop && state.mode === "listening") {
        lastSpeakerActivity = performance.now();
        setMode("speaking");
      }
    } else {
      userTranscriptBuffer += delta;
      transcript.textContent = userTranscriptBuffer;
      if (!state.agentWorking) setMode("listening");
    }
  } else if (method === "thread/realtime/transcript/done") {
    const text = typeof params?.text === "string" ? params.text.trim() : "";
    if (params?.role === "assistant") {
      if (text && !mapReplyMuted && !hasMapFailure()) response.textContent = text;
      assistantTranscriptBuffer = "";
    } else {
      const utterance = text || userTranscriptBuffer.trim();
      userTranscriptBuffer = "";
      if (utterance) {
        transcript.textContent = utterance;
        triggerCharacterAction("acknowledge");
        if (params?.role === "user") void handleSpokenCommand(utterance);
      }
    }
  } else if (method === "thread/realtime/itemAdded") {
    const itemType = String(params?.item?.type ?? "");
    if (!hasMapFailure() && (itemType.includes("handoff") || itemType.includes("delegation"))) {
      setMode("working");
      setWorker("orchestrator", "Delegating to Codex");
    }
  } else if (method === "thread/realtime/error") {
    triggerCharacterAction("error");
    setMode("degraded");
    banner.hidden = false;
    const detail = params?.message ?? "Codex Voice realtime error";
    $("#degraded-copy").textContent = detail;
    response.textContent = detail;
  } else if (method === "thread/realtime/closed") {
    cleanupPeer();
    updateVoiceInfo({
      codexConnected: true,
      voiceActive: false,
      phase: "closed",
      protocol: "Codex app-server V3 · WebRTC",
      threadId: params?.threadId ?? state.session?.threadId,
    });
    if (!state.manualStop) {
      setMode("ready");
      response.textContent = "Codex Voice 已结束。再次说“嗨 Jarvis”即可唤醒。";
      await armWakeListener();
    }
  } else if (method === "turn/started") {
    if (state.manualStop || hasMapFailure()) return;
    agentMessageBuffer = "";
    state.agentWorking = true;
    setMode("working"); setWorker("orchestrator", "Codex working");
  } else if (method === "item/agentMessage/delta") {
    const delta = typeof params?.delta === "string" ? params.delta : "";
    agentMessageBuffer += delta;
    if (!hasMapFailure() && !mapReplyMuted && agentMessageBuffer && !"JARVIS_MAP ".startsWith(agentMessageBuffer) && !agentMessageBuffer.startsWith("JARVIS_MAP ")) {
      response.textContent = agentMessageBuffer;
    }
  } else if (method === "turn/completed") {
    if (state.agentWorking && !state.manualStop && params?.turn?.status === "completed") {
      $("#completed-count").textContent = String(++completedCount);
    }
    state.agentWorking = false;
    if (!state.manualStop && !hasMapFailure()) triggerCharacterAction("complete", 1400);
    setMode(state.manualStop ? "stopped" : state.directVoice?.voiceActive ? "listening" : "ready");
    setWorker("orchestrator", state.manualStop ? "Interrupted" : "Ready", !state.manualStop);
    for (const role of ["developer", "researcher", "reviewer"]) {
      setWorker(role, state.manualStop ? "Interrupted" : "Standby", false);
    }
  } else if (method === "item/started") {
    if (!state.manualStop) setWorker(roleOf(params), "Working");
  }
  else if (method === "item/completed") {
    setWorker(roleOf(params), "Complete", false);
    if (params?.item?.type === "agentMessage") {
      if (hasMapFailure()) return;
      const text = typeof params.item.text === "string" ? params.item.text : agentMessageBuffer;
      const action = readMapAction(text);
      if (action && !state.manualStop) {
        const request = transcript.textContent ?? "";
        const intent = mapIntentFromClassification(action, request, Boolean((pendingMapAddress ?? mapContext)?.origin));
        if (intent && !peer && !mapLookupPending) openMapRequest(intent);
      } else if (text && !action && !mapReplyMuted) {
        response.textContent = text;
      }
    }
  }
}

async function waitForIceGathering(connection: RTCPeerConnection) {
  if (connection.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      connection.removeEventListener("icegatheringstatechange", changed);
      reject(new Error("WebRTC ICE gathering timed out"));
    }, 12_000);
    const changed = () => {
      if (connection.iceGatheringState !== "complete") return;
      window.clearTimeout(timer);
      connection.removeEventListener("icegatheringstatechange", changed);
      resolve();
    };
    connection.addEventListener("icegatheringstatechange", changed);
  });
}

function attachAnalyser(stream: MediaStream, target: "microphone" | "remote") {
  audioContext ??= new AudioContext();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = meterSamples.length;
  audioContext.createMediaStreamSource(stream).connect(analyser);
  if (target === "microphone") microphoneAnalyser = analyser;
  else remoteAnalyser = analyser;
}

function cleanupPeer() {
  ++intentRevision;
  mapPromptQueue = null;
  lastRemoteSpeech = -Infinity;
  microphoneHoldUntil = 0;
  mapSpeechStartUntil = 0;
  userTranscriptBuffer = "";
  assistantTranscriptBuffer = "";
  clearMapMute();
  peer?.close();
  peer = null;
  microphoneStream?.getTracks().forEach((track) => track.stop());
  microphoneStream = null;
  remoteStream?.getTracks().forEach((track) => track.stop());
  remoteStream = null;
  voiceAudio.pause();
  voiceAudio.srcObject = null;
  microphoneAnalyser = null;
  remoteAnalyser = null;
  lastSpeakerActivity = -Infinity;
  state.level = 0;
  const context = audioContext;
  audioContext = null;
  void context?.close().catch(() => {});
}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

function isNotAllowedError(error: unknown) {
  return error instanceof DOMException
    ? error.name === "NotAllowedError"
    : String(error).includes("NotAllowedError");
}

async function acquireMicrophone(coldStart: boolean) {
  const attempts = coldStart ? 6 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      if (!coldStart || !isNotAllowedError(error) || attempt === attempts) throw error;
      response.textContent = `正在等待系统释放麦克风… ${attempt}/${attempts - 1}`;
      await sleep(700);
    }
  }
  throw new Error("麦克风初始化失败");
}

async function startDirectVoice({ coldStart = false } = {}) {
  if (!currentWindow) {
    setMode("voice-starting");
    window.setTimeout(() => {
      if (state.mode === "voice-starting") setMode("listening");
    }, FORMATION_DURATION);
    return;
  }
  if (voiceStartInFlight || peer || state.directVoice?.voiceActive) return;
  voiceStartInFlight = true;
  state.manualStop = false;
  recoverableColdStartError = false;
  setMode("voice-starting");
  banner.hidden = true;
  response.textContent = "正在建立 Codex 官方 Voice V3 WebRTC 会话…";
  try {
    const microphoneAuthorization = await invoke<string>("request_microphone_permission");
    if (microphoneAuthorization !== "authorized") {
      throw new Error("请在系统设置 → 隐私与安全性 → 麦克风中允许 Jarvis Codex。");
    }
    await invoke("disarm_wake_listener");
    if (coldStart) {
      // A newly created WKWebView can reject an otherwise-authorized
      // getUserMedia call until its first visible/focused render cycle.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      await sleep(900);
    }
    microphoneStream = await acquireMicrophone(coldStart);
    attachAnalyser(microphoneStream, "microphone");

    const connection = new RTCPeerConnection();
    peer = connection;
    const track = microphoneStream.getAudioTracks()[0];
    if (!track) throw new Error("未找到麦克风音轨");
    connection.addTrack(track, microphoneStream);
    connection.createDataChannel("oai-events");
    connection.ontrack = (event) => {
      if (peer !== connection || event.track.kind !== "audio") return;
      remoteStream = event.streams[0] ?? new MediaStream([event.track]);
      voiceAudio.srcObject = remoteStream;
      attachAnalyser(remoteStream, "remote");
      void audioContext?.resume().catch(() => {});
      void voiceAudio.play().catch((error) => {
        if (peer !== connection) return;
        response.textContent = `语音播放失败：${String(error)}`;
      });
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === "failed") {
        setMode("degraded");
        response.textContent = "Codex Voice WebRTC 连接失败。";
      }
    };
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    await waitForIceGathering(connection);
    const sdp = connection.localDescription?.sdp;
    if (!sdp) throw new Error("WebRTC 未生成 SDP offer");

    const info = await invoke<DirectVoice>("start_codex_voice", {
      cwd: workspace,
      threadId: savedThreadId(),
      permissionMode,
      sdp,
      voice: "cove",
    });
    updateVoiceInfo(info);
  } catch (error) {
    cleanupPeer();
    recoverableColdStartError = coldStart && isNotAllowedError(error);
    setMode("degraded");
    banner.hidden = false;
    $("#degraded-copy").textContent = String(error);
    response.textContent = String(error);
    await armWakeListener();
  } finally {
    voiceStartInFlight = false;
  }
}

async function stopDirectVoice() {
  try {
    const info = await invoke<DirectVoice>("stop_codex_voice");
    updateVoiceInfo(info);
  } finally {
    cleanupPeer();
  }
}

if (currentWindow) {
  await listen<Message>("codex-event", ({ payload }) => void handle(payload));
  await currentWindow.onCloseRequested(async (event) => {
    event.preventDefault();
    await currentWindow.hide();
    if (state.directVoice?.voiceActive || peer) {
      cleanupPeer();
      try { await stopDirectVoice(); } catch (error) { console.warn(error); }
    }
    await armWakeListener();
  });
  await listen<WakeStatus>("jarvis-wake-status", ({ payload }) => {
    state.wake = payload;
    $("#wake-auth").textContent = payload.ready
      ? "Local listener ready"
      : payload.authorization === "authorized"
        ? "Waiting to re-arm"
        : payload.authorization;
    if (payload.ready) {
      if (recoverableColdStartError && state.mode === "degraded") {
        recoverableColdStartError = false;
        banner.hidden = true;
        setMode("ready");
      }
      if (state.mode === "ready") {
        response.textContent = "我在。直接说“嗨 Jarvis”。";
        setWorker("orchestrator", "Wake word armed");
      }
    }
  });
  await listen<WakeEvent>("jarvis-wake", ({ payload }) => {
    transcript.textContent = "“嗨，Jarvis”";
    state.manualStop = false;
    if (!payload.ok) {
      setMode("degraded");
      banner.hidden = false;
      $("#degraded-copy").textContent = payload.error ?? "无法打开官方 Codex Voice。";
      response.textContent = payload.error ?? "无法打开官方 Codex Voice。";
      return;
    }
    banner.hidden = true;
    void startDirectVoice({ coldStart: payload.cold === true });
  });
}
$("#command-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const input = $("#command-input") as HTMLInputElement, text = input.value.trim();
  if (!text) return;
  state.manualStop = false;
  transcript.textContent = text;
  input.value = "";
  if (handleAnatomy(text)) return;
  const revision = beginUserCommand(text);
  if (revision === null) return;
  if (await handleProfileQuestion(text, revision) || revision !== intentRevision) return;
  const correction = mapDestinationChange(text, pendingMapAddress ?? mapContext) ?? completeMapEndpoint(text, pendingMapAddress);
  const direct = correction ?? mapIntent(text);
  if (isOpenMapCommand(text)) {
    openRecentMap();
    return;
  }
  if (direct && (correction || direct.origin || !currentWindow || !mapFollowUp(text))) {
    openMapRequest(direct);
    return;
  }
  if (!currentWindow) {
    response.textContent = "视觉预览：文字任务已切换为 Codex 工作态。";
    setMode("working");
    return;
  }
  try {
    if (!state.session) {
      state.session = await invoke<Session>("start_jarvis", {
        cwd: workspace,
        threadId: savedThreadId(),
        permissionMode,
      });
      localStorage.setItem(`${THREAD_KEY_PREFIX}${workspace}`, state.session.threadId);
      $("#thread-id").textContent = state.session.threadId;
      $("#workspace").textContent = state.session.cwd;
    }
    const intent = await interpretMapRequest(text, revision);
    if (revision !== intentRevision || state.manualStop) return;
    if (intent) {
      openMapRequest(intent);
      return;
    }
    if (state.directVoice?.voiceActive) {
      await invoke("append_codex_voice_text", { text });
      return;
    }
    setMode("working");
    await invoke("send_text", { text });
  } catch (error) {
    if (revision === intentRevision && !state.manualStop) response.textContent = String(error);
  }
});
mic.addEventListener("click", () => {
  if (!currentWindow && ["voice-starting", "listening", "speaking"].includes(state.mode)) {
    setMode("ready");
    return;
  }
  if (state.directVoice?.voiceActive || peer) void stopDirectVoice();
  else void startDirectVoice();
});
$("#stop").addEventListener("click", async () => {
  triggerCharacterAction("error", 700);
  state.manualStop = true; setMode("stopped");
  ++intentRevision;
  pendingMapAddress = null;
  citySearch.close();
  mapLookupPending = false;
  activeMapKey = "";
  mapPromptQueue = null;
  state.agentWorking = false;
  for (const role of ["orchestrator", "developer", "researcher", "reviewer"]) setWorker(role, "Interrupted", false);
  if (!currentWindow) return;
  if (state.directVoice?.voiceActive || peer) {
    try { await stopDirectVoice(); } catch { /* task interruption still continues */ }
  }
  await invoke("stop_all");
  await armWakeListener();
});
function syncPermissionControls() {
  const input = document.querySelector<HTMLInputElement>(
    `input[name="permission-mode"][value="${permissionMode}"]`,
  );
  if (input) input.checked = true;
  $("#permission-mode-label").textContent = permissionLabels[permissionMode];
}

$("#settings").addEventListener("click", () => {
  syncPermissionControls();
  $<HTMLInputElement>("#map-city-setting").value = mapCity;
  settings.showModal();
});
$("#close-settings").addEventListener("click", () => settings.close());
$("#new-thread").addEventListener("click", async () => {
  const button = $("#new-thread") as HTMLButtonElement;
  button.disabled = true;
  state.manualStop = true;
  settings.close();
  response.textContent = "正在结束当前任务并创建新的 Codex thread…";
  try {
    if (state.directVoice?.voiceActive || peer) {
      try { await stopDirectVoice(); } catch { cleanupPeer(); }
    }
    try { await invoke("stop_all"); } catch { /* no active runtime */ }
    await invoke("shutdown");
    const freshSession = await invoke<Session>("start_jarvis", {
      cwd: workspace,
      threadId: null,
      permissionMode,
    });
    state.session = freshSession;
    state.directVoice = null;
    localStorage.setItem(`${THREAD_KEY_PREFIX}${workspace}`, freshSession.threadId);
    $("#thread-id").textContent = freshSession.threadId;
    $("#workspace").textContent = freshSession.cwd;
    userTranscriptBuffer = "";
    assistantTranscriptBuffer = "";
    agentMessageBuffer = "";
    transcript.textContent = "“新开线程”";
    response.textContent = "新的 Codex thread 已创建。下一次唤醒和文字任务都会进入这个线程。";
    setMode("ready");
    setWorker("orchestrator", "Fresh thread ready");
  } catch (error) {
    try { await invoke("shutdown"); } catch { /* already stopped */ }
    state.session = null;
    state.directVoice = null;
    setMode("degraded");
    response.textContent = `新建线程失败，原线程仍可续接：${String(error)}`;
  } finally {
    button.disabled = false;
    await armWakeListener();
  }
});
$("#save-settings").addEventListener("click", async () => {
  const nextWorkspace = ($("#workspace-setting") as HTMLInputElement).value.trim();
  if (!nextWorkspace) return;
  const selectedPermission = document.querySelector<HTMLInputElement>(
    'input[name="permission-mode"]:checked',
  )?.value as PermissionMode | undefined;
  const nextPermission = selectedPermission ?? permissionMode;
  const nextCity = $<HTMLInputElement>("#map-city-setting").value.normalize("NFKC").trim() || DEFAULT_MAP_CITY;
  if (nextCity !== mapCity) {
    mapCity = nextCity;
    localStorage.setItem(MAP_CITY_KEY, mapCity);
    response.textContent = `地图默认城市已设为${mapCity}。`;
  }
  if (nextWorkspace !== workspace) {
    localStorage.setItem(WORKSPACE_KEY, nextWorkspace);
    response.textContent = "工作目录已保存，重启 Jarvis 后生效。";
  }
  if (nextPermission !== permissionMode) {
    state.manualStop = true;
    if (state.directVoice?.voiceActive || peer) {
      try { await stopDirectVoice(); } catch { cleanupPeer(); }
    }
    try { await invoke("stop_all"); } catch { /* no active runtime */ }
    await invoke("shutdown");
    permissionMode = nextPermission;
    localStorage.setItem(PERMISSION_KEY, permissionMode);
    state.session = null;
    state.directVoice = null;
    syncPermissionControls();
    setMode("ready");
    response.textContent = `权限已切换为“${permissionLabels[permissionMode]}”，下一次任务将续接当前 Codex thread。`;
    await armWakeListener();
  }
  settings.close();
});
for (const [selector, approved] of [["#approve", true], ["#deny", false]] as const) {
  $(selector).addEventListener("click", async () => { await invoke("resolve_server_request", { requestId: approvalId, approved }); approval.close(); });
}

if (currentWindow) {
  try {
    workspace = localStorage.getItem(WORKSPACE_KEY)
      ?? await invoke<string>("default_workspace");
    localStorage.setItem(WORKSPACE_KEY, workspace);
    $("#thread-id").textContent = "Not started";
    $("#workspace").textContent = workspace;
    ($("#workspace-setting") as HTMLInputElement).value = workspace;
    syncPermissionControls();
    setWorker("orchestrator", "Wake word starting");
    setMode("ready");
    const backgroundStart = await invoke<boolean>("startup_is_background");
    if (!backgroundStart) {
      const microphoneAuthorization = await invoke<string>("request_microphone_permission");
      if (microphoneAuthorization !== "authorized") {
        setMode("degraded");
        banner.hidden = false;
        $("#degraded-copy").textContent =
          "请在系统设置 → 隐私与安全性 → 麦克风中允许 Jarvis Codex。";
      }
    }
    await armWakeListener();
    updateVoiceInfo(await invoke<DirectVoice>("direct_voice_status"));
    if (await invoke<boolean>("consume_cold_wake")) {
      transcript.textContent = "“嗨，Jarvis”";
    }
  } catch (error) { setMode("stopped"); response.textContent = `启动失败：${String(error)}`; }
} else {
  $("#runtime-label").textContent = "预览";
  workspace = "Visual preview · native systems disconnected";
  $("#thread-id").textContent = "Preview only";
  $("#workspace").textContent = workspace;
  ($("#workspace-setting") as HTMLInputElement).value = workspace;
  $("#wake-auth").textContent = "Preview · not connected";
  $("#voice-auth").textContent = "Preview · not connected";
  transcript.textContent = visualPreviewMode === "stopped" ? "“停下”" : "“嗨，Jarvis”";
  response.textContent = visualPreviewMode === "voice-starting"
    ? "正在从粒子中重构 Jarvis 核心…"
    : visualPreviewMode === "working"
      ? "Codex 正在执行任务，核心切换为工作态。"
      : visualPreviewMode === "speaking"
        ? "语音输出正在驱动核心光效与声波。"
        : visualPreviewMode === "stopped"
          ? "所有任务已中断，等待下一次唤醒。"
          : "在，先生。今天有什么安排？";
  setMode(visualPreviewMode);
  if (["acknowledge", "approval", "complete", "error"].includes(previewActionValue ?? "")) {
    window.setTimeout(() => triggerCharacterAction(previewActionValue as CharacterAction, 1800), 180);
  }
  setWorker("orchestrator", visualPreviewMode === "working" ? "Codex working" : "Visual preview");
  if (visualPreviewMode === "working") {
    setWorker("developer", "Working");
  }
}

async function armWakeListener() {
  try {
    state.wake = await invoke<WakeStatus>("arm_wake_listener");
    $("#wake-auth").textContent = state.wake.ready ? "Local listener ready" : state.wake.authorization;
    if (["denied", "restricted"].includes(state.wake.authorization)) {
      setMode("degraded");
      banner.hidden = false;
      $("#degraded-copy").textContent = "请在系统设置 → 隐私与安全性中允许麦克风和语音识别。";
    }
  } catch (error) {
    $("#wake-auth").textContent = String(error);
  }
}
