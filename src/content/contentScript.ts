import { CaptionUpdate, RuntimeMessage, RuntimeResponse, StreamMode } from "../types";

const ROOT_ID = "rvt-subtitle-root";
const NATIVE_CUE_STYLE_ID = "rvt-native-cue-style";
const PAGE_TRANSLATION_BATCH_SIZE = 20;
const PAGE_TRANSLATION_CONCURRENCY = 4;
const PAGE_TRANSLATION_MAX_NODES = 1_500;
const PAGE_TRANSLATION_MAX_NODE_CHARS = 1_800;
const STABLE_CAPTION_MAX_CHARS = 22;
const STABLE_CAPTION_MIN_CHARS = 6;
const STABLE_CAPTION_FAST_COMMIT_MS = 650;
const STABLE_CAPTION_FALLBACK_COMMIT_MS = 2_400;
const CAPTION_STALE_MS = 12_000;
const VIDEO_RESUME_GRACE_MS = 2_800;
const VIDEO_RESUME_RESTART_THROTTLE_MS = 8_000;
const VIDEO_RESUME_FORCE_RESTART_THROTTLE_MS = 1_500;
const VIDEO_RESUME_FORCE_RESTART_DELAY_MS = 350;

type RvtWindow = Window & {
  __rvtContentScriptCleanup?: () => void;
};

const rvtWindow = window as RvtWindow;
try {
  rvtWindow.__rvtContentScriptCleanup?.();
} catch {
  // A previous content script may belong to an invalidated extension context.
}

document.getElementById(ROOT_ID)?.remove();

let host: HTMLElement | null = null;
let root: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let sourceEl: HTMLElement | null = null;
let translationEl: HTMLElement | null = null;
let positionTimer: number | null = null;
let captionExpiryTimer: number | null = null;
let translatedTextNodes: Array<{ node: Text; original: string }> = [];
let nativeCaptionTrack: TextTrack | null = null;
let nativeCaptionVideo: HTMLVideoElement | null = null;
let activeCaptionVideo: HTMLVideoElement | null = null;
let lastCaption: CaptionUpdate | null = null;
let lastStableTranslation: Pick<CaptionUpdate, "sourceText" | "translatedText"> | null = null;
let lastCaptionRevision = 0;
let committedCaptionLines: string[] = [];
let committedCaptionSourceKeys: string[] = [];
let pendingStableCaption: { caption: CaptionUpdate; allowFragment: boolean } | null = null;
let stableCaptionTimer: number | null = null;
let autoPageTranslationEnabled = false;
let autoPageTranslationTargetLanguage = "zh-CN";
let autoPageTranslationTimer: number | null = null;
let observedPageUrl = location.href;
let activePageTranslationRunId = 0;
let autoPageTranslationWatchersInstalled = false;
let videoResumeWatchdogInstalled = false;
let videoResumeTimer: number | null = null;
let lastVideoResumeRestartAt = 0;
let videoPauseObserved = false;
let pendingVideoResumeForceRestart = false;
let translatorSuspendedByVideoPause = false;
let videoPauseSuspendInFlight = false;
let videoResumeInFlight = false;
let extensionContextInvalidated = false;
let originalPushState: History["pushState"] | null = null;
let originalReplaceState: History["replaceState"] | null = null;

rvtWindow.__rvtContentScriptCleanup = cleanupContentScript;
void initAutoPageTranslation();
installVideoResumeWatchdog();
window.addEventListener("unhandledrejection", handleUnhandledRejection);

if (isExtensionRuntimeAvailable()) {
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
}

function handleRuntimeMessage(message: RuntimeMessage, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void): boolean {
  if (!isExtensionRuntimeAvailable()) return false;
  if (message.type === "caption:update") {
    renderCaption(message.caption);
  }

  if (message.type === "caption:clear") {
    clearCaptionDisplay();
  }

  if (message.type === "caption:state") {
    if (message.running) {
      ensureOverlay();
      setStatus(true, message.mode);
    } else if (host) {
      translatorSuspendedByVideoPause = false;
      clearCaptionDisplay();
    }
  }

  if (message.type === "page:translate") {
    translatePage(message.targetLanguage ?? "zh-CN")
      .then((translated) => sendResponse({ ok: true, translated }))
      .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (message.type === "page:restore") {
    const restored = restorePage();
    sendResponse({ ok: true, restored });
  }

  return false;
}

async function initAutoPageTranslation(): Promise<void> {
  if (!isExtensionRuntimeAvailable()) return;
  installAutoPageTranslationWatchers();
  const response = await sendRuntimeMessageSafe<RuntimeResponse>({ type: "translator:settings:get" } satisfies RuntimeMessage);
  if (!response?.ok || !response.settings) return;

  updateAutoPageTranslationState(response.settings.autoTranslatePages, response.settings.targetLanguage);
}

function installAutoPageTranslationWatchers(): void {
  if (autoPageTranslationWatchersInstalled) return;
  if (!isExtensionRuntimeAvailable()) return;
  autoPageTranslationWatchersInstalled = true;

  chrome.storage.onChanged.addListener(handleStorageChanged);

  originalPushState = history.pushState;
  history.pushState = function pushState(...args) {
    const result = originalPushState?.apply(this, args) ?? undefined;
    handlePageUrlMaybeChanged();
    return result;
  };

  originalReplaceState = history.replaceState;
  history.replaceState = function replaceState(...args) {
    const result = originalReplaceState?.apply(this, args) ?? undefined;
    handlePageUrlMaybeChanged();
    return result;
  };

  window.addEventListener("popstate", handlePageUrlMaybeChanged);
  window.addEventListener("hashchange", handlePageUrlMaybeChanged);
  window.addEventListener("pageshow", handleAutoPageShow);
}

function handleStorageChanged(changes: { [key: string]: chrome.storage.StorageChange }, areaName: string): void {
  if (!isExtensionRuntimeAvailable()) return;
  if (areaName !== "sync" || !changes.settings?.newValue) return;
  const settings = changes.settings.newValue as {
    autoTranslatePages?: boolean;
    targetLanguage?: string;
  };
  updateAutoPageTranslationState(Boolean(settings.autoTranslatePages), settings.targetLanguage ?? "zh-CN");
}

function handleAutoPageShow(): void {
  scheduleAutoPageTranslation(500);
}

function updateAutoPageTranslationState(enabled: boolean, targetLanguage: string): void {
  autoPageTranslationEnabled = enabled;
  autoPageTranslationTargetLanguage = targetLanguage || "zh-CN";

  if (enabled) {
    scheduleAutoPageTranslation(700);
    return;
  }

  if (autoPageTranslationTimer !== null) {
    window.clearTimeout(autoPageTranslationTimer);
    autoPageTranslationTimer = null;
  }
  restorePage();
}

function handlePageUrlMaybeChanged(): void {
  if (!isExtensionRuntimeAvailable()) return;
  window.setTimeout(() => {
    if (!isExtensionRuntimeAvailable()) return;
    if (observedPageUrl === location.href) return;
    observedPageUrl = location.href;
    scheduleAutoPageTranslation(900);
  }, 0);
}

function scheduleAutoPageTranslation(delayMs: number): void {
  if (!isExtensionRuntimeAvailable()) return;
  if (!autoPageTranslationEnabled) return;
  if (autoPageTranslationTimer !== null) window.clearTimeout(autoPageTranslationTimer);
  autoPageTranslationTimer = window.setTimeout(() => {
    autoPageTranslationTimer = null;
    if (!autoPageTranslationEnabled) return;
    void translatePage(autoPageTranslationTargetLanguage).catch(() => undefined);
  }, delayMs);
}

function renderCaption(caption: CaptionUpdate): void {
  if (looksLikeBackendErrorText(caption.sourceText) || looksLikeBackendErrorText(caption.translatedText)) return;
  if (!caption.isFinal) return;
  ensureOverlay();
  if (!root || !sourceEl || !translationEl) return;
  if (typeof caption.revision === "number") {
    if (caption.revision < lastCaptionRevision) return;
    lastCaptionRevision = caption.revision;
  }

  lastCaption = caption;
  if (caption.translatedText.trim()) {
    lastStableTranslation = {
      sourceText: caption.sourceText,
      translatedText: caption.translatedText,
    };
  }
  activeCaptionVideo = findBestVideo();
  scheduleStableCaptionCommit(caption);
  renderCommittedCaptionLines(caption);
}

function installVideoResumeWatchdog(): void {
  if (videoResumeWatchdogInstalled) return;
  if (!isExtensionRuntimeAvailable()) return;
  videoResumeWatchdogInstalled = true;

  document.addEventListener("play", handleVideoResumeEvent, true);
  document.addEventListener("playing", handleVideoResumeEvent, true);
  document.addEventListener("pause", handleVideoPauseEvent, true);
  window.addEventListener("focus", handlePageReturnedToForeground);
  document.addEventListener("visibilitychange", handlePageReturnedToForeground);
  window.addEventListener("pageshow", handlePageReturnedToForeground);
}

function handleVideoPauseEvent(event: Event): void {
  if (!isExtensionRuntimeAvailable()) return;
  if (!(event.target instanceof HTMLVideoElement)) return;
  videoPauseObserved = true;
  void suspendTranslatorForVideoPause();
}

function handleVideoResumeEvent(event: Event): void {
  if (!isExtensionRuntimeAvailable()) return;
  if (!(event.target instanceof HTMLVideoElement)) return;
  if (translatorSuspendedByVideoPause) {
    void resumeTranslatorAfterVideoPause();
    return;
  }
  const shouldForceRestart = videoPauseObserved;
  videoPauseObserved = false;
  scheduleVideoResumeHealthCheck(shouldForceRestart);
}

function handlePageReturnedToForeground(): void {
  if (!isExtensionRuntimeAvailable()) return;
  if (document.visibilityState === "hidden") {
    videoPauseObserved = true;
    return;
  }
  const video = findBestVideo();
  if (!video || video.paused) return;
  if (translatorSuspendedByVideoPause) {
    void resumeTranslatorAfterVideoPause();
    return;
  }
  const shouldForceRestart = videoPauseObserved;
  videoPauseObserved = false;
  scheduleVideoResumeHealthCheck(shouldForceRestart);
}

async function suspendTranslatorForVideoPause(): Promise<void> {
  if (videoPauseSuspendInFlight || translatorSuspendedByVideoPause) return;
  videoPauseSuspendInFlight = true;
  clearCaptionDisplay();

  try {
    const response = await sendRuntimeMessageSafe<RuntimeResponse>({ type: "translator:suspend" } satisfies RuntimeMessage);
    translatorSuspendedByVideoPause = Boolean(response?.ok && response.running);
  } finally {
    videoPauseSuspendInFlight = false;
  }
}

async function resumeTranslatorAfterVideoPause(): Promise<void> {
  if (videoResumeInFlight) return;
  videoResumeInFlight = true;

  try {
    videoPauseObserved = false;
    translatorSuspendedByVideoPause = false;
    lastVideoResumeRestartAt = Date.now();
    await sendRuntimeMessageSafe<RuntimeResponse>({ type: "translator:resume" } satisfies RuntimeMessage);
  } finally {
    videoResumeInFlight = false;
  }
}

function scheduleVideoResumeHealthCheck(forceRestart = false): void {
  if (!isExtensionRuntimeAvailable()) return;
  pendingVideoResumeForceRestart = pendingVideoResumeForceRestart || forceRestart;
  if (videoResumeTimer !== null) window.clearTimeout(videoResumeTimer);
  videoResumeTimer = window.setTimeout(() => {
    const shouldForceRestart = pendingVideoResumeForceRestart;
    pendingVideoResumeForceRestart = false;
    videoResumeTimer = null;
    void restartTranslatorIfCaptionStale(shouldForceRestart);
  }, forceRestart ? VIDEO_RESUME_FORCE_RESTART_DELAY_MS : VIDEO_RESUME_GRACE_MS);
}

async function restartTranslatorIfCaptionStale(forceRestart = false): Promise<void> {
  if (!isExtensionRuntimeAvailable()) return;
  const video = findBestVideo();
  if (!video || video.paused) return;

  const now = Date.now();
  const throttleMs = forceRestart ? VIDEO_RESUME_FORCE_RESTART_THROTTLE_MS : VIDEO_RESUME_RESTART_THROTTLE_MS;
  if (now - lastVideoResumeRestartAt < throttleMs) return;

  const status = await sendRuntimeMessageSafe<RuntimeResponse>({ type: "translator:status" } satisfies RuntimeMessage);
  if (!status?.ok || !status.running) return;

  const lastReceivedAt = lastCaption?.receivedAt ?? 0;
  if (!forceRestart && lastReceivedAt && now - lastReceivedAt < VIDEO_RESUME_GRACE_MS + 1_500) return;

  lastVideoResumeRestartAt = now;
  await sendRuntimeMessageSafe<RuntimeResponse>({ type: "translator:start" } satisfies RuntimeMessage);
}

function ensureOverlay(): void {
  ensureNativeCueStyle();

  if (host && document.documentElement.contains(host)) {
    attachOverlayToCurrentLayer();
    updateOverlayPosition();
    return;
  }

  host = document.createElement("div");
  host.id = ROOT_ID;
  host.dataset.visible = "false";
  host.dataset.running = "false";
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = SUBTITLE_STYLE;

  root = document.createElement("section");
  root.className = "rvt-subtitle-panel";
  root.dataset.phase = "idle";

  const header = document.createElement("div");
  header.className = "rvt-subtitle-header";

  const title = document.createElement("span");
  title.className = "rvt-subtitle-title";
  title.textContent = "实时字幕";

  statusEl = document.createElement("span");
  statusEl.className = "rvt-subtitle-status";

  header.append(title, statusEl);

  const body = document.createElement("div");
  body.className = "rvt-subtitle-body";

  sourceEl = document.createElement("p");
  sourceEl.className = "rvt-subtitle-source";

  translationEl = document.createElement("p");
  translationEl.className = "rvt-subtitle-translation";

  body.append(sourceEl, translationEl);
  root.append(header, body);
  shadow.append(style, root);
  attachOverlayToCurrentLayer();
  setStatus(false, "mock");
  startPositionTracking();
}

function ensureNativeCueStyle(): void {
  if (document.getElementById(NATIVE_CUE_STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = NATIVE_CUE_STYLE_ID;
  style.textContent = `
    video::cue {
      background-color: rgba(0, 0, 0, 0.08);
      color: #ffffff;
      text-shadow:
        0 1px 2px rgba(0, 0, 0, 0.85),
        0 0 6px rgba(0, 0, 0, 0.65);
    }
  `;
  document.documentElement.append(style);
}

function setStatus(running: boolean, mode: StreamMode): void {
  if (!statusEl || !host) return;
  statusEl.textContent = running ? `${mode === "websocket" ? "实时" : "模拟"}运行中` : "已停止";
  host.dataset.running = String(running);
  updateOverlayPosition();
}

function clearCaptionDisplay(): void {
  stopCaptionExpiryTimer();
  stopStableCaptionTimer();
  if (sourceEl) sourceEl.textContent = "";
  if (translationEl) translationEl.textContent = "";
  if (root) root.dataset.phase = "idle";
  if (host) {
    host.dataset.visible = "false";
    host.dataset.running = "false";
  }
  clearNativeCaptionTrack();
  activeCaptionVideo = null;
  lastCaption = null;
  lastStableTranslation = null;
  lastCaptionRevision = 0;
  committedCaptionLines = [];
  committedCaptionSourceKeys = [];
  pendingStableCaption = null;
}

function expireCaptionDisplay(): void {
  stopStableCaptionTimer();
  if (sourceEl) sourceEl.textContent = "";
  if (translationEl) translationEl.textContent = "";
  if (root) root.dataset.phase = "idle";
  if (host) host.dataset.visible = "false";
  clearNativeCaptionTrack();
  activeCaptionVideo = null;
  lastCaption = null;
  lastStableTranslation = null;
  committedCaptionLines = [];
  committedCaptionSourceKeys = [];
  pendingStableCaption = null;
}

function scheduleCaptionExpiry(): void {
  stopCaptionExpiryTimer();
  captionExpiryTimer = window.setTimeout(expireCaptionDisplay, CAPTION_STALE_MS);
}

function stopCaptionExpiryTimer(): void {
  if (captionExpiryTimer === null) return;
  window.clearTimeout(captionExpiryTimer);
  captionExpiryTimer = null;
}

function stopStableCaptionTimer(): void {
  if (stableCaptionTimer === null) return;
  window.clearTimeout(stableCaptionTimer);
  stableCaptionTimer = null;
}

function startPositionTracking(): void {
  if (positionTimer !== null) return;
  updateOverlayPosition();
  positionTimer = window.setInterval(updateOverlayPosition, 500);
  window.addEventListener("resize", updateOverlayPosition);
  window.addEventListener("scroll", updateOverlayPosition, true);
  document.addEventListener("fullscreenchange", () => {
    attachOverlayToCurrentLayer();
    updateOverlayPosition();
  });
}

function attachOverlayToCurrentLayer(): void {
  if (!host) return;
  const fullscreenElement = document.fullscreenElement;
  const parent = fullscreenElement instanceof HTMLVideoElement ? document.documentElement : (fullscreenElement ?? document.documentElement);
  if (host.parentElement !== parent) parent.append(host);
  updateNativeCaptionVisibility();
}

function updateOverlayPosition(): void {
  if (!host) return;

  const video = host.dataset.visible === "true" ? activeCaptionVideo : findBestVideo();
  if (host.dataset.visible === "true" && !isUsableVideoTarget(video)) {
    expireCaptionDisplay();
    return;
  }

  if (!video) {
    host.style.setProperty("--rvt-left", "50%");
    host.style.setProperty("--rvt-bottom", "7vh");
    host.style.setProperty("--rvt-width", "min(760px, calc(100vw - 32px))");
    return;
  }

  const rect = video.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const safeGap = Math.max(18, Math.min(54, rect.height * 0.08));
  const bottom = Math.max(16, viewportHeight - Math.min(rect.bottom, viewportHeight) + safeGap);
  const left = Math.min(Math.max(rect.left + rect.width / 2, 16), viewportWidth - 16);
  const widthLimit = document.fullscreenElement ? viewportWidth * 0.7 : Math.min(viewportWidth * 0.7, 920);
  const width = Math.min(widthLimit, Math.max(320, Math.min(rect.width * 0.7, viewportWidth - 32)));

  host.style.setProperty("--rvt-left", `${left}px`);
  host.style.setProperty("--rvt-bottom", `${bottom}px`);
  host.style.setProperty("--rvt-width", `${width}px`);
}

function findBestVideo(): HTMLVideoElement | null {
  const videos = Array.from(document.querySelectorAll("video"));
  let best: { video: HTMLVideoElement; score: number } | null = null;

  for (const video of videos) {
    const rect = video.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 80) continue;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) continue;

    const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
    const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
    const visibleArea = Math.max(0, visibleWidth) * Math.max(0, visibleHeight);
    const playingScore = video.paused ? 0 : 1_000_000;
    const audibleScore = !video.muted && video.volume > 0 ? 100_000 : 0;
    const progressScore = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const score = playingScore + audibleScore + visibleArea + progressScore;

    if (!best || score > best.score) best = { video, score };
  }

  return best?.video ?? null;
}

function isUsableVideoTarget(video: HTMLVideoElement | null): video is HTMLVideoElement {
  if (!video || !document.documentElement.contains(video)) return false;
  const rect = video.getBoundingClientRect();
  if (rect.width < 120 || rect.height < 80) return false;
  if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) return false;
  return true;
}

function updateNativeCaptionTrack(caption: CaptionUpdate, display = getCommittedDisplayCaption()): void {
  if (!shouldUseNativeCaptionLayer()) {
    clearNativeCaptionTrack();
    return;
  }

  const video = activeCaptionVideo ?? findBestVideo();
  if (!video) return;

  const track = ensureNativeCaptionTrack(video);
  if (!track) return;

  clearTextTrack(track);
  const now = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  const duration = Number.isFinite(video.duration) ? video.duration : now + 3;
  const end = Math.min(duration, now + 6);
  const text = [display.sourceText, display.translatedText].filter(Boolean).join("\n");
  if (!text) return;

  const CueConstructor = window.VTTCue ?? window.TextTrackCue;
  if (!CueConstructor) return;

  const cue = new CueConstructor(now, Math.max(now + 0.5, end), text);
  if ("line" in cue) cue.line = -3;
  if ("align" in cue) cue.align = "center";
  if ("position" in cue) cue.position = 50;
  if ("size" in cue) cue.size = 70;
  track.addCue(cue);
  updateNativeCaptionVisibility();
}

function isSameCaptionEvolution(previousSource: string, currentSource: string): boolean {
  const previous = normalizeCaptionForCompare(previousSource);
  const current = normalizeCaptionForCompare(currentSource);
  if (!previous || !current) return false;
  if (previous === current) return true;
  const shorterLength = Math.min(previous.length, current.length);
  if (!current.includes(previous) && !previous.includes(current)) return false;
  return shorterLength >= 12;
}

function normalizeCaptionForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactCaptionText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;

  const parts = normalized
    .split(/(?<=[.!?。！？])\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  let selected = "";

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (!part) continue;
    const candidate = selected ? `${part} ${selected}` : part;
    if (candidate.length > maxChars && selected) break;
    selected = candidate;
    if (selected.length >= maxChars * 0.55) break;
  }

  if (selected && selected.length <= maxChars) return selected;
  return `...${normalized.slice(-maxChars)}`;
}

function scheduleStableCaptionCommit(caption: CaptionUpdate): void {
  const translatedText = caption.translatedText.trim();
  if (!translatedText) return;

  const hasCompleteSentence = hasSentenceBoundary(caption.sourceText) || hasSentenceBoundary(translatedText);
  const allowFragment = caption.isFinal || !hasCompleteSentence;
  const delayMs = caption.isFinal || hasCompleteSentence ? STABLE_CAPTION_FAST_COMMIT_MS : STABLE_CAPTION_FALLBACK_COMMIT_MS;

  pendingStableCaption = {
    caption: {
      ...caption,
      translatedText,
    },
    allowFragment,
  };
  stopStableCaptionTimer();
  if (caption.isFinal) {
    commitPendingStableCaption();
    return;
  }
  stableCaptionTimer = window.setTimeout(commitPendingStableCaption, delayMs);
}

function commitPendingStableCaption(): void {
  stableCaptionTimer = null;
  if (!pendingStableCaption) return;

  const { caption, allowFragment } = pendingStableCaption;
  pendingStableCaption = null;
  const sourceLine = extractStableSourceLine(caption.sourceText, allowFragment);
  if (!sourceLine.text) return;

  const sourceKey = normalizeCaptionForCompare(sourceLine.text);
  if (!sourceKey || hasCommittedCaptionSource(sourceKey)) return;

  const line = extractStableTranslatedLine(caption.translatedText, sourceLine, allowFragment);
  if (!line) return;

  const displayLines = splitSubtitleDisplayLines(line, STABLE_CAPTION_MAX_CHARS);
  if (displayLines.length === 0) return;

  committedCaptionLines = [...committedCaptionLines, ...displayLines].slice(-2);
  committedCaptionSourceKeys = [...committedCaptionSourceKeys, sourceKey].slice(-8);
  renderCommittedCaptionLines(caption);
}

function renderCommittedCaptionLines(caption = lastCaption): void {
  if (!sourceEl || !translationEl || !root) return;

  const display = getCommittedDisplayCaption();
  if (host) host.dataset.visible = display.sourceText || display.translatedText ? "true" : "false";
  sourceEl.textContent = display.sourceText;
  translationEl.textContent = display.translatedText;
  root.dataset.phase = "final";

  if (caption && (display.sourceText || display.translatedText)) {
    updateNativeCaptionTrack(caption, display);
    scheduleCaptionExpiry();
  }
}

function getCommittedDisplayCaption(): Pick<CaptionUpdate, "sourceText" | "translatedText"> {
  if (committedCaptionLines.length === 0) return { sourceText: "", translatedText: "" };
  if (committedCaptionLines.length === 1) return { sourceText: "", translatedText: committedCaptionLines[0] ?? "" };
  return {
    sourceText: committedCaptionLines[committedCaptionLines.length - 2] ?? "",
    translatedText: committedCaptionLines[committedCaptionLines.length - 1] ?? "",
  };
}

function getCompatibleStableTranslation(sourceText: string): string {
  if (!lastStableTranslation) return "";
  if (isSameCaptionEvolution(lastStableTranslation.sourceText, sourceText)) return lastStableTranslation.translatedText;
  return "";
}

function extractStableTranslatedLine(
  text: string,
  sourceLine: { index: number; isComplete: boolean },
  allowFragment: boolean,
): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (allowFragment) return normalized;

  const completeSentences = getCompleteSentences(normalized);
  if (completeSentences.length > 0) {
    return completeSentences[sourceLine.index] ?? completeSentences[completeSentences.length - 1] ?? "";
  }

  if (sourceLine.isComplete || allowFragment) return normalized;
  return "";
}

function extractStableSourceLine(
  text: string,
  allowFragment: boolean,
): { text: string; index: number; isComplete: boolean } {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return { text: "", index: -1, isComplete: false };
  if (allowFragment) return { text: normalized, index: 0, isComplete: true };

  const completeSentences = getCompleteSentences(normalized);
  if (completeSentences.length > 0) {
    const index = completeSentences.length - 1;
    return { text: completeSentences[index] ?? "", index, isComplete: true };
  }

  return allowFragment ? { text: normalized, index: 0, isComplete: false } : { text: "", index: -1, isComplete: false };
}

function hasCommittedCaptionSource(sourceKey: string): boolean {
  return committedCaptionSourceKeys.some((existingKey) => existingKey === sourceKey || isSameCaptionEvolution(existingKey, sourceKey));
}

function splitSubtitleDisplayLines(text: string, maxChars: number): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];

  const segments = normalized
    .split(/(?<=[，,。.!?！？；;：:])\s*/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const segment of segments.length > 0 ? segments : [normalized]) {
    if (segment.length > maxChars) {
      if (current) {
        lines.push(current);
        current = "";
      }
      lines.push(...splitLongSubtitleLine(segment, maxChars));
      continue;
    }

    const candidate = current ? `${current}${segment}` : segment;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if (current) lines.push(current);
    current = segment;
  }

  if (current) lines.push(current);
  return mergeShortSubtitleTails(lines, maxChars).filter(isMeaningfulSubtitleLine);
}

function splitLongSubtitleLine(text: string, maxChars: number): string[] {
  const normalized = text.trim();
  const lines: string[] = [];

  for (let index = 0; index < normalized.length; index += maxChars) {
    lines.push(normalized.slice(index, index + maxChars).trim());
  }

  return lines.filter(Boolean);
}

function mergeShortSubtitleTails(lines: string[], maxChars: number): string[] {
  const merged: string[] = [];

  for (const line of lines) {
    const previous = merged[merged.length - 1];
    if (previous && line.length < STABLE_CAPTION_MIN_CHARS && previous.length + line.length <= maxChars + STABLE_CAPTION_MIN_CHARS) {
      merged[merged.length - 1] = `${previous}${line}`;
      continue;
    }
    merged.push(line);
  }

  return merged;
}

function isMeaningfulSubtitleLine(line: string): boolean {
  const normalized = line.replace(/\s+/g, "").trim();
  if (!normalized) return false;
  if (normalized.length >= STABLE_CAPTION_MIN_CHARS) return true;
  return /[。.!?！？]$/u.test(normalized) && normalized.length >= 4;
}

function looksLikeBackendErrorText(text: string): boolean {
  return /timeout waiting next packet|server[_\s-]?error|火山\s*asr\s*错误|backend connection failed|后端连接失败|"\s*error\s*"\s*:/i.test(
    text,
  );
}

async function sendRuntimeMessageSafe<T>(message: RuntimeMessage): Promise<T | undefined> {
  try {
    if (!isExtensionRuntimeAvailable()) return undefined;
    return (await chrome.runtime.sendMessage(message)) as T;
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      markExtensionContextInvalidated();
      return undefined;
    }
    throw error;
  }
}

function handleUnhandledRejection(event: PromiseRejectionEvent): void {
  if (!isExtensionContextInvalidated(event.reason)) return;
  event.preventDefault();
  markExtensionContextInvalidated();
}

function isExtensionRuntimeAvailable(): boolean {
  if (extensionContextInvalidated) return false;
  try {
    return Boolean(chrome.runtime?.id);
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      markExtensionContextInvalidated();
      return false;
    }
    throw error;
  }
}

function markExtensionContextInvalidated(): void {
  if (extensionContextInvalidated) return;
  extensionContextInvalidated = true;
  stopStableCaptionTimer();
  stopCaptionExpiryTimer();
  if (videoResumeTimer !== null) {
    window.clearTimeout(videoResumeTimer);
    videoResumeTimer = null;
  }
  if (autoPageTranslationTimer !== null) {
    window.clearTimeout(autoPageTranslationTimer);
    autoPageTranslationTimer = null;
  }
  removeDomEventListeners();
}

function cleanupContentScript(): void {
  stopStableCaptionTimer();
  stopCaptionExpiryTimer();
  if (videoResumeTimer !== null) {
    window.clearTimeout(videoResumeTimer);
    videoResumeTimer = null;
  }
  if (autoPageTranslationTimer !== null) {
    window.clearTimeout(autoPageTranslationTimer);
    autoPageTranslationTimer = null;
  }
  if (positionTimer !== null) {
    window.clearInterval(positionTimer);
    positionTimer = null;
  }

  removeDomEventListeners();
  window.removeEventListener("unhandledrejection", handleUnhandledRejection);

  if (isExtensionRuntimeAvailable()) {
    chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
    chrome.storage.onChanged.removeListener(handleStorageChanged);
  }

  if (originalPushState) {
    history.pushState = originalPushState;
    originalPushState = null;
  }
  if (originalReplaceState) {
    history.replaceState = originalReplaceState;
    originalReplaceState = null;
  }

  if (rvtWindow.__rvtContentScriptCleanup === cleanupContentScript) {
    delete rvtWindow.__rvtContentScriptCleanup;
  }
}

function removeDomEventListeners(): void {
  document.removeEventListener("play", handleVideoResumeEvent, true);
  document.removeEventListener("playing", handleVideoResumeEvent, true);
  document.removeEventListener("pause", handleVideoPauseEvent, true);
  window.removeEventListener("focus", handlePageReturnedToForeground);
  document.removeEventListener("visibilitychange", handlePageReturnedToForeground);
  window.removeEventListener("pageshow", handlePageReturnedToForeground);
  window.removeEventListener("popstate", handlePageUrlMaybeChanged);
  window.removeEventListener("hashchange", handlePageUrlMaybeChanged);
  window.removeEventListener("pageshow", handleAutoPageShow);
  videoResumeWatchdogInstalled = false;
  autoPageTranslationWatchersInstalled = false;
}

function isExtensionContextInvalidated(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("Extension context invalidated") || message.includes("Extension context was invalidated");
}

function getCompleteSentences(text: string): string[] {
  return text
    .match(/[^.!?。！？]+[.!?。！？]+/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) ?? [];
}

function hasSentenceBoundary(text: string): boolean {
  return /[.!?。！？]/.test(text);
}

function ensureNativeCaptionTrack(video: HTMLVideoElement): TextTrack | null {
  if (nativeCaptionVideo === video && nativeCaptionTrack) return nativeCaptionTrack;

  nativeCaptionVideo = video;
  const trackElement = document.createElement("track");
  trackElement.kind = "captions";
  trackElement.label = "实时视频翻译";
  trackElement.srclang = "zh-CN";
  trackElement.default = true;
  trackElement.dataset.rvtNativeTrack = "true";
  video.append(trackElement);

  nativeCaptionTrack = trackElement.track;
  nativeCaptionTrack.mode = shouldUseNativeCaptionLayer() ? "showing" : "hidden";
  return nativeCaptionTrack;
}

function updateNativeCaptionVisibility(): void {
  if (!nativeCaptionTrack) return;
  nativeCaptionTrack.mode = shouldUseNativeCaptionLayer() ? "showing" : "hidden";
  if (lastCaption && shouldUseNativeCaptionLayer() && nativeCaptionTrack.cues?.length === 0) {
    updateNativeCaptionTrack(lastCaption);
  }
}

function shouldUseNativeCaptionLayer(): boolean {
  return document.fullscreenElement instanceof HTMLVideoElement;
}

function clearNativeCaptionTrack(): void {
  if (nativeCaptionTrack) clearTextTrack(nativeCaptionTrack);
}

function clearTextTrack(track: TextTrack): void {
  const cues = track.cues;
  if (!cues) return;
  for (let index = cues.length - 1; index >= 0; index -= 1) {
    const cue = cues[index];
    if (cue) track.removeCue(cue);
  }
}

async function translatePage(targetLanguage: string): Promise<number> {
  const runId = ++activePageTranslationRunId;
  restorePage();
  const candidates = collectTranslatableTextNodes();
  if (candidates.length === 0) return 0;

  const batches: Array<typeof candidates> = [];
  for (let index = 0; index < candidates.length; index += PAGE_TRANSLATION_BATCH_SIZE) {
    batches.push(candidates.slice(index, index + PAGE_TRANSLATION_BATCH_SIZE));
  }

  let nextBatchIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(PAGE_TRANSLATION_CONCURRENCY, batches.length) }, async () => {
      while (nextBatchIndex < batches.length) {
        const batch = batches[nextBatchIndex];
        nextBatchIndex += 1;
        if (!batch) continue;
        await translatePageBatch(batch, targetLanguage, runId);
      }
    }),
  );

  return translatedTextNodes.length;
}

async function translatePageBatch(
  batch: ReturnType<typeof collectTranslatableTextNodes>,
  targetLanguage: string,
  runId: number,
): Promise<void> {
  const response = await sendRuntimeMessageSafe<RuntimeResponse>({
    type: "page:translate:batch",
    texts: batch.map((item) => item.trimmed),
    targetLanguage,
  } satisfies RuntimeMessage);

  if (!response?.ok) throw new Error(response?.error ?? "网页翻译失败。");
  const translations = response.translations ?? [];

    batch.forEach((item, itemIndex) => {
      if (runId !== activePageTranslationRunId) return;
      const translated = translations[itemIndex];
      if (!translated) return;
      if (item.node.nodeValue !== item.original) return;
      translatedTextNodes.push({ node: item.node, original: item.original });
      item.node.nodeValue = `${item.leading}${translated}${item.trailing}`;
    });
}

function restorePage(): number {
  const restored = translatedTextNodes.length;
  for (const item of translatedTextNodes) {
    if (document.documentElement.contains(item.node)) item.node.nodeValue = item.original;
  }
  translatedTextNodes = [];
  return restored;
}

function collectTranslatableTextNodes(): Array<{
  node: Text;
  original: string;
  trimmed: string;
  leading: string;
  trailing: string;
}> {
  const nodes: Array<{
    node: Text;
    original: string;
    trimmed: string;
    leading: string;
    trailing: string;
  }> = [];

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (nodes.length >= PAGE_TRANSLATION_MAX_NODES) return NodeFilter.FILTER_REJECT;
      const text = node.nodeValue ?? "";
      const trimmed = text.trim();
      if (trimmed.length < 2 || !/[A-Za-z]/.test(trimmed)) return NodeFilter.FILTER_REJECT;
      if (trimmed.length > PAGE_TRANSLATION_MAX_NODE_CHARS) return NodeFilter.FILTER_REJECT;

      const parent = node.parentElement;
      if (!parent || shouldSkipTranslationElement(parent)) return NodeFilter.FILTER_REJECT;
      if (!isElementVisibleInTree(parent)) return NodeFilter.FILTER_REJECT;

      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let current = walker.nextNode();
  while (current && nodes.length < PAGE_TRANSLATION_MAX_NODES) {
    const node = current as Text;
    const original = node.nodeValue ?? "";
    const trimmed = original.trim();
    nodes.push({
      node,
      original,
      trimmed,
      leading: original.match(/^\s*/)?.[0] ?? "",
      trailing: original.match(/\s*$/)?.[0] ?? "",
    });
    current = walker.nextNode();
  }

  return nodes;
}

function shouldSkipTranslationElement(element: Element): boolean {
  if (element.closest(`#${ROOT_ID}`)) return true;
  if (element.closest("script, style, noscript, textarea, input, select, option, code, pre, kbd, samp, svg, canvas, iframe")) return true;
  if (element.closest("[contenteditable='true'], [contenteditable='']")) return true;
  if (element.closest("[aria-hidden='true'], [hidden]")) return true;
  return false;
}

function isElementVisibleInTree(element: HTMLElement): boolean {
  let current: HTMLElement | null = element;
  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    current = current.parentElement;
  }

  const rects = element.getClientRects();
  return rects.length > 0;
}

const SUBTITLE_STYLE = `
  :host {
    position: fixed !important;
    left: var(--rvt-left, 50%) !important;
    bottom: var(--rvt-bottom, 7vh) !important;
    z-index: 2147483647 !important;
    width: var(--rvt-width, min(760px, calc(100vw - 32px))) !important;
    transform: translateX(-50%) !important;
    box-sizing: border-box !important;
    pointer-events: none !important;
    opacity: 0 !important;
    transition:
      opacity 160ms ease,
      transform 160ms ease !important;
  }

  :host([data-visible="true"]) {
    opacity: 1 !important;
    transform: translateX(-50%) translateY(0) !important;
  }

  .rvt-subtitle-panel {
    box-sizing: border-box;
    width: 100%;
    padding: 0 8px;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: #f8fafc;
    box-shadow: none;
    font-family:
      Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    backdrop-filter: none;
  }

  .rvt-subtitle-header {
    display: none;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 6px;
    color: rgba(226, 232, 240, 0.8);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  .rvt-subtitle-status {
    color: #67e8f9;
    text-transform: none;
  }

  .rvt-subtitle-body {
    display: grid;
    gap: 6px;
  }

  .rvt-subtitle-source,
  .rvt-subtitle-translation {
    margin: 0;
    overflow-wrap: anywhere;
    text-align: center;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .rvt-subtitle-source {
    color: rgba(226, 232, 240, 0.86);
    font-size: clamp(18px, 1.65vw, 28px);
    font-weight: 650;
    line-height: 1.28;
    text-shadow:
      0 1px 2px rgba(0, 0, 0, 0.85),
      0 0 5px rgba(0, 0, 0, 0.65);
    -webkit-line-clamp: 1;
  }

  .rvt-subtitle-translation {
    color: #ffffff;
    font-size: clamp(21px, 2.15vw, 36px);
    font-weight: 750;
    line-height: 1.22;
    text-shadow:
      0 2px 3px rgba(0, 0, 0, 0.9),
      0 0 8px rgba(0, 0, 0, 0.72);
    -webkit-line-clamp: 2;
  }

  .rvt-subtitle-panel[data-phase="interim"] .rvt-subtitle-translation {
    color: #dbeafe;
  }

  @media (max-width: 640px) {
    :host {
      bottom: 16px !important;
      width: calc(100vw - 20px) !important;
    }

    .rvt-subtitle-panel {
      padding: 0 6px;
    }

    .rvt-subtitle-header {
      font-size: 10px;
    }
  }
`;

ensureOverlay();
