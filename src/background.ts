import {
  AsrSettings,
  DEFAULT_SETTINGS,
  RuntimeMessage,
  RuntimeResponse,
  StreamMode,
  TranslationSettings,
  TranslatorSettings,
  TranslatorSettingsPatch,
} from "./types";

const OFFSCREEN_DOCUMENT_PATH = "offscreen/offscreen.html";
const PDF_TRANSLATION_STORAGE_PREFIX = "pdfTranslation:";
const runningTabs = new Map<number, { mode: "mock" | "websocket"; suspended?: boolean }>();

chrome.runtime.onInstalled.addListener(async () => {
  await getSettings();
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error: unknown) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies RuntimeResponse);
    });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  runningTabs.delete(tabId);
  void chrome.runtime.sendMessage({ type: "offscreen:stop", tabId } satisfies RuntimeMessage).catch(() => undefined);
});

async function handleMessage(message: RuntimeMessage, sender: chrome.runtime.MessageSender): Promise<RuntimeResponse> {
  switch (message.type) {
    case "translator:start": {
      const tabId = message.tabId ?? sender.tab?.id ?? (await getActiveTabId());
      const settings = await getSettings();
      const mode = await startTabCaptureSession(tabId, settings, true);
      return { ok: true, running: true, suspended: false, mode };
    }
    case "translator:stop": {
      const tabId = message.tabId ?? sender.tab?.id ?? (await getActiveTabId());
      runningTabs.delete(tabId);
      await chrome.runtime.sendMessage({ type: "offscreen:stop", tabId } satisfies RuntimeMessage).catch(() => undefined);
      await chrome.tabs.sendMessage(tabId, { type: "caption:clear", tabId } satisfies RuntimeMessage, { frameId: 0 }).catch(() => undefined);
      await chrome.tabs.sendMessage(tabId, { type: "caption:state", running: false, mode: "mock" } satisfies RuntimeMessage, { frameId: 0 }).catch(() => undefined);
      return { ok: true, running: false };
    }
case "translator:suspend": {
      const tabId = message.tabId ?? sender.tab?.id ?? (await getActiveTabId());
      const status = runningTabs.get(tabId);
      if (!status) return { ok: true, running: false };

      runningTabs.set(tabId, { ...status, suspended: true });
      await chrome.runtime.sendMessage({ type: "offscreen:pause", tabId } satisfies RuntimeMessage).catch(() => undefined);
      await chrome.tabs.sendMessage(tabId, { type: "caption:clear", tabId } satisfies RuntimeMessage, { frameId: 0 }).catch(() => undefined);
      await chrome.tabs.sendMessage(tabId, { type: "caption:state", running: true, mode: status.mode } satisfies RuntimeMessage, { frameId: 0 }).catch(() => undefined);
      return { ok: true, running: true, suspended: true, mode: status.mode };
    }
    case "translator:resume": {
      const tabId = message.tabId ?? sender.tab?.id ?? (await getActiveTabId());
      const status = runningTabs.get(tabId);
      if (!status) return { ok: true, running: false };

      await chrome.runtime.sendMessage({ type: "offscreen:resume", tabId } satisfies RuntimeMessage).catch(() => undefined);
      runningTabs.set(tabId, { ...status, suspended: false });
      await chrome.tabs.sendMessage(tabId, { type: "caption:state", running: true, mode: status.mode } satisfies RuntimeMessage, { frameId: 0 }).catch(() => undefined);
      return { ok: true, running: true, suspended: false, mode: status.mode };
    }
    case "translator:status": {
      const tabId = message.tabId ?? sender.tab?.id ?? (await getActiveTabId());
      const status = runningTabs.get(tabId);
      return { ok: true, running: Boolean(status), suspended: Boolean(status?.suspended), mode: status?.mode ?? "mock" };
    }
    case "translator:settings:get": {
      return { ok: true, settings: await getSettings() };
    }
    case "translator:settings:set": {
      const previous = await getSettings();
      const next = mergeSettings(previous, message.settings);
      await chrome.storage.local.set({ settings: next });
      if (previous.autoTranslatePages && !next.autoTranslatePages) {
        void restoreAllPageTranslations();
      }
      return { ok: true, settings: next };
    }
    case "page:translate": {
      const tabId = message.tabId ?? sender.tab?.id ?? (await getActiveTabId());
      const settings = await getSettings();
      return translatePageInTab(tabId, message.targetLanguage ?? settings.targetLanguage, settings);
    }
    case "page:restore": {
      const tabId = message.tabId ?? sender.tab?.id ?? (await getActiveTabId());
      await ensureContentScriptReady(tabId);
      const response = (await chrome.tabs.sendMessage(tabId, { type: "page:restore" } satisfies RuntimeMessage, { frameId: 0 })) as RuntimeResponse;
      return response;
    }
    case "page:translate:batch": {
      const settings = await getSettings();
      const translations = await translateBatch(message.texts, message.targetLanguage, settings);
      return { ok: true, translations };
    }
    case "caption:update": {
      const status = runningTabs.get(message.tabId);
      if (!status || status.suspended) return { ok: true };
      await chrome.tabs.sendMessage(message.tabId, message, { frameId: 0 }).catch(() => undefined);
      return { ok: true };
    }
    default:
      return { ok: false, error: `Unhandled message: ${(message as { type?: string }).type}` };
  }
}

async function startTabCaptureSession(tabId: number, settings: TranslatorSettings, clearCaption: boolean): Promise<StreamMode> {
  const mode: StreamMode = settings.backendUrl ? "websocket" : "mock";
  await ensureContentScriptReady(tabId);
  await ensureOffscreenDocument();

  await chrome.runtime.sendMessage({ type: "offscreen:stop", tabId } satisfies RuntimeMessage).catch(() => undefined);
  await wait(150);

  const streamId = settings.backendUrl ? await getMediaStreamId(tabId) : undefined;
  const startMessage = {
    type: "offscreen:start",
    tabId,
    settings,
    ...(streamId ? { streamId } : {}),
  } satisfies RuntimeMessage;
  await chrome.runtime.sendMessage(startMessage);
  runningTabs.set(tabId, { mode, suspended: false });

  if (clearCaption) {
    await chrome.tabs.sendMessage(tabId, { type: "caption:clear", tabId } satisfies RuntimeMessage, { frameId: 0 }).catch(() => undefined);
  }

  await chrome.tabs.sendMessage(tabId, { type: "caption:state", running: true, mode } satisfies RuntimeMessage, { frameId: 0 }).catch(() => undefined);
  return mode;
}

async function translatePageInTab(
  tabId: number,
  targetLanguage: string,
  settings: TranslatorSettings,
): Promise<RuntimeResponse> {
  const tab = await chrome.tabs.get(tabId);
  if (isPdfTab(tab)) {
    const result = await translatePdf(tab, targetLanguage, settings);
    return { ok: true, translated: result.paragraphs.length, pdfTranslationUrl: result.url };
  }

  await ensureContentScriptReady(tabId);
  const response = (await chrome.tabs.sendMessage(tabId, {
    type: "page:translate",
    targetLanguage,
  } satisfies RuntimeMessage, { frameId: 0 })) as RuntimeResponse;
  return response;
}

async function restoreAllPageTranslations(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id || !isAutoPageTranslationUrl(tab.url)) return;
      await chrome.tabs.sendMessage(tab.id, { type: "page:restore" } satisfies RuntimeMessage, { frameId: 0 }).catch(() => undefined);
    }),
  );
}

async function getSettings(): Promise<TranslatorSettings> {
  const localStored = await chrome.storage.local.get("settings");
  if (localStored.settings && localStored.settings.schemaVersion === DEFAULT_SETTINGS.schemaVersion) {
    return mergeSettings(DEFAULT_SETTINGS, localStored.settings);
  }
  const syncStored = await chrome.storage.sync.get("settings").catch(() => ({ settings: undefined }));
  const raw = localStored.settings ?? syncStored.settings;
  const rawSchemaVersion = typeof raw?.schemaVersion === "number" ? raw.schemaVersion : 0;
  const settings = mergeSettings(DEFAULT_SETTINGS, raw);
  const migrated = {
    ...settings,
    schemaVersion: DEFAULT_SETTINGS.schemaVersion,
    backendUrl: settings.backendUrl || DEFAULT_SETTINGS.backendUrl,
    mockWhenBackendMissing: false,
  };
  if (rawSchemaVersion < 6 && migrated.showOriginal && migrated.showTranslation) {
    migrated.showOriginal = false;
    migrated.showTranslation = true;
  }
  await chrome.storage.local.set({ settings: migrated });
  await chrome.storage.sync.remove("settings").catch(() => {});
  return migrated;
}

function mergeSettings(base: TranslatorSettings, patch?: TranslatorSettingsPatch | Partial<TranslatorSettings> | null): TranslatorSettings {
  const next = {
    ...DEFAULT_SETTINGS,
    ...base,
    ...(patch ?? {}),
  } as TranslatorSettings;
  const patchAsr = (patch as { asr?: Partial<AsrSettings> } | null | undefined)?.asr ?? {};
  const patchTranslation = (patch as { translation?: Partial<TranslationSettings> } | null | undefined)?.translation ?? {};
  return {
    ...next,
    schemaVersion: DEFAULT_SETTINGS.schemaVersion,
    backendUrl: next.backendUrl || DEFAULT_SETTINGS.backendUrl,
    asr: {
      ...DEFAULT_SETTINGS.asr,
      ...(base.asr ?? {}),
      ...patchAsr,
    },
    translation: {
      ...DEFAULT_SETTINGS.translation,
      ...(base.translation ?? {}),
      ...patchTranslation,
    },
  };
}

async function getActiveTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found.");
  return tab.id;
}

async function ensureContentScriptReady(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "caption:state", running: false, mode: "mock" } satisfies RuntimeMessage, { frameId: 0 });
  } catch {
    await chrome.scripting?.executeScript?.({
      target: { tabId, allFrames: true },
      files: ["content/contentScript.js"],
    });
  }
}

async function ensureOffscreenDocument(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
  });

  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: "Capture the active tab audio and stream PCM frames to a realtime ASR backend.",
  });
}

function getMediaStreamId(tabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (!streamId) {
        reject(new Error("Chrome did not return a tab capture stream ID."));
        return;
      }
      resolve(streamId);
    });
  });
}

async function translateBatch(texts: string[], targetLanguage: string, settings: TranslatorSettings): Promise<string[]> {
  const endpoint = toTranslateEndpoint(settings.backendUrl || DEFAULT_SETTINGS.backendUrl);
  const translation = settings.translation;
  const body: Record<string, unknown> = { texts, targetLanguage };
  if (translation?.provider) {
    body.translation = translation;
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw new Error(await readBackendError(response, `网页翻译后端请求失败：${response.status}`));
  const result = (await response.json()) as { translations?: string[] };
  return result.translations ?? texts.map(() => "");
}

interface PdfTranslationResult {
  url: string;
  paragraphs: Array<{ source: string; translation: string }>;
}

async function translatePdf(tab: chrome.tabs.Tab, targetLanguage: string, settings: TranslatorSettings): Promise<PdfTranslationResult> {
  if (!tab.url) throw new Error("当前标签页没有找到 PDF 地址。");
  const endpoint = toBackendEndpoint(settings.backendUrl || DEFAULT_SETTINGS.backendUrl, "/translate-pdf");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: tab.url,
      title: tab.title || "PDF 翻译",
      targetLanguage,
      translation: settings.translation,
    }),
  });

  if (!response.ok) throw new Error(await readBackendError(response, `PDF 翻译后端请求失败：${response.status}`));
  const result = (await response.json()) as {
    ok?: boolean;
    title?: string;
    sourceUrl?: string;
    paragraphs?: Array<{ source?: string; translation?: string }>;
    error?: string;
  };
  if (!result.ok) throw new Error(result.error || "PDF 翻译失败。");

  const paragraphs = (result.paragraphs ?? [])
    .map((paragraph) => ({
      source: String(paragraph.source ?? ""),
      translation: String(paragraph.translation ?? ""),
    }))
    .filter((paragraph) => paragraph.source || paragraph.translation);
  if (paragraphs.length === 0) throw new Error("这个 PDF 没有可选择的文本。扫描版 PDF 需要 OCR 支持。");

  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await chrome.storage.local.set({
    [`${PDF_TRANSLATION_STORAGE_PREFIX}${id}`]: {
      title: result.title || tab.title || "PDF 翻译",
      sourceUrl: result.sourceUrl || tab.url,
      createdAt: Date.now(),
      paragraphs,
    },
  });
  const url = chrome.runtime.getURL(`pdf/pdfTranslation.html?id=${encodeURIComponent(id)}`);
  await chrome.tabs.create({ url, active: true });
  return { url, paragraphs };
}

async function readBackendError(response: Response, fallback: string): Promise<string> {
  try {
    const result = (await response.clone().json()) as { error?: string };
    if (result.error) return result.error;
  } catch {}
  return fallback;
}

function toTranslateEndpoint(backendUrl: string): string {
  return toBackendEndpoint(backendUrl, "/translate");
}

function toBackendEndpoint(backendUrl: string, pathname: string): string {
  const url = new URL(backendUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function isPdfTab(tab: chrome.tabs.Tab): boolean {
  const url = tab.url || "";
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:" && parsed.pathname.toLowerCase().endsWith(".pdf")) return true;
    if (parsed.pathname.toLowerCase().endsWith(".pdf")) return true;
    return /\.pdf(?:[?#]|$)/i.test(url);
  } catch {
    return /\.pdf(?:[?#]|$)/i.test(url);
  }
}

function isAutoPageTranslationUrl(url: string | undefined): boolean {
  if (!url) return false;
  if (/\.pdf(?:[?#]|$)/i.test(url)) return false;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "file:") return false;
    if (parsed.pathname.toLowerCase().endsWith(".pdf")) return false;
    return true;
  } catch {
    return false;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
