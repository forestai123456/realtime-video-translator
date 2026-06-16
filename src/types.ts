export type RuntimeMessage =
  | { type: "translator:start"; tabId?: number }
  | { type: "translator:stop"; tabId?: number }
  | { type: "translator:suspend"; tabId?: number }
  | { type: "translator:resume"; tabId?: number }
  | { type: "translator:status"; tabId?: number }
  | { type: "translator:settings:get" }
  | { type: "translator:settings:set"; settings: TranslatorSettingsPatch }
  | { type: "page:translate"; tabId?: number; targetLanguage?: string }
  | { type: "page:restore"; tabId?: number }
  | { type: "page:translate:batch"; texts: string[]; targetLanguage: string }
  | { type: "page:translate:done"; runId: number; translated: number; error?: string }
  | { type: "offscreen:start"; tabId: number; streamId?: string; settings: TranslatorSettings }
  | { type: "offscreen:stop"; tabId: number }
  | { type: "offscreen:pause"; tabId: number }
  | { type: "offscreen:resume"; tabId: number }
  | { type: "caption:update"; tabId: number; caption: CaptionUpdate }
  | { type: "caption:clear"; tabId: number }
  | { type: "caption:state"; running: boolean; mode: StreamMode };

export type RuntimeResponse =
  | {
      ok: true;
      running?: boolean;
      suspended?: boolean;
      mode?: StreamMode;
      settings?: TranslatorSettings;
      translated?: number;
      restored?: number;
      translations?: string[];
      pdfTranslationUrl?: string;
    }
  | { ok: false; error: string };

export type PageTranslateProgress = { type: "page:translate:progress"; runId: number; translated: number; total: number; batchIndex: number; totalBatches: number };

export type StreamMode = "mock" | "websocket";

export type AsrProviderId = "volcengine" | "aliyun" | "tencent" | "baidu" | "iflytek";
export type TranslationProviderId =
  | "microsoft"
  | "deepseek"
  | "kimi"
  | "qwen"
  | "glm"
  | "minimax"
  | "mimo"
  | "custom";
export type TranslationProtocol = "openai" | "anthropic";
export type SubtitleStyle = "bold" | "normal" | "soft";

export interface AsrSettings {
  provider: AsrProviderId;
  appId: string;
  accessToken: string;
  apiKey: string;
  apiSecret: string;
  secretId: string;
  secretKey: string;
  appKey: string;
  resourceId: string;
  endpoint: string;
  model: string;
}

export interface TranslationSettings {
  provider: TranslationProviderId;
  protocol: TranslationProtocol;
  apiKey: string;
  baseUrl: string;
  model: string;
  disableThinking: boolean;
}

export interface TranslatorSettings {
  schemaVersion: number;
  enabled: boolean;
  targetLanguage: string;
  backendUrl: string;
  asr: AsrSettings;
  translation: TranslationSettings;
  mockWhenBackendMissing: boolean;
  autoTranslatePages: boolean;
  selectionTranslationEnabled: boolean;
  showOriginal: boolean;
  showTranslation: boolean;
  subtitleStyle: SubtitleStyle;
  floating: boolean;
}

export type TranslatorSettingsPatch = Partial<Omit<TranslatorSettings, "asr" | "translation">> & {
  asr?: Partial<AsrSettings>;
  translation?: Partial<TranslationSettings>;
};

export interface CaptionUpdate {
  id: string;
  sourceText: string;
  translatedText: string;
  isFinal: boolean;
  startedAt: number;
  receivedAt: number;
  revision?: number;
}

export const DEFAULT_SETTINGS: TranslatorSettings = {
  schemaVersion: 7,
  enabled: true,
  targetLanguage: "zh-CN",
  backendUrl: "ws://localhost:8787/realtime",
  asr: {
    provider: "volcengine",
    appId: "",
    accessToken: "",
    apiKey: "",
    apiSecret: "",
    secretId: "",
    secretKey: "",
    appKey: "",
    resourceId: "volc.seedasr.sauc.duration",
    endpoint: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
    model: "doubao-seed-asr",
  },
  translation: {
    provider: "microsoft",
    protocol: "openai",
    apiKey: "",
    baseUrl: "",
    model: "",
    disableThinking: true,
  },
  mockWhenBackendMissing: false,
  autoTranslatePages: false,
  selectionTranslationEnabled: false,
  showOriginal: false,
  showTranslation: true,
  subtitleStyle: "bold",
  floating: true,
};
