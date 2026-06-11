import { randomUUID } from "node:crypto";
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

const SAMPLE_RATE = 16000;
const AUDIO_SEGMENT_MS = 200;
const AUDIO_SEGMENT_BYTES = Math.floor((SAMPLE_RATE * 2 * AUDIO_SEGMENT_MS) / 1000);
const CAPTION_FRAGMENT_MAX_CHARS = 72;
const CAPTION_FRAGMENT_MAX_WORDS = 8;
const CAPTION_MIN_COMPLETE_CHARS = 18;
const CAPTION_MIN_COMPLETE_WORDS = 4;
const CAPTION_RECENT_FRAGMENT_LIMIT = 80;
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
  let recentCaptionFragmentKeys = [];
  let pendingCaptionFragments = [];
  let targetLanguage = "zh-CN";
  let captionRevision = 0;
  let translationInFlight = false;
  let sentWavHeader = false;

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

  async function connectVolcengine() {
    if (!sessionActive || client.readyState !== WebSocket.OPEN) return;
    if (upstream && (upstream.readyState === WebSocket.CONNECTING || upstream.readyState === WebSocket.OPEN)) return;

    if (!appId || !accessToken) {
      fail("缺少 VOLCENGINE_APP_ID 或 VOLCENGINE_ACCESS_TOKEN。");
      client.close(1011, "Volcengine credentials missing");
      return;
    }

    ready = false;
    sentWavHeader = false;
    const socket = new WebSocket(volcUrl, {
      headers: {
        "X-Api-App-Key": appId,
        "X-Api-Access-Key": accessToken,
        "X-Api-Resource-Id": resourceId,
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

      const text = extractTranscript(response.payloadMsg);
      if (!text || text === lastText) return;
      lastText = text;
      enqueueCaptionFragments(text);
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
        captionId = `caption-${Date.now()}`;
        lastText = "";
        lastTranslatedText = "";
        recentCaptionFragmentKeys = [];
        pendingCaptionFragments = [];
        captionRevision = 0;
        translationInFlight = false;
        sentWavHeader = false;
        void connectVolcengine();
      }

      if (event.type === "session.stop") {
        sessionActive = false;
        audioBuffer = Buffer.alloc(0);
        pendingCaptionFragments = [];
        resetUpstream(upstream);
      }
      return;
    }

    if (!sessionActive) return;
    audioBuffer = Buffer.concat([audioBuffer, Buffer.from(data)]);
    flushAudio(false);
  });

  client.on("close", () => {
    sessionActive = false;
    audioBuffer = Buffer.alloc(0);
    pendingCaptionFragments = [];
    resetUpstream(upstream);
  });

  function flushAudio(isLast) {
    if (!sessionActive) return;
    if (!ready || upstream?.readyState !== WebSocket.OPEN) {
      if (!upstream || upstream.readyState === WebSocket.CLOSED || upstream.readyState === WebSocket.CLOSING) {
        void connectVolcengine();
      }
      return;
    }

    while (audioBuffer.length >= AUDIO_SEGMENT_BYTES) {
      const segment = audioBuffer.subarray(0, AUDIO_SEGMENT_BYTES);
      audioBuffer = audioBuffer.subarray(AUDIO_SEGMENT_BYTES);
      upstream.send(buildAudioRequest(seq++, withWavHeaderIfNeeded(segment), false));
    }

    if (isLast && audioBuffer.length > 0) {
      upstream.send(buildAudioRequest(seq, withWavHeaderIfNeeded(audioBuffer), true));
      audioBuffer = Buffer.alloc(0);
    }
  }

  function withWavHeaderIfNeeded(segment) {
    if (sentWavHeader) return segment;
    sentWavHeader = true;
    return Buffer.concat([buildStreamingWavHeader(), segment]);
  }

  function enqueueCaptionFragments(text) {
    const fragments = extractReadyCaptionFragments(text);
    if (fragments.length === 0) return;
    pendingCaptionFragments.push(...fragments);
    void runCaptionTranslationQueue();
  }

  async function runCaptionTranslationQueue() {
    if (translationInFlight) return;
    const text = pendingCaptionFragments.shift();
    if (!text) return;
    translationInFlight = true;

    try {
      const translatedText = await translateText(text, targetLanguage);
      lastTranslatedText = translatedText;
      captionRevision += 1;
      sendCaption(text, translatedText, true, captionRevision);
    } catch {
      // Keep ASR captions flowing even when translation provider is temporarily slow.
    } finally {
      translationInFlight = false;
      if (pendingCaptionFragments.length > 0) void runCaptionTranslationQueue();
    }
  }

  function extractReadyCaptionFragments(text) {
    const fragments = buildCaptionFragments(text);
    const readyFragments = [];

    for (const fragment of fragments) {
      const key = normalizeCaptionForCompare(fragment);
      if (!key || hasRecentCaptionFragment(key)) continue;
      recentCaptionFragmentKeys.push(key);
      readyFragments.push(fragment);
    }

    recentCaptionFragmentKeys = recentCaptionFragmentKeys.slice(-CAPTION_RECENT_FRAGMENT_LIMIT);
    return readyFragments;
  }

  function hasRecentCaptionFragment(key) {
    return recentCaptionFragmentKeys.some((existingKey) => {
      if (existingKey === key) return true;
      return isNearDuplicateCaptionKey(existingKey, key);
    });
  }
});

server.listen(port, () => {
  console.log(`Volcengine realtime ASR backend listening on ws://localhost:${port}/realtime`);
  console.log(`Resource ID: ${resourceId}`);
  if (!appId || !accessToken) {
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
    const result = await translatePdf(pdfUrl, title, targetLanguage);
    response.writeHead(200, { ...corsHeaders(), "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, ...result }));
    return;
  }

  if (request.method === "POST" && request.url?.startsWith("/translate")) {
    const body = await readJsonBody(request);
    const texts = Array.isArray(body.texts) ? body.texts.map((text) => String(text)) : [];
    const targetLanguage = String(body.targetLanguage || "zh-CN");
    const translations = await translateTexts(texts, targetLanguage, undefined, pageTranslationProvider);
    response.writeHead(200, { ...corsHeaders(), "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, translations }));
    return;
  }

  response.writeHead(200, { ...corsHeaders(), "content-type": "application/json" });
  response.end(
    JSON.stringify({
      ok: true,
      service: "realtime-video-translator",
      provider: "volcengine",
      translationProvider,
      pageTranslationProvider,
      pdfTranslationProvider,
      aiTranslationConfigured: Boolean(aiTranslationApiKey),
      websocket: `ws://localhost:${port}/realtime`,
      appIdConfigured: Boolean(appId),
      accessTokenConfigured: Boolean(accessToken),
      resourceId,
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
    user: { uid: "realtime-video-translator" },
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

async function translateText(text, targetLanguage, signal) {
  const [translation] = await translateTexts([text], targetLanguage, signal);
  return translation ?? "";
}

async function translatePdf(pdfUrl, title, targetLanguage) {
  const data = await loadPdfData(pdfUrl);
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText();
    const paragraphs = normalizePdfParagraphs(result.text);
    if (paragraphs.length === 0) {
      throw new Error("No selectable text was found in this PDF. Scanned PDFs need OCR support.");
    }

    const translations = await translateDocumentTexts(paragraphs, targetLanguage, pdfTranslationProvider);

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

async function translateDocumentTexts(paragraphs, targetLanguage, provider) {
  if (provider === "accurate") {
    return translateDocumentTextsWithContext(paragraphs, targetLanguage);
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
        const batchTranslations = await translateTexts(batch.texts, targetLanguage, undefined, provider);
        batchTranslations.forEach((translation, index) => {
          translations[batch.start + index] = translation;
        });
      }
    }),
  );

  return translations;
}

async function translateTexts(texts, targetLanguage, signal, provider = translationProvider) {
  const cleanTexts = texts.map((text) => String(text ?? ""));
  if (cleanTexts.length === 0) return [];
  if (cleanTexts.every((text) => !text.trim())) return cleanTexts.map(() => "");
  if (provider === "ai") return translateTextsWithAi(cleanTexts, targetLanguage, signal, { profile: "subtitle" });
  if (provider === "balanced") return translateTextsBalanced(cleanTexts, targetLanguage, signal);
  if (provider === "accurate") return translateTextsAccurate(cleanTexts, targetLanguage, signal);
  return translateTextsWithMicrosoft(cleanTexts, targetLanguage, signal);
}

async function translateTextsBalanced(cleanTexts, targetLanguage, signal) {
  if (!aiTranslationApiKey) return translateTextsWithMicrosoft(cleanTexts, targetLanguage, signal);
  const aiTranslations = await translateTextsWithAi(cleanTexts, targetLanguage, signal, { profile: "page" });
  if (aiTranslations.some(Boolean)) {
    return aiTranslations.map((translation, index) => translation || cleanTexts[index] || "");
  }
  return translateTextsWithMicrosoft(cleanTexts, targetLanguage, signal);
}

async function translateTextsAccurate(cleanTexts, targetLanguage, signal) {
  if (!aiTranslationApiKey) return translateTextsWithMicrosoft(cleanTexts, targetLanguage, signal);
  const aiTranslations = await translateTextsWithAi(cleanTexts, targetLanguage, signal, { profile: "document" });
  if (aiTranslations.some(Boolean)) {
    return aiTranslations.map((translation, index) => translation || cleanTexts[index] || "");
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
  if (!aiTranslationApiKey) {
    return translateTextsWithMicrosoft(cleanTexts, targetLanguage, signal);
  }

  const profile = options.profile ?? "subtitle";
  const cacheProvider = `ai:${aiTranslationModel}:${profile}`;
  const cached = getCachedTranslations(cleanTexts, targetLanguage, cacheProvider);
  if (cached.complete) return cached.translations;

  const requestBody = {
    model: aiTranslationModel,
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

  if (aiTranslationDisableThinking) {
    requestBody.thinking = { type: "disabled" };
  }

  let response = await fetch(toChatCompletionsUrl(aiTranslationBaseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${aiTranslationApiKey}`,
    },
    body: JSON.stringify(requestBody),
    signal,
  });

  if (!response.ok && requestBody.thinking) {
    delete requestBody.thinking;
    response = await fetch(toChatCompletionsUrl(aiTranslationBaseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${aiTranslationApiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal,
    });
  }

  if (!response.ok) return cleanTexts.map((_text, index) => cached.translations[index] ?? "");
  const result = await response.json();
  const raw = result?.choices?.[0]?.message?.content ?? "";
  const translations = coerceJsonArray(raw, cleanTexts.length).map((text, index) => text || cached.translations[index] || "");
  setCachedTranslations(cleanTexts, targetLanguage, cacheProvider, translations);
  return translations;
}

async function translateDocumentTextsWithContext(paragraphs, targetLanguage) {
  if (!aiTranslationApiKey) {
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
        const batchTranslations = await translateTextsWithAiDocumentContext(batch, targetLanguage);
        batchTranslations.forEach((translation, index) => {
          translations[batch.start + index] = translation || batch.texts[index] || "";
        });
      }
    }),
  );

  return translations;
}

async function translateTextsWithAiDocumentContext(batch, targetLanguage) {
  const cacheProvider = `ai:${aiTranslationModel}:document-context`;
  const cached = getCachedTranslations(batch.texts, targetLanguage, cacheProvider);
  if (cached.complete) return cached.translations;

  const requestBody = {
    model: aiTranslationModel,
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

  if (aiTranslationDisableThinking) {
    requestBody.thinking = { type: "disabled" };
  }

  let response = await fetch(toChatCompletionsUrl(aiTranslationBaseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${aiTranslationApiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok && requestBody.thinking) {
    delete requestBody.thinking;
    response = await fetch(toChatCompletionsUrl(aiTranslationBaseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${aiTranslationApiKey}`,
      },
      body: JSON.stringify(requestBody),
    });
  }

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

  return `You are a low-latency subtitle translation engine. Translate into ${target}. Use concise spoken subtitle phrasing. Do not explain, expand, summarize, or add context. Prefer short Chinese clauses that can fit on one subtitle line. Preserve names, numbers, and technical terms. Return only JSON in this shape: {"translations":["..."]}. The translations array must have the same length and order as the input array.`;
}

async function getMicrosoftToken(signal) {
  if (microsoftToken && Date.now() < microsoftTokenExpiresAt) return microsoftToken;
  const response = await fetch("https://edge.microsoft.com/translate/auth", { signal });
  if (!response.ok) throw new Error(`Microsoft translate auth failed: ${response.status}`);
  microsoftToken = await response.text();
  microsoftTokenExpiresAt = Date.now() + 8 * 60 * 1000;
  return microsoftToken;
}

function normalizeTranslationProvider(value) {
  const normalized = String(value).trim().toLowerCase();
  if (["balanced", "page", "web", "webpage"].includes(normalized)) return "balanced";
  if (["accurate", "document", "pdf", "context", "contextual"].includes(normalized)) return "accurate";
  if (["ai", "deepseek", "openai", "openai-compatible", "llm"].includes(normalized)) return "ai";
  return "microsoft";
}

function toChatCompletionsUrl(baseUrl) {
  const url = new URL(baseUrl);
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/chat/completions")) return url.toString();
  url.pathname = `${pathname}/chat/completions`.replace(/\/+/g, "/");
  return url.toString();
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
  const shorterLength = Math.min(previous.length, current.length);
  const longerLength = Math.max(previous.length, current.length);
  if (!previous.includes(current) && !current.includes(previous)) return false;
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
