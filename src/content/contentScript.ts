import type { CaptionUpdate, PageTranslateProgress, RuntimeMessage, RuntimeResponse, StreamMode, SubtitleStyle, TranslatorSettings } from "../types";

const ROOT_ID = "rvt-subtitle-root";
const SELECTION_ROOT_ID = "rvt-selection-translation-root";
const NATIVE_CUE_STYLE_ID = "rvt-native-cue-style";
const PAGE_TRANSLATION_BATCH_SIZE = 20;
const PAGE_TRANSLATION_CONCURRENCY = 4;
const PAGE_TRANSLATION_MAX_NODES = 1_500;
const PAGE_TRANSLATION_MAX_NODE_CHARS = 1_800;
const DYNAMIC_PAGE_TRANSLATION_DELAY_MS = 800;
const TRANSLATED_NODE_HISTORY_LIMIT = 8_000;
const STABLE_CAPTION_MAX_CHARS = 24;
const STABLE_CAPTION_MIN_CHARS = 6;
const STABLE_CAPTION_FAST_COMMIT_MS = 650;
const STABLE_CAPTION_FALLBACK_COMMIT_MS = 2_400;
const CAPTION_STALE_MS = 12_000;
const VIDEO_RESUME_GRACE_MS = 2_800;
const VIDEO_RESUME_RESTART_THROTTLE_MS = 8_000;
const VIDEO_RESUME_FORCE_RESTART_THROTTLE_MS = 1_500;
const VIDEO_RESUME_FORCE_RESTART_DELAY_MS = 350;
const SELECTION_TRANSLATION_MAX_CHARS = 1_200;

type RvtWindow = Window & {
  __rvtContentScriptCleanup?: () => void;
};

type CommittedCaption = {
  sourceText: string;
  translatedText: string;
  translationLines: string[];
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _unused_CommittedCaption = 0;

const rvtWindow = window as RvtWindow;
const IS_TOP_FRAME = window.top === window;
try {
  rvtWindow.__rvtContentScriptCleanup?.();
} catch {
  // A previous content script may belong to an invalidated extension context.
}

document.getElementById(ROOT_ID)?.remove();
document.getElementById(SELECTION_ROOT_ID)?.remove();

let host: HTMLElement | null = null;
let root: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let sourceEl: HTMLElement | null = null;
let translationEl: HTMLElement | null = null;
let selectionHost: HTMLElement | null = null;
let selectionRoot: HTMLElement | null = null;
let selectionPreviewEl: HTMLElement | null = null;
let selectionResultEl: HTMLElement | null = null;
let selectionButton: HTMLButtonElement | null = null;
let selectionCloseButton: HTMLButtonElement | null = null;
let positionTimer: number | null = null;
let captionExpiryTimer: number | null = null;
let selectionCheckTimer: number | null = null;
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
let selectionTranslationEnabled = false;
let selectionTranslationTargetLanguage = "zh-CN";
let subtitleStyle: SubtitleStyle = "bold";
let showOriginal = false;
let showTranslation = true;
let autoPageTranslationTimer: number | null = null;
let autoTriggeredTranslateRunning = false;
let pageTranslationObserver: MutationObserver | null = null;
let observedPageUrl = location.href;
let activePageTranslationRunId = 0;
let autoPageTranslationWatchersInstalled = false;
let selectionTranslationWatchersInstalled = false;
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
let selectedTextForTranslation = "";
let selectionTranslationRequestId = 0;

rvtWindow.__rvtContentScriptCleanup = cleanupContentScript;
void initAutoPageTranslation();
if (IS_TOP_FRAME) installSelectionTranslationWatchers();
if (IS_TOP_FRAME) installVideoResumeWatchdog();
window.addEventListener("unhandledrejection", handleUnhandledRejection);

if (isExtensionRuntimeAvailable()) {
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
}

function handleRuntimeMessage(message: RuntimeMessage, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void): boolean {
  if (!isExtensionRuntimeAvailable()) return false;
  if (message.type === "caption:update") {
    if (IS_TOP_FRAME) renderCaption(message.caption);
  }

  if (message.type === "caption:clear") {
    if (IS_TOP_FRAME) clearCaptionDisplay();
  }

  if (message.type === "caption:state") {
    if (!IS_TOP_FRAME) return false;
    if (message.running) {
      ensureOverlay();
      setStatus(true, message.mode);
    } else if (host) {
      translatorSuspendedByVideoPause = false;
      clearCaptionDisplay();
    }
  }

  if (message.type === "page:translate") {
    const runId = ++activePageTranslationRunId;
    sendResponse({ ok: true, translated: 0, inProgress: true, runId });
    void translatePage(message.targetLanguage ?? "zh-CN")
      .then((translated) => {
        if (runId !== activePageTranslationRunId) return;
        void chrome.runtime
          .sendMessage({
            type: "page:translate:done",
            runId,
            translated,
          } satisfies RuntimeMessage)
          .catch(() => undefined);
      })
      .catch((error: unknown) => {
        if (runId !== activePageTranslationRunId) return;
        void chrome.runtime
          .sendMessage({
            type: "page:translate:done",
            runId,
            translated: 0,
            error: error instanceof Error ? error.message : String(error),
          } satisfies RuntimeMessage)
          .catch(() => undefined);
      });
    return false;
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
  if (!response?.ok || !response.settings) {
    // Settings fetch failed — apply safe defaults so features stay off.
    console.warn("[hear-me-out] settings fetch failed, applying defaults");
    updateSettingsState({});
    return;
  }

  console.log("[hear-me-out] init settings:", JSON.stringify({
    autoTranslatePages: response.settings.autoTranslatePages,
    selectionTranslationEnabled: response.settings.selectionTranslationEnabled,
  }));
  updateSettingsState(response.settings);
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
  if ((areaName !== "local" && areaName !== "sync") || !changes.settings?.newValue) return;
  const newSettings = changes.settings.newValue as Record<string, unknown>;
  console.log("[hear-me-out] storage changed:", JSON.stringify({
    autoTranslatePages: newSettings.autoTranslatePages,
    selectionTranslationEnabled: newSettings.selectionTranslationEnabled,
  }));
  updateSettingsState(newSettings as unknown as Partial<TranslatorSettings>);
}

function updateSettingsState(settings: Partial<TranslatorSettings>): void {
  updateAutoPageTranslationState(Boolean(settings.autoTranslatePages), settings.targetLanguage ?? "zh-CN");
  updateSelectionTranslationState(settings.selectionTranslationEnabled !== false, settings.targetLanguage ?? "zh-CN");
  updateSubtitleStyle(settings.subtitleStyle);
  updateSubtitleDisplayMode(settings);
}

function updateSelectionTranslationState(enabled: boolean, targetLanguage: string): void {
  selectionTranslationEnabled = enabled;
  selectionTranslationTargetLanguage = targetLanguage || "zh-CN";

  if (enabled) {
    installSelectionTranslationWatchers();
    scheduleSelectionTranslatorCheck(120);
    return;
  }

  hideSelectionTranslator();
}

function updateSubtitleStyle(nextStyle?: SubtitleStyle): void {
  subtitleStyle = nextStyle ?? "bold";
  if (root) root.dataset.style = subtitleStyle;
}

function updateSubtitleDisplayMode(settings: Partial<TranslatorSettings>): void {
  showOriginal = Boolean(settings.showOriginal);
  showTranslation = settings.showTranslation !== false;
  if (root) root.dataset.mode = showOriginal && showTranslation ? "bilingual" : "translation";
  renderCommittedCaptionLines();
}

function handleAutoPageShow(): void {
  scheduleAutoPageTranslation(500);
}

function updateAutoPageTranslationState(enabled: boolean, targetLanguage: string): void {
  autoPageTranslationEnabled = enabled;
  autoPageTranslationTargetLanguage = targetLanguage || "zh-CN";

  if (enabled) {
    startPageTranslationObserver();
    scheduleAutoPageTranslation(700);
    return;
  }

  stopPageTranslationObserver();
  if (autoPageTranslationTimer !== null) {
    window.clearTimeout(autoPageTranslationTimer);
    autoPageTranslationTimer = null;
  }
  // Bump the run id BEFORE restoring so any batch that resolves right
  // after the user flipped the switch off can no longer overwrite the
  // restored text. restorePage() also bumps it, but doing it here too
  // covers the (very short) window where restorePage has not run yet.
  activePageTranslationRunId += 1;
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
    autoTriggeredTranslateRunning = true;
    void translatePage(autoPageTranslationTargetLanguage)
      .catch(() => undefined)
      .finally(() => {
        autoTriggeredTranslateRunning = false;
      });
  }, delayMs);
}

function startPageTranslationObserver(): void {
  if (pageTranslationObserver || !document.body) return;
  pageTranslationObserver = new MutationObserver((mutations) => {
    if (!autoPageTranslationEnabled || pageTranslationObserverSuspended) {
      pageTranslationObserver?.takeRecords();
      return;
    }
    if (!mutations.some(containsNewTranslatableText)) return;
    scheduleAutoPageTranslation(DYNAMIC_PAGE_TRANSLATION_DELAY_MS);
  });
  pageTranslationObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

function stopPageTranslationObserver(): void {
  pageTranslationObserver?.disconnect();
  pageTranslationObserver = null;
}

let pageTranslationObserverSuspended = false;

function pausePageTranslationObserver(): void {
  if (!pageTranslationObserver) return;
  pageTranslationObserverSuspended = true;
  pageTranslationObserver.takeRecords();
}

function resumePageTranslationObserver(): void {
  pageTranslationObserverSuspended = false;
}

function containsNewTranslatableText(mutation: MutationRecord): boolean {
  if (mutation.type === "characterData") {
    return isTranslatableTextNode(mutation.target);
  }

  for (const node of mutation.addedNodes) {
    if (isTranslatableTextNode(node)) return true;
    if (node instanceof Element && elementContainsTranslatableText(node)) return true;
  }

  return false;
}

function elementContainsTranslatableText(element: Element): boolean {
  if (shouldSkipTranslationElement(element)) return false;
  const text = (element.textContent ?? "").trim();
  return text.length > 1;
}

function isTranslatableTextNode(node: Node): boolean {
  if (node.nodeType !== Node.TEXT_NODE) return false;
  const text = node.nodeValue ?? "";
  if (text.trim().length < 2) return false;
  const parent = node.parentElement;
  return Boolean(parent && !shouldSkipTranslationElement(parent));
}

function installSelectionTranslationWatchers(): void {
  if (selectionTranslationWatchersInstalled) return;
  if (!isExtensionRuntimeAvailable()) return;
  selectionTranslationWatchersInstalled = true;

  document.addEventListener("selectionchange", handleSelectionChange);
  document.addEventListener("mouseup", handleSelectionGestureComplete, true);
  document.addEventListener("keyup", handleSelectionGestureComplete, true);
  document.addEventListener("mousedown", handleSelectionOutsideMouseDown, true);
  window.addEventListener("scroll", handleSelectionViewportChanged, true);
  window.addEventListener("resize", handleSelectionViewportChanged);
}

function handleSelectionChange(): void {
  scheduleSelectionTranslatorCheck(120);
}

function handleSelectionGestureComplete(event: Event): void {
  if (!selectionTranslationEnabled) return;
  if (isSelectionTranslatorEvent(event)) return;
  scheduleSelectionTranslatorCheck(70);
}

function handleSelectionOutsideMouseDown(event: MouseEvent): void {
  if (!selectionHost || selectionHost.dataset.visible !== "true") return;
  if (isSelectionTranslatorEvent(event)) return;
  hideSelectionTranslator();
}

function handleSelectionViewportChanged(): void {
  if (!selectionHost || selectionHost.dataset.visible !== "true") return;
  const info = getCurrentSelectionInfo();
  if (!info || info.text !== selectedTextForTranslation) {
    hideSelectionTranslator();
    return;
  }
  positionSelectionTranslator(info.rect);
}

function scheduleSelectionTranslatorCheck(delayMs: number): void {
  if (!selectionTranslationEnabled || !isExtensionRuntimeAvailable()) return;
  if (selectionCheckTimer !== null) window.clearTimeout(selectionCheckTimer);
  selectionCheckTimer = window.setTimeout(() => {
    selectionCheckTimer = null;
    showTranslatorForCurrentSelection();
  }, delayMs);
}

function showTranslatorForCurrentSelection(): void {
  if (!selectionTranslationEnabled || !isExtensionRuntimeAvailable()) {
    hideSelectionTranslator();
    return;
  }

  const info = getCurrentSelectionInfo();
  if (!info) {
    hideSelectionTranslator();
    return;
  }

  ensureSelectionTranslator();
  if (!selectionHost || !selectionRoot || !selectionPreviewEl || !selectionResultEl || !selectionButton) return;

  selectedTextForTranslation = info.text;
  selectionTranslationRequestId += 1;
  selectionPreviewEl.textContent = compactSelectionPreview(info.text);
  selectionResultEl.textContent = "";
  selectionRoot.dataset.state = "ready";
  selectionHost.dataset.visible = "true";
  selectionButton.disabled = false;
  selectionButton.textContent = "翻译";
  positionSelectionTranslator(info.rect);
}

function getCurrentSelectionInfo(): { text: string; rect: DOMRect } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

  const text = normalizeSelectionText(selection.toString());
  if (!text || text.length > SELECTION_TRANSLATION_MAX_CHARS) return null;

  const range = selection.getRangeAt(0);
  const container = getSelectionContainerElement(range);
  if (!container || shouldSkipSelectionElement(container)) return null;

  const rect = getSelectionRangeRect(range);
  if (!rect) return null;

  return { text, rect };
}

function normalizeSelectionText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function compactSelectionPreview(text: string): string {
  const normalized = normalizeSelectionText(text);
  if (normalized.length <= 80) return normalized;
  return `${normalized.slice(0, 78)}...`;
}

function getSelectionContainerElement(range: Range): Element | null {
  const container = range.commonAncestorContainer;
  if (container instanceof Element) return container;
  return container.parentElement;
}

function getSelectionRangeRect(range: Range): DOMRect | null {
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
  if (rects.length > 0) return rects[rects.length - 1] ?? null;

  const rect = range.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) return rect;
  return null;
}

function shouldSkipSelectionElement(element: Element): boolean {
  if (element.closest(`#${ROOT_ID}, #${SELECTION_ROOT_ID}`)) return true;
  return shouldSkipTranslationElement(element);
}

function ensureSelectionTranslator(): void {
  if (selectionHost && document.documentElement.contains(selectionHost)) return;

  selectionHost = document.createElement("div");
  selectionHost.id = SELECTION_ROOT_ID;
  selectionHost.dataset.visible = "false";
  const shadow = selectionHost.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = SELECTION_TRANSLATOR_STYLE;

  selectionRoot = document.createElement("section");
  selectionRoot.className = "rvt-selection-panel";
  selectionRoot.dataset.state = "ready";

  const header = document.createElement("div");
  header.className = "rvt-selection-header";

  selectionButton = document.createElement("button");
  selectionButton.type = "button";
  selectionButton.className = "rvt-selection-action";
  selectionButton.textContent = "翻译";
  selectionButton.addEventListener("mousedown", (event) => event.preventDefault());
  selectionButton.addEventListener("click", () => {
    void translateSelectedText();
  });

  selectionCloseButton = document.createElement("button");
  selectionCloseButton.type = "button";
  selectionCloseButton.className = "rvt-selection-close";
  selectionCloseButton.textContent = "×";
  selectionCloseButton.title = "关闭";
  selectionCloseButton.addEventListener("mousedown", (event) => event.preventDefault());
  selectionCloseButton.addEventListener("click", hideSelectionTranslator);

  header.append(selectionButton, selectionCloseButton);

  selectionPreviewEl = document.createElement("p");
  selectionPreviewEl.className = "rvt-selection-source";

  selectionResultEl = document.createElement("p");
  selectionResultEl.className = "rvt-selection-result";

  selectionRoot.append(header, selectionPreviewEl, selectionResultEl);
  shadow.append(style, selectionRoot);
  document.documentElement.append(selectionHost);
}

function positionSelectionTranslator(rect: DOMRect): void {
  if (!selectionHost) return;
  const margin = 12;
  const left = Math.min(Math.max(rect.left + rect.width / 2, margin), window.innerWidth - margin);
  const shouldPlaceAbove = rect.bottom + 160 > window.innerHeight && rect.top > 160;
  const top = shouldPlaceAbove ? Math.max(margin, rect.top - 8) : Math.min(window.innerHeight - margin, rect.bottom + 8);

  selectionHost.dataset.placement = shouldPlaceAbove ? "top" : "bottom";
  selectionHost.style.setProperty("--rvt-selection-left", `${left}px`);
  selectionHost.style.setProperty("--rvt-selection-top", `${top}px`);
}

async function translateSelectedText(): Promise<void> {
  if (!selectedTextForTranslation || !selectionRoot || !selectionResultEl || !selectionButton) return;
  const requestId = ++selectionTranslationRequestId;
  const text = selectedTextForTranslation;

  selectionRoot.dataset.state = "loading";
  selectionButton.disabled = true;
  selectionButton.textContent = "翻译中";
  selectionResultEl.textContent = "正在翻译...";

  try {
    const response = await sendRuntimeMessageSafe<RuntimeResponse>({
      type: "page:translate:batch",
      texts: [text],
      targetLanguage: selectionTranslationTargetLanguage,
    } satisfies RuntimeMessage);
    if (requestId !== selectionTranslationRequestId) return;

    if (!response?.ok) {
      selectionRoot.dataset.state = "error";
      selectionResultEl.textContent = response?.error ?? "划词翻译失败，请检查后端。";
      return;
    }

    selectionRoot.dataset.state = "done";
    selectionResultEl.textContent = response.translations?.[0]?.trim() || "没有返回译文。";
  } catch (error) {
    if (requestId !== selectionTranslationRequestId) return;
    selectionRoot.dataset.state = "error";
    selectionResultEl.textContent = error instanceof Error ? error.message : "划词翻译失败。";
  } finally {
    if (requestId === selectionTranslationRequestId && selectionButton) {
      selectionButton.disabled = false;
      selectionButton.textContent = "重试";
    }
  }
}

function hideSelectionTranslator(): void {
  if (selectionCheckTimer !== null) {
    window.clearTimeout(selectionCheckTimer);
    selectionCheckTimer = null;
  }
  selectedTextForTranslation = "";
  selectionTranslationRequestId += 1;
  if (selectionHost) selectionHost.dataset.visible = "false";
  if (selectionRoot) selectionRoot.dataset.state = "ready";
  if (selectionPreviewEl) selectionPreviewEl.textContent = "";
  if (selectionResultEl) selectionResultEl.textContent = "";
  if (selectionButton) {
    selectionButton.disabled = false;
    selectionButton.textContent = "翻译";
  }
}

function isSelectionTranslatorEvent(event: Event): boolean {
  if (!selectionHost) return false;
  return event.composedPath().includes(selectionHost);
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
    const response = await sendRuntimeMessageSafe<RuntimeResponse>({ type: "translator:resume" } satisfies RuntimeMessage);
    if (response?.ok && response.running) {
      translatorSuspendedByVideoPause = false;
      lastVideoResumeRestartAt = Date.now();
      scheduleVideoResumeHealthCheck(false);
      return;
    }

    translatorSuspendedByVideoPause = true;
    lastVideoResumeRestartAt = 0;
    scheduleVideoResumeHealthCheck(true);
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
  root.dataset.style = subtitleStyle;
  root.dataset.mode = showOriginal && showTranslation ? "bilingual" : "translation";

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
  const widthLimit = document.fullscreenElement ? viewportWidth * 0.86 : Math.min(viewportWidth * 0.82, 1080);
  const width = Math.min(widthLimit, Math.max(360, Math.min(rect.width * 0.82, viewportWidth - 24)));

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
  if (current.includes(previous)) return false;
  if (!previous.includes(current)) return false;
  return current.length >= 12;
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
  sourceEl.toggleAttribute("hidden", !display.sourceText);
  translationEl.toggleAttribute("hidden", !display.translatedText);
  root.dataset.phase = "final";

  if (caption && (display.sourceText || display.translatedText)) {
    updateNativeCaptionTrack(caption, display);
    scheduleCaptionExpiry();
  }
}

function getCommittedDisplayCaption(): Pick<CaptionUpdate, "sourceText" | "translatedText"> {
  if (committedCaptionLines.length === 0) return { sourceText: "", translatedText: "" };
  if (committedCaptionLines.length === 1) {
    return { sourceText: "", translatedText: committedCaptionLines[0] ?? "" };
  }
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
  return mergeShortSubtitleTails(lines, maxChars)
    .map(normalizeSubtitleDisplayLine)
    .filter(isMeaningfulSubtitleLine);
}

function normalizeSubtitleDisplayLine(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[。.]+([）)\]】」』”"']*)$/u, "$1")
    .trim();
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
  if (selectionCheckTimer !== null) {
    window.clearTimeout(selectionCheckTimer);
    selectionCheckTimer = null;
  }
  hideSelectionTranslator();
  stopPageTranslationObserver();
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
  if (selectionCheckTimer !== null) {
    window.clearTimeout(selectionCheckTimer);
    selectionCheckTimer = null;
  }
  stopPageTranslationObserver();
  if (positionTimer !== null) {
    window.clearInterval(positionTimer);
    positionTimer = null;
  }
  selectionHost?.remove();
  selectionHost = null;
  selectionRoot = null;
  selectionPreviewEl = null;
  selectionResultEl = null;
  selectionButton = null;
  selectionCloseButton = null;

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
  document.removeEventListener("selectionchange", handleSelectionChange);
  document.removeEventListener("mouseup", handleSelectionGestureComplete, true);
  document.removeEventListener("keyup", handleSelectionGestureComplete, true);
  document.removeEventListener("mousedown", handleSelectionOutsideMouseDown, true);
  window.removeEventListener("scroll", handleSelectionViewportChanged, true);
  window.removeEventListener("resize", handleSelectionViewportChanged);
  videoResumeWatchdogInstalled = false;
  autoPageTranslationWatchersInstalled = false;
  selectionTranslationWatchersInstalled = false;
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

/**
 * Reorder candidates so nodes that share a parent element stay adjacent,
 * then return a single flat array. The TreeWalker already visits the DOM
 * roughly in document order, so siblings are usually consecutive anyway —
 * this just guarantees it. Downstream we slice the flat list into fixed-size
 * translation batches, which keeps sibling context inside each batch
 * without spawning one API call per parent element.
 */
function groupCandidatesByParentFlat(
  candidates: ReturnType<typeof collectTranslatableTextNodes>,
): ReturnType<typeof collectTranslatableTextNodes> {
  // The walker yields nodes in document order; siblings sharing a parent
  // are already adjacent. Stable sort by parent keeps that property while
  // being a no-op in the common case, so batches never split a paragraph
  // across two API requests unless the paragraph itself overflows a batch.
  const byParent = new Map<Element, ReturnType<typeof collectTranslatableTextNodes>>();
  for (const item of candidates) {
    const parent = item.node.parentElement;
    if (!parent) continue;
    const bucket = byParent.get(parent);
    if (bucket) bucket.push(item);
    else byParent.set(parent, [item]);
  }

  // Re-emit in the original first-seen order of each parent so the page
  // still translates top-to-bottom, which also matches how the user reads.
  const seenParents: Element[] = [];
  const seen = new Set<Element>();
  for (const item of candidates) {
    const parent = item.node.parentElement;
    if (parent && !seen.has(parent)) {
      seen.add(parent);
      seenParents.push(parent);
    }
  }

  const flat: ReturnType<typeof collectTranslatableTextNodes> = [];
  for (const parent of seenParents) {
    const bucket = byParent.get(parent);
    if (bucket) flat.push(...bucket);
  }
  return flat;
}

async function translatePage(targetLanguage: string): Promise<number> {
  const runId = ++activePageTranslationRunId;
  pruneTranslatedTextNodes();
  let candidates = collectTranslatableTextNodes();

  // Don't restore page for auto-triggered re-translations — that would
  // flash the page back to original text before re-translating.
  if (candidates.length === 0 && translatedTextNodes.length > 0) {
    if (autoTriggeredTranslateRunning) return 0;
    restorePage();
    candidates = collectTranslatableTextNodes();
  }
  if (candidates.length === 0) return 0;

  // Keep nodes that share a parent together so each batch still carries
  // sibling context for the model, then slice the ordered list into
  // fixed-size batches. This collapses "one API call per parent element"
  // (which could be hundreds of round-trips) into a small number of big
  // batches — the single biggest reason page translation used to be slow.
  const ordered = groupCandidatesByParentFlat(candidates);
  const batches: Array<ReturnType<typeof collectTranslatableTextNodes>> = [];
  for (let index = 0; index < ordered.length; index += PAGE_TRANSLATION_BATCH_SIZE) {
    batches.push(ordered.slice(index, index + PAGE_TRANSLATION_BATCH_SIZE));
  }
  const totalBatches = batches.length;
  let completedBatches = 0;
  let nextBatchIndex = 0;

  await Promise.all(
    Array.from({ length: Math.min(PAGE_TRANSLATION_CONCURRENCY, batches.length) }, async () => {
      while (nextBatchIndex < batches.length) {
        const batch = batches[nextBatchIndex];
        nextBatchIndex += 1;
        if (!batch || batch.length === 0) continue;
        await translatePageBatch(batch, targetLanguage, runId);
        completedBatches += 1;
        void chrome.runtime
          .sendMessage({
            type: "page:translate:progress",
            runId,
            translated: translatedTextNodes.length,
            total: candidates.length,
            batchIndex: completedBatches,
            totalBatches,
          } satisfies PageTranslateProgress)
          .catch(() => undefined);
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
  const texts = batch.map((item) => item.trimmed);

  const response = await sendRuntimeMessageSafe<RuntimeResponse>({
    type: "page:translate:batch",
    texts,
    targetLanguage,
  } satisfies RuntimeMessage);

  if (!response?.ok) throw new Error(response?.error ?? "网页翻译失败。");
  const translations = response.translations ?? [];

  batch.forEach((item, itemIndex) => {
    if (runId !== activePageTranslationRunId) return;
    const translated = translations[itemIndex];
    if (item.node.nodeValue !== item.original) return;
    if (isTranslatedTextNode(item.node)) return;
    const finalText = translated || item.trimmed;
    if (!finalText.trim()) return;
    translatedTextNodes.push({ node: item.node, original: item.original });
    if (translatedTextNodes.length > TRANSLATED_NODE_HISTORY_LIMIT) {
      translatedTextNodes = translatedTextNodes.slice(-TRANSLATED_NODE_HISTORY_LIMIT);
    }
    pausePageTranslationObserver();
    try {
      item.node.nodeValue = `${item.leading}${finalText}${item.trailing}`;
    } finally {
      resumePageTranslationObserver();
    }
  });
}

function restorePage(): number {
  // Bump the run id so any in-flight translation batches (or auto-translate
  // timers that fire mid-restore) become stale and bail out in their
  // runId check, instead of stomping the freshly restored DOM nodes.
  activePageTranslationRunId += 1;
  const restored = translatedTextNodes.length;
  pausePageTranslationObserver();
  try {
    for (const item of translatedTextNodes) {
      if (document.documentElement.contains(item.node)) item.node.nodeValue = item.original;
    }
  } finally {
    resumePageTranslationObserver();
  }
  translatedTextNodes = [];
  clearSkipElementCache();
  return restored;
}

function pruneTranslatedTextNodes(): void {
  translatedTextNodes = translatedTextNodes.filter((item) => document.documentElement.contains(item.node));
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
      const text = node.nodeValue ?? "";
      const trimmed = text.trim();
      if (trimmed.length < 2 || !/[A-Za-z]/.test(trimmed)) return NodeFilter.FILTER_REJECT;
      if (trimmed.length > PAGE_TRANSLATION_MAX_NODE_CHARS) return NodeFilter.FILTER_REJECT;

      const parent = node.parentElement;
      if (!parent || shouldSkipTranslationElement(parent)) return NodeFilter.FILTER_REJECT;
      if (isTranslatedTextNode(node as Text)) return NodeFilter.FILTER_REJECT;

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

function isTranslatedTextNode(node: Text): boolean {
  return translatedTextNodes.some((item) => item.node === node);
}

const skipElementCache = new WeakMap<Element, boolean>();

function shouldSkipTranslationElement(element: Element): boolean {
  const cached = skipElementCache.get(element);
  if (cached !== undefined) return cached;

  if (element.closest(`#${ROOT_ID}, #${SELECTION_ROOT_ID}`)) { skipElementCache.set(element, true); return true; }
  if (element.closest("script, style, noscript, textarea, input, select, option, code, pre, kbd, samp, svg, canvas, iframe")) { skipElementCache.set(element, true); return true; }
  if (element.closest("[contenteditable='true'], [contenteditable='']")) { skipElementCache.set(element, true); return true; }
  if (element.closest("[aria-hidden='true'], [hidden]")) { skipElementCache.set(element, true); return true; }
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") { skipElementCache.set(element, true); return true; }
  if (element.getClientRects().length === 0) { skipElementCache.set(element, true); return true; }
  skipElementCache.set(element, false);
  return false;
}

function clearSkipElementCache(): void {
  (skipElementCache as unknown as { clear?: () => void }).clear?.();
}

const SELECTION_TRANSLATOR_STYLE = `
  :host {
    position: fixed !important;
    left: var(--rvt-selection-left, 50%) !important;
    top: var(--rvt-selection-top, 0) !important;
    z-index: 2147483647 !important;
    width: min(360px, calc(100vw - 24px)) !important;
    transform: translateX(-50%) !important;
    pointer-events: none !important;
    opacity: 0 !important;
    transition:
      opacity 120ms ease,
      transform 120ms ease !important;
  }

  :host([data-visible="true"]) {
    opacity: 1 !important;
  }

  :host([data-placement="top"]) {
    transform: translateX(-50%) translateY(-100%) !important;
  }

  .rvt-selection-panel {
    box-sizing: border-box;
    display: grid;
    gap: 8px;
    width: 100%;
    max-height: min(320px, calc(100vh - 24px));
    overflow: auto;
    padding: 10px;
    border: 1px solid rgba(148, 163, 184, 0.35);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.98);
    color: #111827;
    box-shadow: 0 12px 30px rgba(15, 23, 42, 0.22);
    font-family:
      Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    pointer-events: auto;
  }

  .rvt-selection-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .rvt-selection-action,
  .rvt-selection-close {
    appearance: none;
    border: 0;
    border-radius: 6px;
    font: inherit;
    cursor: pointer;
  }

  .rvt-selection-action {
    min-height: 28px;
    padding: 0 12px;
    background: #111827;
    color: #ffffff;
    font-size: 12px;
    font-weight: 750;
  }

  .rvt-selection-action:disabled {
    cursor: default;
    opacity: 0.72;
  }

  .rvt-selection-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    background: #f3f4f6;
    color: #4b5563;
    font-size: 16px;
    line-height: 1;
  }

  .rvt-selection-source,
  .rvt-selection-result {
    margin: 0;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    line-height: 1.45;
  }

  .rvt-selection-source {
    color: #6b7280;
    font-size: 12px;
  }

  .rvt-selection-result {
    color: #111827;
    font-size: 14px;
    font-weight: 650;
  }

  .rvt-selection-panel[data-state="ready"] .rvt-selection-result:empty {
    display: none;
  }

  .rvt-selection-panel[data-state="loading"] .rvt-selection-result {
    color: #2563eb;
  }

  .rvt-selection-panel[data-state="error"] .rvt-selection-result {
    color: #dc2626;
  }
`;

const SUBTITLE_STYLE = `
  :host {
    position: fixed !important;
    left: var(--rvt-left, 50%) !important;
    bottom: var(--rvt-bottom, 7vh) !important;
    z-index: 2147483647 !important;
    width: var(--rvt-width, min(900px, calc(100vw - 24px))) !important;
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
    white-space: pre-line;
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
    font-size: clamp(22px, 1.9vw, 32px);
    font-weight: 750;
    line-height: 1.22;
    text-shadow:
      0 2px 3px rgba(0, 0, 0, 0.9),
      0 0 8px rgba(0, 0, 0, 0.72);
    -webkit-line-clamp: 2;
  }

  .rvt-subtitle-source[hidden],
  .rvt-subtitle-translation[hidden] {
    display: none !important;
  }

  .rvt-subtitle-panel[data-mode="bilingual"] .rvt-subtitle-body {
    gap: 4px;
  }

  .rvt-subtitle-panel[data-mode="bilingual"] .rvt-subtitle-source {
    color: rgba(229, 231, 235, 0.9);
    font-size: clamp(16px, 1.45vw, 24px);
    font-weight: 620;
  }

  .rvt-subtitle-panel[data-mode="bilingual"] .rvt-subtitle-translation {
    font-size: clamp(20px, 1.72vw, 30px);
    -webkit-line-clamp: 2;
  }

  .rvt-subtitle-panel[data-phase="interim"] .rvt-subtitle-translation {
    color: #dbeafe;
  }

  .rvt-subtitle-panel[data-style="normal"] .rvt-subtitle-source {
    font-weight: 560;
    text-shadow:
      0 1px 2px rgba(0, 0, 0, 0.72),
      0 0 4px rgba(0, 0, 0, 0.48);
  }

  .rvt-subtitle-panel[data-style="normal"] .rvt-subtitle-translation {
    font-size: clamp(20px, 1.72vw, 30px);
    font-weight: 650;
    text-shadow:
      0 2px 2px rgba(0, 0, 0, 0.78),
      0 0 6px rgba(0, 0, 0, 0.54);
  }

  .rvt-subtitle-panel[data-style="soft"] .rvt-subtitle-source {
    color: rgba(241, 245, 249, 0.82);
    font-weight: 520;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.65);
  }

  .rvt-subtitle-panel[data-style="soft"] .rvt-subtitle-translation {
    color: rgba(255, 255, 255, 0.92);
    font-size: clamp(19px, 1.62vw, 28px);
    font-weight: 600;
    text-shadow:
      0 1px 2px rgba(0, 0, 0, 0.72),
      0 0 5px rgba(0, 0, 0, 0.5);
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

if (IS_TOP_FRAME) ensureOverlay();
