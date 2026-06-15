import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFile, readFileSync } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { PDFParse } from "pdf-parse";
import { WebSocket, WebSocketServer } from "ws";

loadDotEnv();

const port = Number(process.env.PORT ?? 8787);
const appId = process.env.VOLCENGINE_APP_ID;
const accessToken = process.env.VOLCENGINE_ACCESS_TOKEN;
const resourceId = process.env.VOLCENGINE_RESOURCE_ID ?? "volc.seedasr.sauc.duration";
const volcUrl =
  process.env.VOLCENGINE_ASR_WS_URL ?? "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";
const translationProvider = normalizeTranslationProvider(process.env.TRANSLATION_PROVIDER ?? "microsoft");
const pageTranslationProvider = normalizeTranslationProvider(process.env.PAGE_TRANSLATION_PROVIDER ?? "balanced");
const pdfTranslationProvider = normalizeTranslationProvider(process.env.PDF_TRANSLATION_PROVIDER ?? "accurate");
const aiTranslationBaseUrl =
  process.env.AI_TRANSLATION_BASE_URL ?? process.env.OPENAI_COMPATIBLE_BASE_URL ?? "https://api.deepseek.com";
const aiTranslationApiKey =
  process.env.AI_TRANSLATION_API_KEY ?? process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.DEEPSEEK_API_KEY;
const aiTranslationModel = process.env.AI_TRANSLATION_MODEL ?? process.env.OPENAI_COMPATIBLE_MODEL ?? "deepseek-v4-flash";
const aiTranslationDisableThinking = process.env.AI_TRANSLATION_DISABLE_THINKING !== "false";
const defaultAsrSettings = {
  provider: normalizeAsrProvider(process.env.ASR_PROVIDER ?? "volcengine"),
  appId: process.env.ASR_APP_ID ?? appId ?? "",
  accessToken: process.env.ASR_ACCESS_TOKEN ?? accessToken ?? "",
  apiKey: process.env.ASR_API_KEY ?? "",
  apiSecret: process.env.ASR_API_SECRET ?? "",
  secretId: process.env.ASR_SECRET_ID ?? "",
  secretKey: process.env.ASR_SECRET_KEY ?? "",
  appKey: process.env.ASR_APP_KEY ?? "",
  resourceId,
  endpoint: process.env.ASR_WS_URL ?? volcUrl,
  model: process.env.ASR_MODEL ?? "doubao-seed-asr",
};

const translationProviderDefaults = {
  microsoft: { provider: "microsoft", protocol: "openai", baseUrl: "", model: "", apiKey: "", disableThinking: true },
  deepseek: {
    provider: "deepseek",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com",
    anthropicBaseUrl: "https://api.deepseek.com/anthropic",
    model: "deepseek-v4-flash",
    disableThinking: true,
  },
  mimo: {
    provider: "mimo",
    protocol: "openai",
    baseUrl: "https://api.xiaomimimo.com/v1",
    anthropicBaseUrl: "https://api.xiaomimimo.com/anthropic",
    model: "mimo-v2.5-pro",
    disableThinking: true,
  },
  kimi: {
    provider: "kimi",
    protocol: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "kimi-k2.6",
    disableThinking: true,
  },
  glm: {
    provider: "glm",
    protocol: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    anthropicBaseUrl: "https://open.bigmodel.cn/api/anthropic",
    model: "glm-5.1",
    disableThinking: true,
  },
  qwen: {
    provider: "qwen",
    protocol: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-flash",
    disableThinking: true,
  },
  minimax: {
    provider: "minimax",
    protocol: "openai",
    baseUrl: "https://api.minimaxi.com/v1",
    anthropicBaseUrl: "https://api.minimaxi.com/anthropic",
    model: "MiniMax-M3",
    disableThinking: true,
  },
  custom: { provider: "custom", protocol: "openai", baseUrl: "", model: "", disableThinking: true },
};

const SAMPLE_RATE = 16000;
const AUDIO_SEGMENT_MS = 200;
const AUDIO_SEGMENT_BYTES = Math.floor((SAMPLE_RATE * 2 * AUDIO_SEGMENT_MS) / 1000);
const AUDIO_BUFFER_MAX_MS = readPositiveIntegerEnv("ASR_AUDIO_BUFFER_MAX_MS", 8_000);
const AUDIO_BUFFER_MAX_BYTES = Math.max(AUDIO_SEGMENT_BYTES, Math.floor((SAMPLE_RATE * 2 * AUDIO_BUFFER_MAX_MS) / 1000));
const ASR_KEEPALIVE_MS = readPositiveIntegerEnv("ASR_KEEPALIVE_MS", 1_000);
const ASR_KEEPALIVE_IDLE_MS = readPositiveIntegerEnv("ASR_KEEPALIVE_IDLE_MS", 1_500);
const ASR_UPSTREAM_ROTATE_MS = readPositiveIntegerEnv("VOLCENGINE_ASR_ROTATE_MS", 270_000);
const DEBUG_CAPTION = readPositiveIntegerEnv("DEBUG_CAPTION", 0) === 1;
const CAPTION_FRAGMENT_MAX_CHARS = 32;
const CAPTION_FRAGMENT_MAX_WORDS = 4;
const CAPTION_MIN_COMPLETE_CHARS = 3;
const CAPTION_MIN_COMPLETE_WORDS = 1;
const CAPTION_FLUSH_PENDING_MS = readPositiveIntegerEnv("SUBTITLE_FLUSH_PENDING_MS", 2_000);
const CAPTION_PENDING_FRAGMENT_LIMIT = readPositiveIntegerEnv("SUBTITLE_PENDING_FRAGMENT_LIMIT", 200);
const CAPTION_TRANSLATION_CONCURRENCY = 3;
const CAPTION_PROCESSED_FRAGMENT_LIMIT = readPositiveIntegerEnv("SUBTITLE_PROCESSED_FRAGMENT_LIMIT", 50_000);
const CAPTION_RECENT_FRAGMENT_LIMIT = 240;
const SUBTITLE_TRANSLATION_TIMEOUT_MS = readPositiveIntegerEnv("SUBTITLE_TRANSLATION_TIMEOUT_MS", 8_000);
const PDF_MAX_PARAGRAPHS = 240;
const PDF_TRANSLATION_BATCH_SIZE = 8;
const PDF_TRANSLATION_CONCURRENCY = 2;
const PDF_CONTEXT_PARAGRAPHS = 2;
const PDF_MAX_PARAGRAPH_CHARS = 1_200;

const ProtocolVersion = { V1: 0b0001 };
const MessageType = {
  CLIENT_FULL_REQUEST: 0b0001,
  CLIENT_AUDIO_ONLY_REQUEST: 0b0010,
  SERVER_FULL_RESPONSE: 0b1001,
  SERVER_ERROR_RESPONSE: 0b1111,
};
const Flags = {
  POS_SEQUENCE: 0b0001,
  NEG_WITH_SEQUENCE: 0b0011,
};
const Serialization = { JSON: 0b0001 };
const Compression = { GZIP: 0b0001 };

const server = http.createServer((request, response) => {
  void handleHttpRequest(request, response).catch((error) => {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  });
});

const wss = new WebSocketServer({ server, path: "/realtime" });

wss.on("connection", (client) => {
  let upstream = null;
  let seq = 1;
  let ready = false;
  let sessionActive = false;
  let audioBuffer = Buffer.alloc(0);
  let captionId = `caption-${Date.now()}`;
  let lastText = "";
  let lastTranslatedText = "";
  let processedCaptionFragmentKeys = new Set();
  let processedCaptionFragmentKeyOrder = [];
  let recentCaptionFragmentKeys = [];
  let pendingCaptionFragments = [];
  let targetLanguage = "zh-CN";
  let asrSettings = resolveAsrSettings();
  let sessionTranslationConfig = resolveTranslationConfig(undefined, translationProvider);
  let captionRevision = 0;
  let sentWavHeader = false;
  let upstreamStartedAt = 0;
  let lastAudioSentAt = 0;
  let keepAliveTimer = null;
  let pendingFragmentText = "";
  let pendingFragmentFirstSeenAt = 0;
  let flushTimer = null;

  function sendCaption(sourceText, translatedText = "", isFinal = false, revision = captionRevision) {
    if (client.readyState !== WebSocket.OPEN) return;
    client.send(
      JSON.stringify({
        id: captionId,
        sourceText,
        translatedText,
        isFinal,
        startedAt: Date.now(),
        revision,
      }),
    );
  }

  function fail(message) {
    if (client.readyState !== WebSocket.OPEN) return;
    client.send(
      JSON.stringify({
        id: `status-${Date.now()}`,
        sourceText: "",
        translatedText: "",
        isFinal: true,
        startedAt: Date.now(),
        revision: captionRevision,
        status: "error",
        message,
      }),
    );
  }

  async function connectAsr() {
    if (asrSettings.provider === "aliyun") return connectAliyun();
    if (asrSettings.provider === "tencent") return connectTencent();
    if (asrSettings.provider === "baidu") return connectBaidu();
    if (asrSettings.provider === "iflytek") return connectIflytek();
    return connectVolcengine();
  }

  async function connectVolcengine() {
    if (!sessionActive || client.readyState !== WebSocket.OPEN) return;
    if (upstream && (upstream.readyState === WebSocket.CONNECTING || upstream.readyState === WebSocket.OPEN)) return;

    if (!asrSettings.appId || !asrSettings.accessToken) {
      fail("缺少火山引擎 App ID 或 Access Token。");
      client.close(1011, "Volcengine credentials missing");
      return;
    }

    ready = false;
    sentWavHeader = false;
    seq = 1;
    lastText = "";
    upstreamStartedAt = 0;
    lastAudioSentAt = 0;
    const socket = new WebSocket(asrSettings.endpoint || volcUrl, {
      headers: {
        "X-Api-App-Key": asrSettings.appId,
        "X-Api-Access-Key": asrSettings.accessToken,
        "X-Api-Resource-Id": asrSettings.resourceId || resourceId,
        "X-Api-Request-Id": randomUUID(),
        "X-Api-Connect-Id": randomUUID(),
      },
    });
    upstream = socket;

    socket.on("open", () => {
      if (socket !== upstream || !sessionActive) {
        socket.close();
        return;
      }
      ready = true;
      upstreamStartedAt = Date.now();
      socket.send(buildFullClientRequest(seq++));
      flushAudio(false);
    });

    socket.on("message", (data) => {
      if (socket !== upstream || !sessionActive) return;
      const response = parseVolcengineResponse(Buffer.from(data));
      if (response.code) {
        fail(`火山 ASR 错误 ${response.code}: ${JSON.stringify(response.payloadMsg ?? {})}`);
        resetUpstream(socket);
        return;
      }

      const transcript = extractTranscript(response.payloadMsg);
      if (DEBUG_CAPTION && transcript) console.log(`[caption-debug] Volcengine ASR raw transcript: "${transcript.slice(0, 80)}"`);
      handleTranscriptText(transcript);
    });

    socket.on("error", (error) => {
      fail(error instanceof Error ? error.message : String(error));
      resetUpstream(socket);
    });

    socket.on("close", () => {
      if (socket !== upstream) return;
      resetUpstream(socket, false);
    });
  }

  async function connectAliyun() {
    if (usesAliyunQwenRealtime(asrSettings)) return connectAliyunQwenRealtime();
    return connectAliyunNls();
  }

  async function connectAliyunQwenRealtime() {
    if (!sessionActive || client.readyState !== WebSocket.OPEN) return;
    if (upstream && (upstream.readyState === WebSocket.CONNECTING || upstream.readyState === WebSocket.OPEN)) return;
    if (!asrSettings.apiKey) {
      fail("缺少阿里云百炼 API Key。");
      client.close(1011, "Aliyun DashScope API key missing");
      return;
    }

    ready = false;
    seq = 1;
    lastText = "";
    upstreamStartedAt = 0;
    lastAudioSentAt = 0;
    const socket = new WebSocket(buildAliyunQwenRealtimeUrl(asrSettings), {
      headers: {
        Authorization: `Bearer ${asrSettings.apiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });
    upstream = socket;

    socket.on("open", () => {
      if (socket !== upstream || !sessionActive) {
        socket.close();
        return;
      }
      upstreamStartedAt = Date.now();
      socket.send(
        JSON.stringify({
          event_id: randomHex32(),
          type: "session.update",
          session: {
            modalities: ["text"],
            input_audio_format: "pcm",
            sample_rate: SAMPLE_RATE,
            input_audio_transcription: { language: "en" },
            turn_detection: {
              type: "server_vad",
              threshold: 0,
              silence_duration_ms: 400,
            },
          },
        }),
      );
      ready = true;
      flushAudio(false);
    });

    socket.on("message", (data) => {
      if (socket !== upstream || !sessionActive) return;
      const event = parseJsonMessage(data);
      if (!event) return;
      if (event.type === "error" || event.error) {
        fail(`阿里云百炼 ASR 错误: ${event.error?.message ?? event.message ?? JSON.stringify(event.error ?? event)}`);
        resetUpstream(socket);
        return;
      }
      handleTranscriptText(extractAliyunQwenTranscript(event));
    });

    socket.on("error", (error) => {
      fail(error instanceof Error ? error.message : String(error));
      resetUpstream(socket);
    });

    socket.on("close", () => {
      if (socket !== upstream) return;
      resetUpstream(socket, false);
    });
  }

  async function connectAliyunNls() {
    if (!sessionActive || client.readyState !== WebSocket.OPEN) return;
    if (upstream && (upstream.readyState === WebSocket.CONNECTING || upstream.readyState === WebSocket.OPEN)) return;
    if (!asrSettings.appKey || !asrSettings.accessToken) {
      fail("缺少阿里云 AppKey 或 Token。百炼实时 ASR 请填写 API Key。");
      client.close(1011, "Aliyun credentials missing");
      return;
    }

    ready = false;
    seq = 1;
    lastText = "";
    upstreamStartedAt = 0;
    lastAudioSentAt = 0;
    const taskId = randomHex32();
    const socket = new WebSocket(appendQuery(asrSettings.endpoint || "wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1", {
      token: asrSettings.accessToken,
    }));
    upstream = socket;

    socket.on("open", () => {
      if (socket !== upstream || !sessionActive) {
        socket.close();
        return;
      }
      upstreamStartedAt = Date.now();
      socket.send(
        JSON.stringify({
          header: {
            message_id: randomHex32(),
            task_id: taskId,
            namespace: "SpeechTranscriber",
            name: "StartTranscription",
            appkey: asrSettings.appKey,
          },
          payload: {
            format: "pcm",
            sample_rate: SAMPLE_RATE,
            enable_intermediate_result: true,
            enable_punctuation_prediction: true,
            enable_inverse_text_normalization: true,
          },
        }),
      );
    });

    socket.on("message", (data) => {
      if (socket !== upstream || !sessionActive) return;
      const event = parseJsonMessage(data);
      if (!event) return;
      if (event.header?.status && event.header.status !== 20000000) {
        fail(`阿里云 ASR 错误 ${event.header.status}: ${event.header.status_message ?? ""}`);
        resetUpstream(socket);
        return;
      }
      if (event.header?.name === "TranscriptionStarted") {
        ready = true;
        flushAudio(false);
        return;
      }
      handleTranscriptText(event.payload?.result ?? event.payload?.stash_result?.text);
    });

    socket.on("error", (error) => {
      fail(error instanceof Error ? error.message : String(error));
      resetUpstream(socket);
    });

    socket.on("close", () => {
      if (socket !== upstream) return;
      resetUpstream(socket, false);
    });
  }

  async function connectTencent() {
    if (!sessionActive || client.readyState !== WebSocket.OPEN) return;
    if (upstream && (upstream.readyState === WebSocket.CONNECTING || upstream.readyState === WebSocket.OPEN)) return;
    if (!asrSettings.appId || !asrSettings.secretId || !asrSettings.secretKey) {
      fail("缺少腾讯云 AppID、SecretId 或 SecretKey。");
      client.close(1011, "Tencent credentials missing");
      return;
    }

    ready = false;
    seq = 1;
    lastText = "";
    upstreamStartedAt = 0;
    lastAudioSentAt = 0;
    const socket = new WebSocket(buildTencentAsrUrl(asrSettings));
    upstream = socket;

    socket.on("open", () => {
      if (socket !== upstream || !sessionActive) {
        socket.close();
        return;
      }
      ready = true;
      upstreamStartedAt = Date.now();
      flushAudio(false);
    });

    socket.on("message", (data) => {
      if (socket !== upstream || !sessionActive) return;
      const event = parseJsonMessage(data);
      if (!event) return;
      if (event.code && event.code !== 0) {
        fail(`腾讯云 ASR 错误 ${event.code}: ${event.message ?? ""}`);
        resetUpstream(socket);
        return;
      }
      handleTranscriptText(event.result?.voice_text_str ?? event.Result?.voice_text_str ?? event.voice_text_str);
    });

    socket.on("error", (error) => {
      fail(error instanceof Error ? error.message : String(error));
      resetUpstream(socket);
    });

    socket.on("close", () => {
      if (socket !== upstream) return;
      resetUpstream(socket, false);
    });
  }

  async function connectBaidu() {
    if (!sessionActive || client.readyState !== WebSocket.OPEN) return;
    if (upstream && (upstream.readyState === WebSocket.CONNECTING || upstream.readyState === WebSocket.OPEN)) return;
    if (!asrSettings.appId || !asrSettings.appKey) {
      fail("缺少百度智能云 AppID 或 API Key。");
      client.close(1011, "Baidu credentials missing");
      return;
    }

    ready = false;
    seq = 1;
    lastText = "";
    upstreamStartedAt = 0;
    lastAudioSentAt = 0;
    const socket = new WebSocket(appendQuery(asrSettings.endpoint || "wss://vop.baidu.com/realtime_asr", { sn: randomUUID() }));
    upstream = socket;

    socket.on("open", () => {
      if (socket !== upstream || !sessionActive) {
        socket.close();
        return;
      }
      upstreamStartedAt = Date.now();
      socket.send(
        JSON.stringify({
          type: "START",
          data: {
            appid: Number(asrSettings.appId) || asrSettings.appId,
            appkey: asrSettings.appKey,
            dev_pid: Number(asrSettings.model) || 17372,
            cuid: `rvt-${randomUUID()}`,
            format: "pcm",
            sample: SAMPLE_RATE,
          },
        }),
      );
      ready = true;
      flushAudio(false);
    });

    socket.on("message", (data) => {
      if (socket !== upstream || !sessionActive) return;
      const event = parseJsonMessage(data);
      if (!event) return;
      if (event.err_no && event.err_no !== 0) {
        fail(`百度 ASR 错误 ${event.err_no}: ${event.err_msg ?? ""}`);
        resetUpstream(socket);
        return;
      }
      handleTranscriptText(extractBaiduTranscript(event));
    });

    socket.on("error", (error) => {
      fail(error instanceof Error ? error.message : String(error));
      resetUpstream(socket);
    });

    socket.on("close", () => {
      if (socket !== upstream) return;
      resetUpstream(socket, false);
    });
  }

  async function connectIflytek() {
    if (!sessionActive || client.readyState !== WebSocket.OPEN) return;
    if (upstream && (upstream.readyState === WebSocket.CONNECTING || upstream.readyState === WebSocket.OPEN)) return;
    if (!asrSettings.appId || !asrSettings.apiKey) {
      fail("缺少讯飞 AppID 或 API Key。");
      client.close(1011, "iFlytek credentials missing");
      return;
    }

    ready = false;
    seq = 1;
    lastText = "";
    upstreamStartedAt = 0;
    lastAudioSentAt = 0;
    const socket = new WebSocket(buildIflytekAsrUrl(asrSettings));
    upstream = socket;

    socket.on("open", () => {
      if (socket !== upstream || !sessionActive) {
        socket.close();
        return;
      }
      upstreamStartedAt = Date.now();
    });

    socket.on("message", (data) => {
      if (socket !== upstream || !sessionActive) return;
      const event = parseJsonMessage(data);
      if (!event) return;
      if (event.action === "started" && event.code === "0") {
        ready = true;
        flushAudio(false);
        return;
      }
      if (event.action === "error" || (event.code && event.code !== "0")) {
        fail(`讯飞 ASR 错误 ${event.code ?? ""}: ${event.desc ?? ""}`);
        resetUpstream(socket);
        return;
      }
      if (event.action === "result") {
        handleTranscriptText(extractIflytekTranscript(event));
      }
    });

    socket.on("error", (error) => {
      fail(error instanceof Error ? error.message : String(error));
      resetUpstream(socket);
    });

    socket.on("close", () => {
      if (socket !== upstream) return;
      resetUpstream(socket, false);
    });
  }

  function resetUpstream(socket = upstream, closeSocket = true) {
    if (socket && closeSocket && socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
      socket.close();
    }
    if (!socket || socket === upstream) {
      upstream = null;
      ready = false;
      sentWavHeader = false;
      upstreamStartedAt = 0;
      lastAudioSentAt = 0;
    }
  }

  client.on("message", (data, isBinary) => {
    if (!isBinary) {
      let event;
      try {
        event = JSON.parse(String(data));
      } catch {
        return;
      }

      if (event.type === "session.start") {
        sessionActive = true;
        resetUpstream(upstream);
        targetLanguage = event.targetLanguage || targetLanguage;
        asrSettings = resolveAsrSettings(event.asr);
        sessionTranslationConfig = resolveTranslationConfig(event.translation, translationProvider);
        captionId = `caption-${Date.now()}`;
        lastText = "";
        lastTranslatedText = "";
        processedCaptionFragmentKeys = new Set();
        processedCaptionFragmentKeyOrder = [];
        recentCaptionFragmentKeys = [];
        pendingCaptionFragments = [];
        pendingFragmentText = "";
        pendingFragmentFirstSeenAt = 0;
        captionRevision = 0;
        translationInFlightCount = 0;
        sentWavHeader = false;
        upstreamStartedAt = 0;
        lastAudioSentAt = 0;
        startKeepAliveTimer();
        void connectAsr();
      }

      if (event.type === "session.stop") {
        sessionActive = false;
        audioBuffer = Buffer.alloc(0);
        pendingCaptionFragments = [];
        pendingFragmentText = "";
        pendingFragmentFirstSeenAt = 0;
        stopFlushTimer();
        stopKeepAliveTimer();
        resetUpstream(upstream);
      }
      return;
    }

    if (!sessionActive) return;
    audioBuffer = Buffer.concat([audioBuffer, Buffer.from(data)]);
    if (audioBuffer.length > AUDIO_BUFFER_MAX_BYTES) {
      audioBuffer = audioBuffer.subarray(audioBuffer.length - AUDIO_BUFFER_MAX_BYTES);
    }
    flushAudio(false);
  });

  client.on("close", () => {
    sessionActive = false;
    audioBuffer = Buffer.alloc(0);
    pendingCaptionFragments = [];
    pendingFragmentText = "";
    pendingFragmentFirstSeenAt = 0;
    stopFlushTimer();
    stopKeepAliveTimer();
    resetUpstream(upstream);
  });

  function flushAudio(isLast) {
    if (!sessionActive) return;
    if (!ready || upstream?.readyState !== WebSocket.OPEN) {
      if (!upstream || upstream.readyState === WebSocket.CLOSED || upstream.readyState === WebSocket.CLOSING) {
        void connectAsr();
      }
      return;
    }

    while (audioBuffer.length >= AUDIO_SEGMENT_BYTES) {
      const segment = audioBuffer.subarray(0, AUDIO_SEGMENT_BYTES);
      audioBuffer = audioBuffer.subarray(AUDIO_SEGMENT_BYTES);
      sendAudioSegment(segment, false);
    }

    if (isLast && audioBuffer.length > 0) {
      sendAudioSegment(audioBuffer, true);
      audioBuffer = Buffer.alloc(0);
    }
  }

  function sendAudioSegment(segment, isLast) {
    if (!ready || upstream?.readyState !== WebSocket.OPEN) return false;
    try {
      if (asrSettings.provider === "volcengine") {
        upstream.send(buildAudioRequest(seq++, withWavHeaderIfNeeded(segment), isLast));
      } else if (asrSettings.provider === "aliyun" && usesAliyunQwenRealtime(asrSettings)) {
        sendAliyunQwenAudioSegment(segment);
      } else {
        sendRawPcmSegment(segment);
      }
      lastAudioSentAt = Date.now();
      return true;
    } catch {
      resetUpstream(upstream);
      return false;
    }
  }

  function sendAliyunQwenAudioSegment(segment) {
    upstream.send(
      JSON.stringify({
        event_id: randomHex32(),
        type: "input_audio_buffer.append",
        audio: Buffer.from(segment).toString("base64"),
      }),
    );
  }

  function sendRawPcmSegment(segment) {
    const chunkSize = asrSettings.provider === "iflytek" ? 1280 : asrSettings.provider === "aliyun" ? 3200 : segment.length;
    for (let offset = 0; offset < segment.length; offset += chunkSize) {
      upstream.send(segment.subarray(offset, offset + chunkSize));
    }
  }

  function handleTranscriptText(text) {
    const normalized = normalizeTranscriptSpacing(text);
    if (!normalized) {
      if (DEBUG_CAPTION) console.log("[caption-debug] ASR sent empty/null text, skipping");
      return;
    }
    if (normalized === lastText) {
      if (DEBUG_CAPTION) console.log(`[caption-debug] ASR sent duplicate text, skipping: "${normalized.slice(0, 60)}"`);
      return;
    }
    if (DEBUG_CAPTION) console.log(`[caption-debug] ASR text received: "${normalized.slice(0, 80)}" (len=${normalized.length})`);
    lastText = normalized;
    const prevPendingFragment = pendingFragmentText;
    const fragments = extractReadyCaptionFragments(normalized);
    if (DEBUG_CAPTION) console.log(`[caption-debug] extractReadyCaptionFragments produced ${fragments.length} fragment(s): ${JSON.stringify(fragments.map((f) => f.slice(0, 40)))}`);
    if (fragments.length > 0) {
      pendingFragmentText = "";
      pendingFragmentFirstSeenAt = 0;
      stopFlushTimer();
      enqueueCaptionFragments(fragments);
    } else {
      const trailing = extractTrailingText(normalized);
      if (DEBUG_CAPTION) console.log(`[caption-debug] No ready fragments, trailing pending: "${trailing.slice(0, 60)}" (len=${trailing.length})`);
      if (trailing && trailing !== pendingFragmentText) {
        pendingFragmentText = trailing;
        if (!pendingFragmentFirstSeenAt) pendingFragmentFirstSeenAt = Date.now();
        scheduleFlushTimer();
      } else if (normalized.length < (prevPendingFragment || "").length) {
        if (DEBUG_CAPTION) console.log(`[caption-debug] ASR text got shorter (${normalized.length} < ${(prevPendingFragment || "").length}), flushing pending`);
        flushPendingFragment();
      }
    }
  }

  function extractTrailingText(text) {
    const sentencePattern = /[^.!?。！？]+[.!?。！？]+/gu;
    let lastCompleteEnd = 0;
    let match;
    while ((match = sentencePattern.exec(text)) !== null) {
      lastCompleteEnd = sentencePattern.lastIndex;
    }
    const trailing = text.slice(lastCompleteEnd).trim();
    return trailing || text;
  }

  function flushPendingFragment() {
    if (!pendingFragmentText) return;
    if (DEBUG_CAPTION) console.log(`[caption-debug] Flushing pending fragment after timeout: "${pendingFragmentText.slice(0, 60)}" (len=${pendingFragmentText.length})`);
    const text = pendingFragmentText;
    pendingFragmentText = "";
    pendingFragmentFirstSeenAt = 0;
    stopFlushTimer();
    const key = normalizeCaptionForCompare(text);
    if (!key || processedCaptionFragmentKeys.has(key) || hasRecentCaptionFragment(key)) return;
    rememberCaptionFragmentKey(key);
    enqueueCaptionFragments([text]);
  }

  function scheduleFlushTimer() {
    stopFlushTimer();
    if (!pendingFragmentFirstSeenAt || !pendingFragmentText) return;
    const elapsed = Date.now() - pendingFragmentFirstSeenAt;
    const delay = Math.max(0, CAPTION_FLUSH_PENDING_MS - elapsed);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushPendingFragment();
    }, delay);
  }

  function stopFlushTimer() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  function startKeepAliveTimer() {
    stopKeepAliveTimer();
    keepAliveTimer = setInterval(() => {
      if (!sessionActive || client.readyState !== WebSocket.OPEN) return;

      if (shouldRotateUpstream()) {
        resetUpstream(upstream);
        void connectAsr();
        return;
      }

      if (!upstream || upstream.readyState === WebSocket.CLOSED || upstream.readyState === WebSocket.CLOSING) {
        void connectAsr();
        return;
      }

      if (!ready || upstream.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastAudioSentAt >= ASR_KEEPALIVE_IDLE_MS) {
        sendAudioSegment(Buffer.alloc(AUDIO_SEGMENT_BYTES), false);
      }
    }, ASR_KEEPALIVE_MS);
  }

  function stopKeepAliveTimer() {
    if (!keepAliveTimer) return;
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }

  function shouldRotateUpstream() {
    return Boolean(
      ASR_UPSTREAM_ROTATE_MS > 0 &&
        upstreamStartedAt > 0 &&
        Date.now() - upstreamStartedAt >= ASR_UPSTREAM_ROTATE_MS,
    );
  }

  function withWavHeaderIfNeeded(segment) {
    if (sentWavHeader) return segment;
    sentWavHeader = true;
    return Buffer.concat([buildStreamingWavHeader(), segment]);
  }

function enqueueCaptionFragments(fragments) {
    if (fragments.length === 0) return;
    if (DEBUG_CAPTION) console.log(`[caption-debug] Enqueueing ${fragments.length} fragment(s), total pending: ${pendingCaptionFragments.length + fragments.length}`);
    pendingCaptionFragments.push(...fragments);
    if (pendingCaptionFragments.length > CAPTION_PENDING_FRAGMENT_LIMIT) {
      const dropped = pendingCaptionFragments.length - CAPTION_PENDING_FRAGMENT_LIMIT;
      if (DEBUG_CAPTION) console.log(`[caption-debug] WARNING: pending queue overflow, dropping ${dropped} oldest fragment(s)`);
      pendingCaptionFragments = pendingCaptionFragments.slice(-CAPTION_PENDING_FRAGMENT_LIMIT);
    }
    void runCaptionTranslationQueue();
  }

  let translationInFlightCount = 0;

  async function runCaptionTranslationQueue() {
    while (pendingCaptionFragments.length > 0 && translationInFlightCount < CAPTION_TRANSLATION_CONCURRENCY) {
      const text = pendingCaptionFragments.shift();
      if (!text) break;
      translationInFlightCount += 1;
      void (async () => {
        try {
          if (DEBUG_CAPTION) console.log(`[caption-debug] Translating: "${text.slice(0, 60)}" (len=${text.length})`);
          const translatedText = await translateTextWithTimeout(text, targetLanguage, SUBTITLE_TRANSLATION_TIMEOUT_MS, sessionTranslationConfig);
          lastTranslatedText = translatedText;
          captionRevision += 1;
          if (DEBUG_CAPTION) console.log(`[caption-debug] Translation result: "${(translatedText || "").slice(0, 60)}" (len=${(translatedText || "").length}), pending=${pendingCaptionFragments.length}`);
          sendCaption(text, translatedText, true, captionRevision);
        } catch {
          // Keep ASR captions flowing even when translation provider is temporarily slow.
        } finally {
          translationInFlightCount -= 1;
          if (pendingCaptionFragments.length > 0) void runCaptionTranslationQueue();
        }
      })();
    }
  }

  function extractReadyCaptionFragments(text) {
    const fragments = buildCaptionFragments(text);
    const readyFragments = [];

    for (const fragment of fragments) {
      const key = normalizeCaptionForCompare(fragment);
      if (!key) {
        if (DEBUG_CAPTION) console.log(`[caption-debug] Fragment skipped: empty key for "${fragment.slice(0, 40)}"`);
        continue;
      }
      if (processedCaptionFragmentKeys.has(key)) {
        if (DEBUG_CAPTION) console.log(`[caption-debug] Fragment skipped: already processed "${key.slice(0, 40)}"`);
        continue;
      }
      if (hasRecentCaptionFragment(key)) {
        if (DEBUG_CAPTION) console.log(`[caption-debug] Fragment skipped: near-duplicate "${key.slice(0, 40)}"`);
        continue;
      }
      rememberCaptionFragmentKey(key);
      readyFragments.push(fragment);
    }

    return readyFragments;
  }

  function rememberCaptionFragmentKey(key) {
    processedCaptionFragmentKeys.add(key);
    processedCaptionFragmentKeyOrder.push(key);
    recentCaptionFragmentKeys.push(key);
    recentCaptionFragmentKeys = recentCaptionFragmentKeys.slice(-CAPTION_RECENT_FRAGMENT_LIMIT);

    while (processedCaptionFragmentKeyOrder.length > CAPTION_PROCESSED_FRAGMENT_LIMIT) {
      const staleKey = processedCaptionFragmentKeyOrder.shift();
      if (staleKey) processedCaptionFragmentKeys.delete(staleKey);
    }
  }

  function hasRecentCaptionFragment(key) {
    return recentCaptionFragmentKeys.some((existingKey) => {
      if (existingKey === key) return true;
      return isNearDuplicateCaptionKey(existingKey, key);
    });
  }
});

server.listen(port, () => {
  console.log(`Realtime ASR translation service listening on ws://localhost:${port}/realtime`);
  console.log(`ASR provider: ${defaultAsrSettings.provider}`);
  console.log(`Resource ID: ${defaultAsrSettings.resourceId}`);
  if (!defaultAsrSettings.appId || !defaultAsrSettings.accessToken) {
    console.warn("VOLCENGINE_APP_ID or VOLCENGINE_ACCESS_TOKEN is missing.");
  }
});

async function handleHttpRequest(request, response) {
  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders());
    response.end();
    return;
  }

  if (request.method === "POST" && request.url?.startsWith("/translate-pdf")) {
    const body = await readJsonBody(request);
    const pdfUrl = String(body.url || "");
    const title = String(body.title || "PDF translation");
    const targetLanguage = String(body.targetLanguage || "zh-CN");
    const translationConfig = resolveTranslationConfig(body.translation, pdfTranslationProvider);
    const result = await translatePdf(pdfUrl, title, targetLanguage, translationConfig);
    response.writeHead(200, { ...corsHeaders(), "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, ...result }));
    return;
  }

  if (request.method === "POST" && request.url?.startsWith("/translate")) {
    const body = await readJsonBody(request);
    const texts = Array.isArray(body.texts) ? body.texts.map((text) => String(text)) : [];
    const targetLanguage = String(body.targetLanguage || "zh-CN");
    const translationConfig = resolveTranslationConfig(body.translation, pageTranslationProvider);
    const translations = await translateTexts(texts, targetLanguage, undefined, translationConfig, "page");
    response.writeHead(200, { ...corsHeaders(), "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, translations }));
    return;
  }

  response.writeHead(200, { ...corsHeaders(), "content-type": "application/json" });
  response.end(
    JSON.stringify({
      ok: true,
      service: "hear-me-out",
      provider: "volcengine",
      translationProvider,
      pageTranslationProvider,
      pdfTranslationProvider,
      aiTranslationConfigured: Boolean(aiTranslationApiKey),
      websocket: `ws://localhost:${port}/realtime`,
      appIdConfigured: Boolean(defaultAsrSettings.appId),
      accessTokenConfigured: Boolean(defaultAsrSettings.accessToken),
      resourceId: defaultAsrSettings.resourceId,
    }),
  );
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 512_000) {
        reject(new Error("Request body too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function buildHeader(messageType, flags) {
  return Buffer.from([
    (ProtocolVersion.V1 << 4) | 1,
    (messageType << 4) | flags,
    (Serialization.JSON << 4) | Compression.GZIP,
    0x00,
  ]);
}

function buildFullClientRequest(sequence) {
  const payload = {
    user: { uid: "hear-me-out" },
    audio: {
      format: "wav",
      codec: "raw",
      rate: SAMPLE_RATE,
      bits: 16,
      channel: 1,
    },
    request: {
      model_name: "bigmodel",
      enable_itn: true,
      enable_punc: true,
      enable_ddc: true,
      show_utterances: true,
      enable_nonstream: false,
    },
  };

  return buildPacket(MessageType.CLIENT_FULL_REQUEST, Flags.POS_SEQUENCE, sequence, gzipSync(JSON.stringify(payload)));
}

function buildAudioRequest(sequence, pcm, isLast) {
  const flags = isLast ? Flags.NEG_WITH_SEQUENCE : Flags.POS_SEQUENCE;
  const actualSequence = isLast ? -Math.abs(sequence) : sequence;
  return buildPacket(MessageType.CLIENT_AUDIO_ONLY_REQUEST, flags, actualSequence, gzipSync(pcm));
}

function buildStreamingWavHeader() {
  const header = Buffer.alloc(44);
  const dataSize = 0x7fffffff;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(dataSize + 36, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);
  return header;
}

function buildPacket(messageType, flags, sequence, payload) {
  const packet = Buffer.alloc(12 + payload.length);
  buildHeader(messageType, flags).copy(packet, 0);
  packet.writeInt32BE(sequence, 4);
  packet.writeUInt32BE(payload.length, 8);
  payload.copy(packet, 12);
  return packet;
}

function parseVolcengineResponse(message) {
  const headerSize = (message[0] & 0x0f) * 4;
  const messageType = message[1] >> 4;
  const flags = message[1] & 0x0f;
  const serialization = message[2] >> 4;
  const compression = message[2] & 0x0f;

  let offset = headerSize;
  const response = {
    code: 0,
    isLastPackage: Boolean(flags & 0x02),
    payloadSequence: 0,
    payloadSize: 0,
    payloadMsg: null,
  };

  if (flags & 0x01) {
    response.payloadSequence = message.readInt32BE(offset);
    offset += 4;
  }

  if (flags & 0x04) {
    offset += 4;
  }

  if (messageType === MessageType.SERVER_FULL_RESPONSE) {
    response.payloadSize = message.readUInt32BE(offset);
    offset += 4;
  } else if (messageType === MessageType.SERVER_ERROR_RESPONSE) {
    response.code = message.readInt32BE(offset);
    response.payloadSize = message.readUInt32BE(offset + 4);
    offset += 8;
  }

  let payload = message.subarray(offset, offset + response.payloadSize);
  if (payload.length === 0) return response;

  if (compression === Compression.GZIP) {
    payload = gunzipSync(payload);
  }

  if (serialization === Serialization.JSON) {
    response.payloadMsg = JSON.parse(payload.toString("utf8"));
  }

  return response;
}

function extractTranscript(payload) {
  if (!payload) return "";
  if (typeof payload.result?.text === "string") return payload.result.text.trim();

  const utterances = payload.result?.utterances;
  if (Array.isArray(utterances) && utterances.length > 0) {
    return utterances
      .map((item) => item.text)
      .filter(Boolean)
      .join("")
      .trim();
  }

  return "";
}

function normalizeTranscriptSpacing(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function buildCaptionFragments(text) {
  const normalized = normalizeTranscriptSpacing(text);
  if (!normalized || looksLikeBackendErrorText(normalized)) return [];

  const fragments = [];
  const sentencePattern = /[^.!?。！？]+[.!?。！？]+/gu;
  let match;
  let lastCompleteEnd = 0;

  while ((match = sentencePattern.exec(normalized)) !== null) {
    const sentence = match[0].trim();
    lastCompleteEnd = sentencePattern.lastIndex;
    fragments.push(...splitReadableCaptionFragment(sentence, true));
  }

  const trailing = normalized.slice(lastCompleteEnd).trim();
  if (trailing && isReadyCaptionFragment(trailing)) {
    fragments.push(...splitReadableCaptionFragment(trailing, false));
  }

  if (fragments.length > 0) return fragments;
  if (!isReadyCaptionFragment(normalized)) return [];
  return splitReadableCaptionFragment(normalized, false);
}

function splitReadableCaptionFragment(text, allowShort) {
  const normalized = normalizeTranscriptSpacing(text);
  if (!normalized) return [];

  const words = normalized.split(/\s+/);
  if (words.length <= CAPTION_FRAGMENT_MAX_WORDS && normalized.length <= CAPTION_FRAGMENT_MAX_CHARS) {
    return isReadySplitFragment(normalized, allowShort) ? [normalized] : [];
  }

  const phraseParts = normalized.split(/(?<=[,;:，；：])\s*/u).map((part) => part.trim()).filter(Boolean);
  const fragments = [];
  let current = "";

  for (const part of phraseParts.length > 1 ? phraseParts : words) {
    const separator = phraseParts.length > 1 ? " " : " ";
    const candidate = current ? `${current}${separator}${part}` : part;
    if (candidate.length <= CAPTION_FRAGMENT_MAX_CHARS && countWords(candidate) <= CAPTION_FRAGMENT_MAX_WORDS) {
      current = candidate;
      continue;
    }

    if (current && isReadySplitFragment(current, allowShort)) fragments.push(current);
    current = "";

    if (countWords(part) > CAPTION_FRAGMENT_MAX_WORDS || part.length > CAPTION_FRAGMENT_MAX_CHARS) {
      fragments.push(...splitCaptionByWords(part, allowShort));
    } else {
      current = part;
    }
  }

  if (current && isReadySplitFragment(current, allowShort)) fragments.push(current);
  return fragments;
}

function splitCaptionByWords(text, allowShort) {
  const words = normalizeTranscriptSpacing(text).split(/\s+/).filter(Boolean);
  const fragments = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= CAPTION_FRAGMENT_MAX_CHARS && countWords(candidate) <= CAPTION_FRAGMENT_MAX_WORDS) {
      current = candidate;
      continue;
    }
    if (current && isReadySplitFragment(current, allowShort)) fragments.push(current);
    current = word;
  }

  if (current && isReadySplitFragment(current, allowShort)) fragments.push(current);
  return fragments;
}

function isReadySplitFragment(text, allowShort) {
  const normalized = normalizeTranscriptSpacing(text);
  if (!normalized) return false;
  if (allowShort && /[.!?。！？]\s*$/u.test(normalized)) {
    return normalized.length >= CAPTION_MIN_COMPLETE_CHARS || countWords(normalized) >= CAPTION_MIN_COMPLETE_WORDS;
  }
  return isReadyCaptionFragment(normalized);
}

function isReadyCaptionFragment(text) {
  const normalized = normalizeTranscriptSpacing(text);
  if (!normalized) return false;
  if (/[.!?。！？]\s*$/u.test(normalized)) {
    return normalized.length >= CAPTION_MIN_COMPLETE_CHARS || countWords(normalized) >= CAPTION_MIN_COMPLETE_WORDS;
  }
  return normalized.length >= CAPTION_FRAGMENT_MAX_CHARS || countWords(normalized) >= CAPTION_FRAGMENT_MAX_WORDS;
}

function countWords(text) {
  const words = String(text).trim().match(/\S+/g);
  return words?.length ?? 0;
}

let microsoftToken = null;
let microsoftTokenExpiresAt = 0;
const translationCache = new Map();

async function translateText(text, targetLanguage, signal, config) {
  const [translation] = await translateTexts([text], targetLanguage, signal, config);
  return translation ?? "";
}

async function translateTextWithTimeout(text, targetLanguage, timeoutMs, config) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await translateText(text, targetLanguage, controller.signal, config);
  } finally {
    clearTimeout(timer);
  }
}

async function translatePdf(pdfUrl, title, targetLanguage, config = resolveTranslationConfig(undefined, pdfTranslationProvider)) {
  const data = await loadPdfData(pdfUrl);
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText();
    const paragraphs = normalizePdfParagraphs(result.text);
    if (paragraphs.length === 0) {
      throw new Error("No selectable text was found in this PDF. Scanned PDFs need OCR support.");
    }

    const translations = await translateDocumentTexts(paragraphs, targetLanguage, config);

    return {
      title,
      sourceUrl: pdfUrl,
      paragraphs: paragraphs.map((source, index) => ({
        source,
        translation: translations[index] || "",
      })),
    };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

async function loadPdfData(pdfUrl) {
  if (!pdfUrl) throw new Error("Missing PDF URL.");
  const url = new URL(pdfUrl);
  if (url.protocol === "file:") {
    return new Uint8Array(await readFileAsync(fileURLToPath(url)));
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported PDF URL protocol: ${url.protocol}`);
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to download PDF: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function readFileAsync(path) {
  return new Promise((resolve, reject) => {
    readFile(path, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

function normalizePdfParagraphs(text) {
  const blocks = String(text || "")
    .replace(/\r/g, "")
    .split(/\n{2,}/)
    .flatMap((block) => splitLongPdfParagraph(block.replace(/\n+/g, " ").replace(/\s+/g, " ").trim()))
    .map((block) => block.trim())
    .filter((block) => block.length >= 2);

  return blocks.slice(0, PDF_MAX_PARAGRAPHS);
}

function splitLongPdfParagraph(text) {
  if (!text) return [];
  if (text.length <= PDF_MAX_PARAGRAPH_CHARS) return [text];

  const sentences = text.split(/(?<=[.!?。！？])\s+/);
  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length <= PDF_MAX_PARAGRAPH_CHARS) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (sentence.length <= PDF_MAX_PARAGRAPH_CHARS) {
      current = sentence;
      continue;
    }
    for (let index = 0; index < sentence.length; index += PDF_MAX_PARAGRAPH_CHARS) {
      chunks.push(sentence.slice(index, index + PDF_MAX_PARAGRAPH_CHARS));
    }
    current = "";
  }
  if (current) chunks.push(current);
  return chunks;
}

async function translateDocumentTexts(paragraphs, targetLanguage, configInput) {
  const config = resolveTranslationConfig(configInput, pdfTranslationProvider);
  if (config.provider === "accurate") {
    return translateDocumentTextsWithContext(paragraphs, targetLanguage, config);
  }

  const translations = Array.from({ length: paragraphs.length }, () => "");
  const batches = [];
  for (let index = 0; index < paragraphs.length; index += PDF_TRANSLATION_BATCH_SIZE) {
    batches.push({ start: index, texts: paragraphs.slice(index, index + PDF_TRANSLATION_BATCH_SIZE) });
  }

  let nextBatchIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(PDF_TRANSLATION_CONCURRENCY, batches.length) }, async () => {
      while (nextBatchIndex < batches.length) {
        const batch = batches[nextBatchIndex];
        nextBatchIndex += 1;
        if (!batch) continue;
        const batchTranslations = await translateTexts(batch.texts, targetLanguage, undefined, config, "document");
        batchTranslations.forEach((translation, index) => {
          translations[batch.start + index] = translation;
        });
      }
    }),
  );

  return translations;
}

async function translateTexts(texts, targetLanguage, signal, configInput = translationProvider, profile = "subtitle") {
  const cleanTexts = texts.map((text) => String(text ?? ""));
  if (cleanTexts.length === 0) return [];
  if (cleanTexts.every((text) => !text.trim())) return cleanTexts.map(() => "");
  const config = resolveTranslationConfig(configInput, translationProvider);
  if (config.provider === "ai" || isAiTranslationProvider(config.provider)) {
    return translateTextsWithAi(cleanTexts, targetLanguage, signal, { profile, config });
  }
  if (config.provider === "balanced") return translateTextsBalanced(cleanTexts, targetLanguage, signal, config);
  if (config.provider === "accurate") return translateTextsAccurate(cleanTexts, targetLanguage, signal, config);
  return translateTextsWithMicrosoft(cleanTexts, targetLanguage, signal);
}

async function translateTextsBalanced(cleanTexts, targetLanguage, signal, config) {
  if (!config.apiKey || !config.baseUrl || !config.model) return translateTextsWithMicrosoft(cleanTexts, targetLanguage, signal);
  const aiTranslations = await translateTextsWithAi(cleanTexts, targetLanguage, signal, { profile: "page", config });
  const hasAiResult = aiTranslations.some((t) => t && t.trim());
  if (hasAiResult) {
    const missing = aiTranslations.reduce((count, t, i) => count + (!t || !t.trim() ? 1 : 0), 0);
    if (missing > 0 && missing < cleanTexts.length) {
      const microsoftTranslations = await translateTextsWithMicrosoft(
        cleanTexts.filter((_t, i) => !aiTranslations[i] || !aiTranslations[i].trim()),
        targetLanguage,
        signal,
      );
      let msIndex = 0;
      return aiTranslations.map((t, i) => {
        if (t && t.trim()) return t;
        return microsoftTranslations[msIndex++] || cleanTexts[i] || "";
      });
    }
    return aiTranslations.map((t, i) => t || cleanTexts[i] || "");
  }
  return translateTextsWithMicrosoft(cleanTexts, targetLanguage, signal);
}

async function translateTextsAccurate(cleanTexts, targetLanguage, signal, config) {
  if (!config.apiKey || !config.baseUrl || !config.model) return translateTextsWithMicrosoft(cleanTexts, targetLanguage, signal);
  const aiTranslations = await translateTextsWithAi(cleanTexts, targetLanguage, signal, { profile: "document", config });
  const hasAiResult = aiTranslations.some((t) => t && t.trim());
  if (hasAiResult) {
    const missing = aiTranslations.reduce((count, t, i) => count + (!t || !t.trim() ? 1 : 0), 0);
    if (missing > 0 && missing < cleanTexts.length) {
      const microsoftTranslations = await translateTextsWithMicrosoft(
        cleanTexts.filter((_t, i) => !aiTranslations[i] || !aiTranslations[i].trim()),
        targetLanguage,
        signal,
      );
      let msIndex = 0;
      return aiTranslations.map((t, i) => {
        if (t && t.trim()) return t;
        return microsoftTranslations[msIndex++] || cleanTexts[i] || "";
      });
    }
    return aiTranslations.map((t, i) => t || cleanTexts[i] || "");
  }
  return translateTextsWithMicrosoft(cleanTexts, targetLanguage, signal);
}

async function translateTextsWithMicrosoft(cleanTexts, targetLanguage, signal) {
  const cached = getCachedTranslations(cleanTexts, targetLanguage, "microsoft");
  if (cached.complete) return cached.translations;

  const token = await getMicrosoftToken(signal);
  const response = await fetch(
    `https://api-edge.cognitive.microsofttranslator.com/translate?from=&to=${encodeURIComponent(targetLanguage)}&api-version=3.0&includeSentenceLength=true&textType=plain`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(cleanTexts.map((text) => ({ Text: text }))),
      signal,
    },
  );

  if (!response.ok) return cleanTexts.map((_text, index) => cached.translations[index] ?? "");
  const result = await response.json();
  const translations = cleanTexts.map((_text, index) => result?.[index]?.translations?.[0]?.text ?? cached.translations[index] ?? "");
  setCachedTranslations(cleanTexts, targetLanguage, "microsoft", translations);
  return translations;
}

async function translateTextsWithAi(cleanTexts, targetLanguage, signal, options = {}) {
  const config = resolveTranslationConfig(options.config ?? "ai", translationProvider);
  if (!config.apiKey || !config.baseUrl || !config.model) {
    return translateTextsWithMicrosoft(cleanTexts, targetLanguage, signal);
  }

  const profile = options.profile ?? "subtitle";
  const cacheProvider = `ai:${config.provider}:${config.protocol}:${config.baseUrl}:${config.model}:${profile}`;
  const cached = getCachedTranslations(cleanTexts, targetLanguage, cacheProvider);
  if (cached.complete) return cached.translations;

  if (config.protocol === "anthropic") {
    return translateTextsWithAnthropicAi(cleanTexts, targetLanguage, signal, {
      ...options,
      config,
      cached,
      cacheProvider,
      profile,
    });
  }

  const requestBody = {
    model: config.model,
    temperature: 0,
    stream: false,
    messages: [
      {
        role: "system",
        content: getAiTranslationSystemPrompt(profile, targetLanguage),
      },
      {
        role: "user",
        content: JSON.stringify(cleanTexts),
      },
    ],
  };

  if (config.disableThinking && isReasoningModel(config.model)) {
    requestBody.thinking = { type: "disabled" };
  }

  const response = await fetch(toChatCompletionsUrl(config.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...getAiAuthHeaders(config),
    },
    body: JSON.stringify(requestBody),
    signal,
  });

  if (!response.ok) {
    return cleanTexts.map((_text, index) => cached.translations[index] ?? "");
  }
  const result = await response.json();
  const raw = result?.choices?.[0]?.message?.content ?? "";
  const translations = coerceJsonArray(raw, cleanTexts.length).map((text, index) => text || cached.translations[index] || "");
  setCachedTranslations(cleanTexts, targetLanguage, cacheProvider, translations);
  return translations;
}

async function translateTextsWithAnthropicAi(cleanTexts, targetLanguage, signal, options) {
  const { config, cached, cacheProvider, profile } = options;
  const requestBody = {
    model: config.model,
    max_tokens: 8192,
    temperature: 0,
    system: getAiTranslationSystemPrompt(profile, targetLanguage),
    messages: [
      {
        role: "user",
        content: JSON.stringify(cleanTexts),
      },
    ],
  };

  const response = await fetch(toAnthropicMessagesUrl(config.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...getAiAuthHeaders(config, "anthropic"),
    },
    body: JSON.stringify(requestBody),
    signal,
  });

  if (!response.ok) {
    return cleanTexts.map((_text, index) => cached.translations[index] ?? "");
  }
  const result = await response.json();
  const raw = extractAnthropicText(result);
  const translations = coerceJsonArray(raw, cleanTexts.length).map((text, index) => text || cached.translations[index] || "");
  setCachedTranslations(cleanTexts, targetLanguage, cacheProvider, translations);
  return translations;
}

async function translateDocumentTextsWithContext(paragraphs, targetLanguage, config) {
  if (!config.apiKey || !config.baseUrl || !config.model) {
    return translateDocumentTexts(paragraphs, targetLanguage, "microsoft");
  }

  const translations = Array.from({ length: paragraphs.length }, () => "");
  const batches = [];
  for (let index = 0; index < paragraphs.length; index += PDF_TRANSLATION_BATCH_SIZE) {
    const start = index;
    const end = Math.min(paragraphs.length, index + PDF_TRANSLATION_BATCH_SIZE);
    batches.push({
      start,
      end,
      before: paragraphs.slice(Math.max(0, start - PDF_CONTEXT_PARAGRAPHS), start),
      texts: paragraphs.slice(start, end),
      after: paragraphs.slice(end, Math.min(paragraphs.length, end + PDF_CONTEXT_PARAGRAPHS)),
    });
  }

  let nextBatchIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(PDF_TRANSLATION_CONCURRENCY, batches.length) }, async () => {
      while (nextBatchIndex < batches.length) {
        const batch = batches[nextBatchIndex];
        nextBatchIndex += 1;
        if (!batch) continue;
        const batchTranslations = await translateTextsWithAiDocumentContext(batch, targetLanguage, config);
        batchTranslations.forEach((translation, index) => {
          translations[batch.start + index] = translation || batch.texts[index] || "";
        });
      }
    }),
  );

  return translations;
}

async function translateTextsWithAiDocumentContext(batch, targetLanguage, config) {
  const cacheProvider = `ai:${config.provider}:${config.protocol}:${config.baseUrl}:${config.model}:document-context`;
  const cached = getCachedTranslations(batch.texts, targetLanguage, cacheProvider);
  if (cached.complete) return cached.translations;

  if (config.protocol === "anthropic") {
    const response = await fetch(toAnthropicMessagesUrl(config.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        ...getAiAuthHeaders(config, "anthropic"),
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 8192,
        temperature: 0,
        system:
          "You are a careful document translator. Translate ONLY the target paragraphs into natural, accurate Simplified Chinese. Use the preceding and following context to resolve pronouns, tense, terminology, and paragraph meaning. Preserve names, numbers, citations, product names, commands, file paths, and code-like text. Do not summarize, omit, expand, or add commentary. Return only JSON in this exact shape: {\"translations\":[\"...\"]}. The translations array must have exactly the same length and order as targetParagraphs.",
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              targetLanguage,
              contextBefore: batch.before,
              targetParagraphs: batch.texts,
              contextAfter: batch.after,
            }),
          },
        ],
      }),
    });

    if (!response.ok) {
      return translateTextsWithMicrosoft(batch.texts, targetLanguage);
    }
    const result = await response.json();
    const raw = extractAnthropicText(result);
    const translations = coerceJsonArray(raw, batch.texts.length).map((text, index) => text || cached.translations[index] || "");
    setCachedTranslations(batch.texts, targetLanguage, cacheProvider, translations);
    return translations;
  }

  const requestBody = {
    model: config.model,
    temperature: 0,
    stream: false,
    messages: [
      {
        role: "system",
        content:
          "You are a careful document translator. Translate ONLY the target paragraphs into natural, accurate Simplified Chinese. Use the preceding and following context to resolve pronouns, tense, terminology, and paragraph meaning. Preserve names, numbers, citations, product names, commands, file paths, and code-like text. Do not summarize, omit, expand, or add commentary. Return only JSON in this exact shape: {\"translations\":[\"...\"]}. The translations array must have exactly the same length and order as targetParagraphs.",
      },
      {
        role: "user",
        content: JSON.stringify({
          targetLanguage,
          contextBefore: batch.before,
          targetParagraphs: batch.texts,
          contextAfter: batch.after,
        }),
      },
    ],
  };

  if (config.disableThinking && isReasoningModel(config.model)) {
    requestBody.thinking = { type: "disabled" };
  }

  const response = await fetch(toChatCompletionsUrl(config.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...getAiAuthHeaders(config),
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    return translateTextsWithMicrosoft(batch.texts, targetLanguage);
  }

  const result = await response.json();
  const raw = result?.choices?.[0]?.message?.content ?? "";
  const translations = coerceJsonArray(raw, batch.texts.length).map((text, index) => text || cached.translations[index] || "");
  setCachedTranslations(batch.texts, targetLanguage, cacheProvider, translations);
  return translations;
}

function getAiTranslationSystemPrompt(profile, targetLanguage) {
  const target = targetLanguage === "zh-TW" ? "Traditional Chinese" : targetLanguage === "en" ? "English" : "Simplified Chinese";
  if (profile === "page") {
    return `You are a fast but accurate webpage translation engine. Translate into ${target}. Keep the meaning precise and natural. Preserve UI labels when they are already proper nouns, product names, code, commands, file paths, URLs, version numbers, and technical terms. Use nearby items in the same input array as context, but return one translation per input item. Return only JSON in this shape: {"translations":["..."]}. The translations array must have the same length and order as the input array.`;
  }

  if (profile === "document") {
    return `You are an accurate document translation engine. Translate into ${target}. Preserve paragraph meaning, discourse relations, names, numbers, technical terms, citations, and code-like text. Do not summarize or omit. Return only JSON in this shape: {"translations":["..."]}. The translations array must have the same length and order as the input array.`;
  }

  return `You are a low-latency subtitle translation engine. Translate into ${target}. Use concise spoken subtitle phrasing. Do not explain, expand, summarize, or add context. Prefer short Chinese clauses that can fit on one subtitle line. Do not add Chinese full stops or English periods at the end of subtitle clauses; keep question marks and exclamation marks only when they are semantically necessary. Preserve names, numbers, and technical terms. Return only JSON in this shape: {"translations":["..."]}. The translations array must have the same length and order as the input array.`;
}

async function getMicrosoftToken(signal) {
  if (microsoftToken && Date.now() < microsoftTokenExpiresAt) return microsoftToken;
  const response = await fetch("https://edge.microsoft.com/translate/auth", { signal });
  if (!response.ok) throw new Error(`Microsoft translate auth failed: ${response.status}`);
  microsoftToken = await response.text();
  microsoftTokenExpiresAt = Date.now() + 8 * 60 * 1000;
  return microsoftToken;
}

function resolveAsrSettings(input = {}) {
  const provider = normalizeAsrProvider(input.provider || defaultAsrSettings.provider);
  return {
    ...defaultAsrSettings,
    ...input,
    provider,
    appId: input.appId || defaultAsrSettings.appId || "",
    accessToken: input.accessToken || defaultAsrSettings.accessToken || "",
    apiKey: input.apiKey || defaultAsrSettings.apiKey || "",
    apiSecret: input.apiSecret || defaultAsrSettings.apiSecret || "",
    secretId: input.secretId || defaultAsrSettings.secretId || "",
    secretKey: input.secretKey || defaultAsrSettings.secretKey || "",
    appKey: input.appKey || defaultAsrSettings.appKey || "",
    resourceId: input.resourceId || defaultAsrSettings.resourceId || resourceId,
    endpoint: input.endpoint || defaultAsrSettings.endpoint || volcUrl,
    model: input.model || defaultAsrSettings.model || "",
  };
}

function normalizeAsrProvider(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["aliyun", "ali", "alibaba", "nls"].includes(normalized)) return "aliyun";
  if (["tencent", "tencentcloud", "qcloud"].includes(normalized)) return "tencent";
  if (["baidu", "baiducloud"].includes(normalized)) return "baidu";
  if (["iflytek", "xfyun", "xunfei"].includes(normalized)) return "iflytek";
  return "volcengine";
}

function getAsrProviderLabel(provider) {
  if (provider === "aliyun") return "阿里云百炼 / NLS";
  if (provider === "tencent") return "腾讯云 ASR";
  if (provider === "baidu") return "百度智能云 ASR";
  if (provider === "iflytek") return "科大讯飞实时转写";
  return "火山引擎 / 豆包 2.0";
}

function usesAliyunQwenRealtime(settings) {
  if (settings.provider !== "aliyun") return false;
  if (String(settings.model || "").toLowerCase().startsWith("qwen")) return true;
  if (String(settings.endpoint || "").includes("/realtime")) return true;
  return Boolean(settings.apiKey && !settings.appKey);
}

function buildAliyunQwenRealtimeUrl(settings) {
  const endpoint = settings.endpoint || "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
  return appendQuery(endpoint, { model: settings.model || "qwen3-asr-flash-realtime" });
}

function parseJsonMessage(data) {
  try {
    return JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
  } catch {
    return null;
  }
}

function appendQuery(endpoint, params) {
  const url = new URL(endpoint);
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    url.searchParams.set(key, String(value));
  });
  return url.toString();
}

function randomHex32() {
  return randomUUID().replace(/-/g, "");
}

function buildTencentAsrUrl(settings) {
  const endpoint = new URL(settings.endpoint || "wss://asr.cloud.tencent.com/asr/v2");
  const basePath = endpoint.pathname.replace(/\/+$/g, "") || "/asr/v2";
  const path = `${basePath}/${settings.appId}`.replace(/\/+/g, "/");
  const timestamp = Math.floor(Date.now() / 1000);
  const query = {
    secretid: settings.secretId,
    timestamp,
    expired: timestamp + 24 * 60 * 60,
    nonce: Math.floor(Math.random() * 1_000_000_000),
    engine_model_type: settings.model || "16k_en",
    voice_id: randomUUID(),
    voice_format: 1,
    needvad: 1,
    filter_dirty: 0,
    filter_modal: 0,
    filter_punc: 1,
    filter_empty_result: 1,
    convert_num_mode: 1,
    word_info: 0,
  };
  const signText = `${endpoint.host}${path}?${toSortedQuery(query)}`;
  const signature = createHmac("sha1", settings.secretKey).update(signText).digest("base64");
  const url = new URL(`${endpoint.protocol}//${endpoint.host}${path}`);
  Object.entries({ ...query, signature }).forEach(([key, value]) => {
    url.searchParams.set(key, String(value));
  });
  return url.toString();
}

function buildIflytekAsrUrl(settings) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const md5 = createHash("md5").update(`${settings.appId}${ts}`).digest("hex");
  const signa = createHmac("sha1", settings.apiKey).update(md5).digest("base64");
  return appendQuery(settings.endpoint || "wss://rtasr.xfyun.cn/v1/ws", {
    appid: settings.appId,
    ts,
    signa,
    lang: settings.model || "en",
  });
}

function toSortedQuery(params) {
  return Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
}

function extractBaiduTranscript(event) {
  if (Array.isArray(event.result)) return event.result.join("");
  if (typeof event.result === "string") return event.result;
  if (Array.isArray(event.data?.result)) return event.data.result.join("");
  if (typeof event.data?.result === "string") return event.data.result;
  if (typeof event.data?.text === "string") return event.data.text;
  return "";
}

function extractAliyunQwenTranscript(event) {
  if (typeof event.transcript === "string") return event.transcript;
  if (typeof event.text === "string") return event.text;
  if (typeof event.output?.text === "string") return event.output.text;
  if (typeof event.payload?.output?.text === "string") return event.payload.output.text;
  if (event.type === "conversation.item.input_audio_transcription.completed") {
    return String(event.transcript ?? event.item?.transcript ?? "").trim();
  }
  if (event.type === "conversation.item.input_audio_transcription.delta") {
    return String(event.delta ?? event.transcript ?? "").trim();
  }
  return "";
}

function extractIflytekTranscript(event) {
  const data = typeof event.data === "string" ? parseJsonMessage(event.data) : event.data;
  const rt = data?.cn?.st?.rt;
  if (!Array.isArray(rt)) return "";
  return rt
    .flatMap((item) => (Array.isArray(item?.ws) ? item.ws : []))
    .flatMap((word) => (Array.isArray(word?.cw) ? word.cw : []))
    .map((candidate) => candidate?.w ?? "")
    .join("");
}

function resolveTranslationConfig(input, fallbackProvider = translationProvider) {
  const source = typeof input === "object" && input ? input : {};
  const provider = normalizeTranslationProvider(typeof input === "string" ? input : source.provider ?? fallbackProvider);
  const preset = translationProviderDefaults[provider] ?? translationProviderDefaults.custom;
  const protocol = normalizeTranslationProtocol(source.protocol ?? preset.protocol);
  const presetBaseUrl = protocol === "anthropic" && preset.anthropicBaseUrl ? preset.anthropicBaseUrl : preset.baseUrl;
  const baseUrl =
    String(source.baseUrl ?? "").trim() ||
    presetBaseUrl ||
    aiTranslationBaseUrl;
  const model = String(source.model ?? "").trim() || preset.model || aiTranslationModel;
  const apiKey = String(source.apiKey ?? "").trim() || (provider === "microsoft" ? "" : (aiTranslationApiKey ?? ""));

  return {
    provider,
    protocol,
    apiKey,
    baseUrl,
    model,
    disableThinking: source.disableThinking ?? preset.disableThinking ?? aiTranslationDisableThinking,
  };
}
function getTranslationProviderLabel(provider) {
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "kimi") return "Kimi";
  if (provider === "qwen") return "通义千问";
  if (provider === "glm") return "GLM / 智谱";
  if (provider === "minimax") return "MiniMax";
  if (provider === "mimo") return "小米 MiMo";
  if (provider === "custom") return "自定义模型";
  if (provider === "ai") return "AI 翻译";
  return "翻译服务";
}

function normalizeTranslationProtocol(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "anthropic" || normalized === "anthropic-compatible" ? "anthropic" : "openai";
}

function normalizeTranslationProvider(value) {
  const normalized = String(value).trim().toLowerCase();
  if (["balanced", "page", "web", "webpage"].includes(normalized)) return "balanced";
  if (["accurate", "document", "pdf", "context", "contextual"].includes(normalized)) return "accurate";
  if (["deepseek", "kimi", "qwen", "glm", "minimax", "mimo", "custom"].includes(normalized)) return normalized;
  if (["ai", "openai", "openai-compatible", "anthropic", "anthropic-compatible", "llm"].includes(normalized)) return "ai";
  return "microsoft";
}

function isAiTranslationProvider(provider) {
  return ["ai", "deepseek", "kimi", "qwen", "glm", "minimax", "mimo", "custom"].includes(provider);
}

function isReasoningModel(model) {
  return /reasoner|r1|o1|o3|gemini-2\.[05]-thinking/i.test(String(model));
}

function getAiAuthHeaders(config, protocol = config.protocol) {
  if (config.provider === "mimo") return { "api-key": config.apiKey };
  if (protocol === "anthropic") return { "x-api-key": config.apiKey };
  return { Authorization: `Bearer ${config.apiKey}` };
}

function toChatCompletionsUrl(baseUrl) {
  const url = new URL(baseUrl);
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/chat/completions")) return url.toString();
  url.pathname = `${pathname}/chat/completions`.replace(/\/+/g, "/");
  return url.toString();
}

function toAnthropicMessagesUrl(baseUrl) {
  const url = new URL(baseUrl);
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/messages")) return url.toString();
  url.pathname = `${pathname}/messages`.replace(/\/+/g, "/");
  return url.toString();
}

function extractAnthropicText(result) {
  if (!Array.isArray(result?.content)) return "";
  return result.content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text" || typeof part?.text === "string") return part.text ?? "";
      return "";
    })
    .join("")
    .trim();
}

function coerceJsonArray(raw, expectedLength) {
  const trimmed = String(raw).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return normalizeTranslationArray(parsed, expectedLength);
    if (Array.isArray(parsed.translations)) return normalizeTranslationArray(parsed.translations, expectedLength);
  } catch {
    // Fall through to line-based parsing for providers that ignore the JSON-only instruction.
  }
  return normalizeTranslationArray(trimmed.split(/\n+/).map((line) => line.replace(/^\s*[-*\d.)]+\s*/, "")), expectedLength);
}

function normalizeTranslationArray(values, expectedLength) {
  return Array.from({ length: expectedLength }, (_value, index) => String(values[index] ?? "").trim());
}

function normalizeCaptionForCompare(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isNearDuplicateCaptionKey(previous, current) {
  if (!previous || !current) return false;
  if (previous === current) return true;
  if (current.includes(previous)) return false;
  if (!previous.includes(current)) return false;

  const shorterLength = current.length;
  const longerLength = previous.length;
  if (shorterLength >= 12) return true;
  return shorterLength / longerLength > 0.82;
}

function looksLikeBackendErrorText(text) {
  return /timeout waiting next packet|server[_\s-]?error|火山\s*asr\s*错误|backend connection failed|后端连接失败|"\s*error\s*"\s*:/i.test(
    String(text),
  );
}

function getCachedTranslations(texts, targetLanguage, provider) {
  const translations = texts.map((text) => translationCache.get(cacheKey(text, targetLanguage, provider)) ?? "");
  return {
    translations,
    complete: translations.every(Boolean),
  };
}

function setCachedTranslations(texts, targetLanguage, provider, translations) {
  texts.forEach((text, index) => {
    const translation = translations[index];
    if (!translation) return;
    translationCache.set(cacheKey(text, targetLanguage, provider), translation);
  });

  while (translationCache.size > 500) {
    const firstKey = translationCache.keys().next().value;
    translationCache.delete(firstKey);
  }
}

function cacheKey(text, targetLanguage, provider) {
  return `${provider}\u0000${targetLanguage}\u0000${text}`;
}

function readPositiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function loadDotEnv() {
  try {
    const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
    for (const line of env.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const equalsIndex = trimmed.indexOf("=");
      if (equalsIndex === -1) continue;
      const key = trimmed.slice(0, equalsIndex).trim();
      const value = trimmed.slice(equalsIndex + 1).trim();
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env is optional; real deployments can use process environment variables.
  }
}
