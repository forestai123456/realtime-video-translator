export type RuntimeMessage =
  | { type: "translator:start"; tabId?: number }
  | { type: "translator:stop"; tabId?: number }
  | { type: "translator:suspend"; tabId?: number }
  | { type: "translator:resume"; tabId?: number }
  | { type: "translator:status"; tabId?: number }
  | { type: "translator:settings:get" }
  | { type: "translator:settings:set"; settings: Partial<TranslatorSettings> }
  | { type: "page:translate"; tabId?: number; targetLanguage?: string }
  | { type: "page:restore"; tabId?: number }
  | { type: "page:translate:batch"; texts: string[]; targetLanguage: string }
  | { type: "offscreen:start"; tabId: number; streamId?: string; settings: TranslatorSettings }
  | { type: "offscreen:stop"; tabId: number }
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

export type StreamMode = "mock" | "websocket";

export interface TranslatorSettings {
  schemaVersion: number;
  enabled: boolean;
  targetLanguage: string;
  backendUrl: string;
  mockWhenBackendMissing: boolean;
  autoTranslatePages: boolean;
  showOriginal: boolean;
  showTranslation: boolean;
  floating: boolean;
}

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
  schemaVersion: 3,
  enabled: true,
  targetLanguage: "zh-CN",
  backendUrl: "ws://localhost:8787/realtime",
  mockWhenBackendMissing: false,
  autoTranslatePages: false,
  showOriginal: true,
  showTranslation: true,
  floating: true,
};
