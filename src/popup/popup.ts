import {
  DEFAULT_SETTINGS,
  type AsrProviderId,
  type AsrSettings,
  type RuntimeMessage,
  type RuntimeResponse,
  type SubtitleStyle,
  type TranslationProviderId,
  type TranslationProtocol,
  type TranslationSettings,
  type TranslatorSettings,
} from "../types";

type AsrPreset = {
  hint: string;
  fields: Array<keyof AsrSettings>;
  defaults: Pick<AsrSettings, "endpoint" | "model"> & Partial<AsrSettings>;
  models: string[];
};

type TranslationPreset = {
  hint: string;
  defaults: Pick<TranslationSettings, "protocol" | "baseUrl" | "model"> & Partial<TranslationSettings>;
  anthropicBaseUrl?: string;
  models: string[];
};

const ASR_PRESETS: Record<AsrProviderId, AsrPreset> = {
  volcengine: {
    hint: "在火山引擎创建“豆包流式语音识别模型 2.0”应用后填写 App ID 和 Access Token。",
    fields: ["appId", "accessToken", "resourceId", "endpoint", "model"],
    defaults: {
      endpoint: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
      model: "doubao-seed-asr",
      resourceId: "volc.seedasr.sauc.duration",
    },
    models: ["doubao-seed-asr"],
  },
  aliyun: {
    hint: "在阿里云百炼创建 API Key。默认走 Qwen-ASR 实时协议；旧 NLS 可在本机 .env 里继续配置 AppKey + Token。",
    fields: ["apiKey", "endpoint", "model"],
    defaults: {
      endpoint: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
      model: "qwen3-asr-flash-realtime",
    },
    models: ["qwen3-asr-flash-realtime"],
  },
  tencent: {
    hint: "在腾讯云语音识别开通实时识别，填写 AppID、SecretId 和 SecretKey。",
    fields: ["appId", "secretId", "secretKey", "endpoint", "model"],
    defaults: {
      endpoint: "wss://asr.cloud.tencent.com/asr/v2",
      model: "16k_en",
    },
    models: ["16k_en", "16k_zh", "16k_zh-PY"],
  },
  baidu: {
    hint: "在百度智能云语音技术开通实时语音识别，填写 AppID 和 API Key。",
    fields: ["appId", "appKey", "endpoint", "model"],
    defaults: {
      endpoint: "wss://vop.baidu.com/realtime_asr",
      model: "17372",
    },
    models: ["17372", "1737", "15372", "1537"],
  },
  iflytek: {
    hint: "在讯飞开放平台开通实时语音转写，填写 AppID 和 API Key。",
    fields: ["appId", "apiKey", "endpoint", "model"],
    defaults: {
      endpoint: "wss://rtasr.xfyun.cn/v1/ws",
      model: "en",
    },
    models: ["en", "cn"],
  },
};

const TRANSLATION_PRESETS: Record<TranslationProviderId, TranslationPreset> = {
  microsoft: {
    hint: "无需 API Key，速度快；准确度一般，适合网页和字幕快速翻译。",
    defaults: { protocol: "openai", baseUrl: "", model: "" },
    models: [],
  },
  deepseek: {
    hint: "填写 DeepSeek API Key。推荐字幕用 Flash，长文可换 Pro。",
    defaults: { protocol: "openai", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" },
    anthropicBaseUrl: "https://api.deepseek.com/anthropic",
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
  },
  mimo: {
    hint: "填写小米 MiMo Platform API Key。MiMo 使用 api-key 鉴权头，插件会自动处理。",
    defaults: { protocol: "openai", baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-pro" },
    anthropicBaseUrl: "https://api.xiaomimimo.com/anthropic",
    models: ["mimo-v2.5-pro"],
  },
  kimi: {
    hint: "填写 Kimi 开放平台 API Key。",
    defaults: { protocol: "openai", baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k2.6" },
    models: ["kimi-k2.6", "kimi-k2.7-code"],
  },
  glm: {
    hint: "填写智谱 / GLM API Key。默认使用 GLM-5.1；接口地址可按你账号套餐调整。",
    defaults: { protocol: "openai", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.1" },
    anthropicBaseUrl: "https://open.bigmodel.cn/api/anthropic",
    models: ["glm-5.1", "glm-4.6", "glm-4.5", "glm-4-flash"],
  },
  qwen: {
    hint: "填写阿里云百炼 API Key。",
    defaults: { protocol: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-flash" },
    models: ["qwen-flash", "qwen-plus", "qwen-turbo", "qwen-max"],
  },
  minimax: {
    hint: "填写 MiniMax API Key，可选择 OpenAI 或 Anthropic 兼容协议。",
    defaults: { protocol: "openai", baseUrl: "https://api.minimaxi.com/v1", model: "MiniMax-M3" },
    anthropicBaseUrl: "https://api.minimaxi.com/anthropic",
    models: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
  },
  custom: {
    hint: "选择协议后填写兼容接口地址、API Key 和模型名。",
    defaults: { protocol: "openai", baseUrl: "", model: "" },
    models: [],
  },
};

const subtitleToggle = getElement<HTMLInputElement>("subtitleToggle");
const translationModeInput = getElement<HTMLSelectElement>("translationMode");
const subtitleStyleInput = getElement<HTMLSelectElement>("subtitleStyle");
const translatePageButton = getElement<HTMLButtonElement>("translatePage");
const restorePageButton = getElement<HTMLButtonElement>("restorePage");
const autoTranslatePagesInput = getElement<HTMLInputElement>("autoTranslatePages");
const selectionTranslationInput = getElement<HTMLInputElement>("selectionTranslation");
const targetLanguageInput = getElement<HTMLSelectElement>("targetLanguage");
const asrProviderInput = getElement<HTMLSelectElement>("asrProvider");
const asrAppIdInput = getElement<HTMLInputElement>("asrAppId");
const asrAccessTokenInput = getElement<HTMLInputElement>("asrAccessToken");
const asrApiKeyInput = getElement<HTMLInputElement>("asrApiKey");
const asrApiSecretInput = getElement<HTMLInputElement>("asrApiSecret");
const asrSecretIdInput = getElement<HTMLInputElement>("asrSecretId");
const asrSecretKeyInput = getElement<HTMLInputElement>("asrSecretKey");
const asrAppKeyInput = getElement<HTMLInputElement>("asrAppKey");
const asrResourceIdInput = getElement<HTMLInputElement>("asrResourceId");
const asrEndpointInput = getElement<HTMLInputElement>("asrEndpoint");
const asrModelInput = getElement<HTMLInputElement>("asrModel");
const asrModelOptions = getElement<HTMLDataListElement>("asrModelOptions");
const asrCredentialHint = getElement<HTMLDivElement>("asrCredentialHint");
const translationProviderInput = getElement<HTMLSelectElement>("translationProvider");
const translationProtocolInput = getElement<HTMLSelectElement>("translationProtocol");
const translationApiKeyInput = getElement<HTMLInputElement>("translationApiKey");
const translationBaseUrlInput = getElement<HTMLInputElement>("translationBaseUrl");
const translationModelInput = getElement<HTMLInputElement>("translationModel");
const translationDisableThinkingInput = getElement<HTMLInputElement>("translationDisableThinking");
const translationModelOptions = getElement<HTMLDataListElement>("translationModelOptions");
const translationCredentialHint = getElement<HTMLDivElement>("translationCredentialHint");
const messageEl = getElement<HTMLParagraphElement>("message");

let initialized = false;

void init();

async function init(): Promise<void> {
  let settingsResponse: RuntimeResponse | undefined;
  try {
    settingsResponse = await send({ type: "translator:settings:get" });
  } catch {
    settingsResponse = undefined;
  }
  if (settingsResponse?.ok && settingsResponse.settings) {
    renderSettings(settingsResponse.settings);
  } else {
    renderFallbackSettings();
  }

  try {
    await refreshStatus();
  } catch {}

  bindEvents();
  installPageTranslationProgressListener();
  initialized = true;
}

function installPageTranslationProgressListener(): void {
  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || typeof message !== "object") return;
      const candidate = message as { type?: string; runId?: number; translated?: number; total?: number; batchIndex?: number; totalBatches?: number; error?: string };
      if (candidate.type === "page:translate:progress") {
        const done = candidate.batchIndex ?? 0;
        const total = candidate.totalBatches ?? 0;
        const translated = candidate.translated ?? 0;
        showMessage(`正在翻译… ${done}/${total} 批，已完成 ${translated} 个文本块`);
        return;
      }
      if (candidate.type === "page:translate:done") {
        if (candidate.error) {
          messageEl.textContent = `翻译失败：${candidate.error}`;
          messageEl.dataset.error = "true";
        } else {
          showMessage(`已翻译 ${candidate.translated ?? 0} 个文本块。`);
        }
      }
    });
  } catch {}
}

function bindEvents(): void {
  subtitleToggle.addEventListener("change", async () => {
    await saveSettings();
    try {
      const response = await send({ type: subtitleToggle.checked ? "translator:start" : "translator:stop" });
      renderResponse(response, subtitleToggle.checked ? "视频实时翻译已开始。" : "视频实时翻译已停止。");
    } catch {
      renderFallbackStatus();
    }
    await refreshStatus();
  });

  asrProviderInput.addEventListener("change", async () => {
    applyAsrPreset(asrProviderInput.value as AsrProviderId, true);
    await saveSettings();
  });

  translationProviderInput.addEventListener("change", async () => {
    applyTranslationPreset(translationProviderInput.value as TranslationProviderId, true);
    await saveSettings();
  });

  translationProtocolInput.addEventListener("change", async () => {
    applyTranslationProtocolDefault();
    await saveSettings();
  });

  translatePageButton.addEventListener("click", () => {
    translatePageButton.disabled = true;
    showMessage("正在启动翻译…");
    void (async () => {
      await saveSettings();
      showMessage("正在翻译页面…（请切回网页查看进度，翻译完成后这里会显示结果）");
      try {
        const response = await send({ type: "page:translate", targetLanguage: targetLanguageInput.value });
        renderResponse(
          response,
          response?.ok && response.pdfTranslationUrl
            ? `已打开 PDF 翻译结果，共 ${response.translated ?? 0} 个文本块。`
            : response?.ok
              ? `已翻译 ${response.translated ?? 0} 个文本块。`
              : "网页翻译失败。",
        );
      } catch {
        showMessage("网页翻译请求失败。");
      } finally {
        translatePageButton.disabled = false;
      }
    })();
  });

  restorePageButton.addEventListener("click", async () => {
    autoTranslatePagesInput.checked = false;
    await saveSettings();
    try {
      const response = await send({ type: "page:restore" });
      renderResponse(response, response?.ok ? `已恢复 ${response.restored ?? 0} 个文本块。` : "恢复失败。");
    } catch {
      showMessage("恢复失败。");
    }
  });

  autoTranslatePagesInput.addEventListener("change", async () => {
    await saveSettings();
    if (autoTranslatePagesInput.checked) {
      try {
        const response = await send({ type: "page:translate", targetLanguage: targetLanguageInput.value });
        if (!response?.ok && response?.error?.includes("chrome://")) {
          showMessage("自动网页翻译已开启。打开普通网页后会自动翻译。");
          return;
        }
        renderResponse(response, "自动网页翻译已开启。");
      } catch {
        showMessage("自动网页翻译已开启，但暂时无法翻译当前页面。");
      }
      return;
    }

    try {
      const response = await send({ type: "page:restore" });
      if (!response?.ok && response?.error?.includes("chrome://")) {
        showMessage("自动网页翻译已关闭。");
        return;
      }
      renderResponse(response, "自动网页翻译已关闭。");
    } catch {
      showMessage("自动网页翻译已关闭。");
    }
  });

  for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
    "select, input:not(#subtitleToggle):not(#autoTranslatePages)",
  )) {
    control.addEventListener("change", () => {
      if (!initialized) return;
      void saveSettings();
    });
  }
}

async function refreshStatus(): Promise<void> {
  let response: RuntimeResponse | undefined;
  try {
    response = await send({ type: "translator:status" });
  } catch {
    response = undefined;
  }
  if (!response || !response.ok) {
    subtitleToggle.checked = false;
    return;
  }
  subtitleToggle.checked = Boolean(response.running);
}

async function saveSettings(): Promise<void> {
  await send({
    type: "translator:settings:set",
    settings: {
      targetLanguage: targetLanguageInput.value,
      mockWhenBackendMissing: false,
      autoTranslatePages: autoTranslatePagesInput.checked,
      selectionTranslationEnabled: selectionTranslationInput.checked,
      showOriginal: translationModeInput.value === "bilingual",
      showTranslation: true,
      subtitleStyle: subtitleStyleInput.value as SubtitleStyle,
      asr: collectAsrSettings(),
      translation: collectTranslationSettings(),
    },
  });
}

function renderSettings(settings: TranslatorSettings): void {
  const asr = settings.asr ?? DEFAULT_SETTINGS.asr;
  const translation = settings.translation ?? DEFAULT_SETTINGS.translation;
  targetLanguageInput.value = settings.targetLanguage ?? "zh-CN";
  autoTranslatePagesInput.checked = settings.autoTranslatePages ?? false;
  selectionTranslationInput.checked = settings.selectionTranslationEnabled ?? false;
  subtitleStyleInput.value = settings.subtitleStyle ?? "bold";
  translationModeInput.value = settings.showOriginal && settings.showTranslation ? "bilingual" : "translation";

  asrProviderInput.value = asr.provider;
  asrAppIdInput.value = asr.appId;
  asrAccessTokenInput.value = asr.accessToken;
  asrApiKeyInput.value = asr.apiKey;
  asrApiSecretInput.value = asr.apiSecret;
  asrSecretIdInput.value = asr.secretId;
  asrSecretKeyInput.value = asr.secretKey;
  asrAppKeyInput.value = asr.appKey;
  asrResourceIdInput.value = asr.resourceId;
  asrEndpointInput.value = asr.endpoint;
  asrModelInput.value = asr.model;
  applyAsrPreset(asr.provider, false);

  translationProviderInput.value = translation.provider;
  translationProtocolInput.value = translation.protocol;
  translationApiKeyInput.value = translation.apiKey;
  translationBaseUrlInput.value = translation.baseUrl;
  translationModelInput.value = translation.model;
  translationDisableThinkingInput.checked = translation.disableThinking;
  applyTranslationPreset(translation.provider, false);
}

function renderFallbackSettings(): void {
  targetLanguageInput.value = "zh-CN";
  autoTranslatePagesInput.checked = false;
  selectionTranslationInput.checked = false;
  subtitleStyleInput.value = "bold";
  translationModeInput.value = "translation";

  asrProviderInput.value = "volcengine";
  asrAppIdInput.value = "";
  asrAccessTokenInput.value = "";
  asrApiKeyInput.value = "";
  asrApiSecretInput.value = "";
  asrSecretIdInput.value = "";
  asrSecretKeyInput.value = "";
  asrAppKeyInput.value = "";
  asrResourceIdInput.value = "";
  asrEndpointInput.value = "";
  asrModelInput.value = "";
  applyAsrPreset("volcengine", true);

  translationProviderInput.value = "microsoft";
  translationProtocolInput.value = "openai";
  translationApiKeyInput.value = "";
  translationBaseUrlInput.value = "";
  translationModelInput.value = "";
  translationDisableThinkingInput.checked = true;
  applyTranslationPreset("microsoft", true);
}

function collectAsrSettings(): Partial<AsrSettings> {
  return {
    provider: asrProviderInput.value as AsrProviderId,
    appId: asrAppIdInput.value.trim(),
    accessToken: asrAccessTokenInput.value.trim(),
    apiKey: asrApiKeyInput.value.trim(),
    apiSecret: asrApiSecretInput.value.trim(),
    secretId: asrSecretIdInput.value.trim(),
    secretKey: asrSecretKeyInput.value.trim(),
    appKey: asrAppKeyInput.value.trim(),
    resourceId: asrResourceIdInput.value.trim(),
    endpoint: asrEndpointInput.value.trim(),
    model: asrModelInput.value.trim(),
  };
}

function collectTranslationSettings(): Partial<TranslationSettings> {
  return {
    provider: translationProviderInput.value as TranslationProviderId,
    protocol: translationProtocolInput.value as TranslationProtocol,
    apiKey: translationApiKeyInput.value.trim(),
    baseUrl: translationBaseUrlInput.value.trim(),
    model: translationModelInput.value.trim(),
    disableThinking: translationDisableThinkingInput.checked,
  };
}

function applyAsrPreset(provider: AsrProviderId, forceDefaults: boolean): void {
  const preset = ASR_PRESETS[provider] ?? ASR_PRESETS.volcengine;
  asrCredentialHint.textContent = preset.hint;
  setDatalistOptions(asrModelOptions, preset.models);
  setValueIfNeeded(asrEndpointInput, preset.defaults.endpoint, forceDefaults);
  setValueIfNeeded(asrModelInput, preset.defaults.model, forceDefaults);
  if (preset.defaults.resourceId) setValueIfNeeded(asrResourceIdInput, preset.defaults.resourceId, forceDefaults);

  for (const row of document.querySelectorAll<HTMLElement>("[data-asr-field]")) {
    const field = row.dataset.asrField as keyof AsrSettings | undefined;
    row.hidden = !field || !preset.fields.includes(field);
  }
}

function applyTranslationPreset(provider: TranslationProviderId, forceDefaults: boolean): void {
  const preset = TRANSLATION_PRESETS[provider] ?? TRANSLATION_PRESETS.microsoft;
  translationCredentialHint.textContent = preset.hint;
  setDatalistOptions(translationModelOptions, preset.models);
  if (forceDefaults) translationProtocolInput.value = preset.defaults.protocol;
  setValueIfNeeded(translationBaseUrlInput, getTranslationPresetBaseUrl(preset), forceDefaults);
  setValueIfNeeded(translationModelInput, preset.defaults.model, forceDefaults);

  const isMicrosoft = provider === "microsoft";
  for (const row of document.querySelectorAll<HTMLElement>("[data-translation-field]")) {
    row.hidden = isMicrosoft;
  }
}

function applyTranslationProtocolDefault(): void {
  const preset = TRANSLATION_PRESETS[translationProviderInput.value as TranslationProviderId];
  if (!preset) return;
  const baseUrl = getTranslationPresetBaseUrl(preset);
  if (baseUrl) translationBaseUrlInput.value = baseUrl;
}

function getTranslationPresetBaseUrl(preset: TranslationPreset): string {
  if (translationProtocolInput.value === "anthropic" && preset.anthropicBaseUrl) return preset.anthropicBaseUrl;
  return preset.defaults.baseUrl;
}

function setValueIfNeeded(input: HTMLInputElement, value: string, force: boolean): void {
  if (!value) return;
  if (force || !input.value.trim()) input.value = value;
}

function setDatalistOptions(datalist: HTMLDataListElement, values: string[]): void {
  datalist.textContent = "";
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    datalist.append(option);
  }
}

function renderResponse(response: RuntimeResponse | undefined, successMessage: string): void {
  if (!response) {
    showMessage("请求失败，请重试。");
    return;
  }
  if (response.ok) {
    showMessage(successMessage);
    return;
  }
  messageEl.textContent = response.error;
  messageEl.dataset.error = "true";
}

function showMessage(message: string): void {
  messageEl.textContent = message;
  messageEl.dataset.error = "false";
}

function renderFallbackStatus(): void {
  subtitleToggle.checked = false;
}

async function send(message: RuntimeMessage): Promise<RuntimeResponse> {
  try {
    const response = await chrome.runtime.sendMessage(message);
    if (!response) {
      return { ok: false, error: "扩展后台未启动，请刷新页面重试。" };
    }
    return response;
  } catch {
    return { ok: false, error: "扩展后台未启动，请刷新页面重试。" };
  }
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}
