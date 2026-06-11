import { RuntimeMessage, RuntimeResponse, TranslatorSettings } from "../types";

const statusEl = getElement<HTMLSpanElement>("status");
const startButton = getElement<HTMLButtonElement>("start");
const stopButton = getElement<HTMLButtonElement>("stop");
const translatePageButton = getElement<HTMLButtonElement>("translatePage");
const restorePageButton = getElement<HTMLButtonElement>("restorePage");
const backendUrlInput = getElement<HTMLInputElement>("backendUrl");
const mockInput = getElement<HTMLInputElement>("mockWhenBackendMissing");
const autoTranslatePagesInput = getElement<HTMLInputElement>("autoTranslatePages");
const targetLanguageInput = getElement<HTMLSelectElement>("targetLanguage");
const messageEl = getElement<HTMLParagraphElement>("message");

void init();

async function init(): Promise<void> {
  const settingsResponse = await send({ type: "translator:settings:get" });
  if (settingsResponse.ok && settingsResponse.settings) {
    renderSettings(settingsResponse.settings);
  }

  await refreshStatus();

  startButton.addEventListener("click", async () => {
    await saveSettings();
    const response = await send({ type: "translator:start" });
    renderResponse(response, "字幕已开始。");
    await refreshStatus();
  });

  stopButton.addEventListener("click", async () => {
    const response = await send({ type: "translator:stop" });
    renderResponse(response, "字幕已停止。");
    await refreshStatus();
  });

  translatePageButton.addEventListener("click", async () => {
    await saveSettings();
    const response = await send({ type: "page:translate", targetLanguage: targetLanguageInput.value });
    renderResponse(
      response,
      response.ok && response.pdfTranslationUrl
        ? `已打开 PDF 翻译结果，共 ${response.translated ?? 0} 个文本块。`
        : response.ok
          ? `已翻译 ${response.translated ?? 0} 个文本块。`
          : "网页翻译失败。",
    );
  });

  restorePageButton.addEventListener("click", async () => {
    autoTranslatePagesInput.checked = false;
    await saveSettings();
    const response = await send({ type: "page:restore" });
    renderResponse(response, response.ok ? `已恢复 ${response.restored ?? 0} 个文本块。` : "恢复失败。");
  });

  backendUrlInput.addEventListener("change", saveSettings);
  mockInput.addEventListener("change", saveSettings);
  autoTranslatePagesInput.addEventListener("change", async () => {
    await saveSettings();
    if (autoTranslatePagesInput.checked) {
      const response = await send({ type: "page:translate", targetLanguage: targetLanguageInput.value });
      if (!response.ok && response.error.includes("chrome://")) {
        messageEl.textContent = "自动网页翻译已开启。打开普通网页后会自动翻译。";
        messageEl.dataset.error = "false";
        return;
      }
      renderResponse(response, "自动网页翻译已开启。");
      return;
    }

    const response = await send({ type: "page:restore" });
    if (!response.ok && response.error.includes("chrome://")) {
      messageEl.textContent = "自动网页翻译已关闭。";
      messageEl.dataset.error = "false";
      return;
    }
    renderResponse(response, "自动网页翻译已关闭。");
  });
  targetLanguageInput.addEventListener("change", saveSettings);
}

async function refreshStatus(): Promise<void> {
  const response = await send({ type: "translator:status" });
  if (!response.ok) {
    statusEl.textContent = "不可用";
    return;
  }
  statusEl.textContent = response.running ? `运行中（${response.mode === "websocket" ? "实时" : "模拟"}）` : "已停止";
}

async function saveSettings(): Promise<void> {
  await send({
    type: "translator:settings:set",
      settings: {
        backendUrl: backendUrlInput.value.trim(),
        mockWhenBackendMissing: mockInput.checked,
        autoTranslatePages: autoTranslatePagesInput.checked,
        targetLanguage: targetLanguageInput.value,
      },
  });
}

function renderSettings(settings: TranslatorSettings): void {
  backendUrlInput.value = settings.backendUrl;
  mockInput.checked = settings.mockWhenBackendMissing;
  autoTranslatePagesInput.checked = settings.autoTranslatePages;
  targetLanguageInput.value = settings.targetLanguage;
}

function renderResponse(response: RuntimeResponse, successMessage: string): void {
  messageEl.textContent = response.ok ? successMessage : response.error;
  messageEl.dataset.error = String(!response.ok);
}

function send(message: RuntimeMessage): Promise<RuntimeResponse> {
  return chrome.runtime.sendMessage(message);
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}
