import { CaptionUpdate, RuntimeMessage, TranslatorSettings } from "../types";

interface Session {
  tabId: number;
  streamId?: string;
  settings: TranslatorSettings;
  mode: "mock" | "websocket";
  socket?: WebSocket;
  stream?: MediaStream;
  audioContext?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  worklet?: AudioWorkletNode;
  mockTimer?: number;
  healthTimer?: number;
  lastAudioFrameAt?: number;
  stopping?: boolean;
  startedAt: number;
}

const sessions = new Map<number, Session>();
const SILENCE_RMS_THRESHOLD = 25;
const SESSION_HEALTH_CHECK_MS = 2_000;

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.type === "offscreen:start") {
    startSession(message.tabId, message.settings, message.streamId)
      .then(() => sendResponse({ ok: true }))
      .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (message.type === "offscreen:stop") {
    void stopSession(message.tabId);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function startSession(tabId: number, settings: TranslatorSettings, streamId?: string): Promise<void> {
  await stopSession(tabId);

  const session: Session = {
    tabId,
    settings,
    mode: settings.backendUrl ? "websocket" : "mock",
    startedAt: Date.now(),
    ...(streamId ? { streamId } : {}),
  };
  sessions.set(tabId, session);

  if (settings.backendUrl) {
    await startWebSocketSession(session);
    return;
  }

  if (settings.mockWhenBackendMissing) {
    startMockSession(session);
    return;
  }

  throw new Error("No backendUrl configured and mock mode is disabled.");
}

async function startWebSocketSession(session: Session): Promise<void> {
  if (!session.streamId) throw new Error("Missing tab capture stream ID.");
  const stream = await captureTabAudio(session.streamId);

  const audioContext = new AudioContext({ sampleRate: 16000 });
  await audioContext.audioWorklet.addModule(chrome.runtime.getURL("offscreen/audioWorkletProcessor.js"));

  const source = audioContext.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(audioContext, "rvt-audio-worklet", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { targetSampleRate: 16000 },
  });

  worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    if (!sessions.has(session.tabId) || session.stopping) return;
    if (!isAudiblePcmFrame(event.data)) return;
    session.lastAudioFrameAt = Date.now();

    const socket = ensureSocket(session);
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(event.data);
    }
  };

  source.connect(worklet);
  worklet.connect(audioContext.destination);

  session.stream = stream;
  session.audioContext = audioContext;
  session.source = source;
  session.worklet = worklet;
  ensureSocket(session);
  startSessionHealthCheck(session);
}

function startSessionHealthCheck(session: Session): void {
  if (session.healthTimer) window.clearInterval(session.healthTimer);
  session.healthTimer = window.setInterval(() => {
    if (!sessions.has(session.tabId) || session.stopping) return;

    if (session.audioContext?.state === "suspended") {
      void session.audioContext.resume().catch(() => undefined);
    }

    const trackLive = session.stream?.getAudioTracks().some((track) => track.readyState === "live") ?? false;
    if (!trackLive) return;

    if (!session.socket || session.socket.readyState === WebSocket.CLOSED || session.socket.readyState === WebSocket.CLOSING) {
      ensureSocket(session);
    }
  }, SESSION_HEALTH_CHECK_MS);
}

function ensureSocket(session: Session): WebSocket {
  if (
    session.socket &&
    (session.socket.readyState === WebSocket.OPEN || session.socket.readyState === WebSocket.CONNECTING)
  ) {
    return session.socket;
  }

  const socket = new WebSocket(session.settings.backendUrl);
  socket.binaryType = "arraybuffer";
  session.socket = socket;

  socket.addEventListener("open", () => {
    if (session.stopping || session.socket !== socket) {
      socket.close();
      return;
    }

    socket.send(
      JSON.stringify({
        type: "session.start",
        targetLanguage: session.settings.targetLanguage,
        sampleRate: 16000,
        format: "pcm16",
      }),
    );
  });

  socket.addEventListener("message", (event) => {
    const update = parseBackendCaption(event.data);
    if (update) void publishCaption(session.tabId, update);
  });

  socket.addEventListener("close", () => {
    if (session.socket === socket) delete session.socket;
  });

  socket.addEventListener("error", () => {
    if (session.stopping) return;
    void publishCaption(session.tabId, {
      id: `error-${Date.now()}`,
      sourceText: "后端连接失败。",
      translatedText: "后端连接失败，请检查 WebSocket 地址。恢复播放后会自动重连。",
      isFinal: true,
      startedAt: session.startedAt,
      receivedAt: Date.now(),
    });
  });

  session.socket = socket;
  return socket;
}

function startMockSession(session: Session): void {
  const script: Array<[string, string]> = [
    ["The browser is capturing this tab audio in realtime.", "浏览器正在实时采集当前标签页音频。"],
    ["Interim captions appear first and can be replaced quickly.", "临时字幕会先出现，并且可以快速被修正。"],
    ["Final captions lock after a short pause in speech.", "说话短暂停顿后，字幕会变成确认结果。"],
    ["Connect a streaming ASR backend to replace this mock feed.", "接入流式语音识别后端后，就能替换这条模拟流。"],
  ];

  let index = 0;
  let partial = 0;

  session.mockTimer = window.setInterval(() => {
    const [sourceText, translatedText] = script[index % script.length] ?? script[0]!;
    const words = sourceText.split(" ");
    partial = Math.min(words.length, partial + 2);
    const isFinal = partial >= words.length;
    const sourceChunk = words.slice(0, partial).join(" ");

    void publishCaption(session.tabId, {
      id: `mock-${index}`,
      sourceText: sourceChunk,
      translatedText: isFinal ? translatedText : translatedText.slice(0, Math.max(2, Math.round((translatedText.length * partial) / words.length))),
      isFinal,
      startedAt: session.startedAt,
      receivedAt: Date.now(),
    });

    if (isFinal) {
      index += 1;
      partial = 0;
    }
  }, 360);
}

function captureTabAudio(streamId: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        googDisableLocalEcho: false,
      },
    },
    video: false,
  } as MediaStreamConstraints);
}

async function stopSession(tabId: number): Promise<void> {
  const session = sessions.get(tabId);
  if (!session) return;

  session.stopping = true;
  if (session.mockTimer) window.clearInterval(session.mockTimer);
  if (session.healthTimer) window.clearInterval(session.healthTimer);
  session.socket?.close();
  session.worklet?.disconnect();
  session.source?.disconnect();
  session.stream?.getTracks().forEach((track) => track.stop());
  await session.audioContext?.close().catch(() => undefined);
  sessions.delete(tabId);
}

function isAudiblePcmFrame(data: ArrayBuffer): boolean {
  const samples = new Int16Array(data);
  if (samples.length === 0) return false;

  let sumSquares = 0;
  for (const sample of samples) {
    sumSquares += sample * sample;
  }

  return Math.sqrt(sumSquares / samples.length) >= SILENCE_RMS_THRESHOLD;
}

function parseBackendCaption(data: unknown): CaptionUpdate | null {
  if (typeof data !== "string") return null;

  try {
    const parsed = JSON.parse(data) as Partial<CaptionUpdate> & {
      text?: string;
      translation?: string;
      final?: boolean;
      status?: string;
    };
    if (parsed.status === "error") return null;

    const sourceText = parsed.sourceText ?? parsed.text ?? "";
    const translatedText = parsed.translatedText ?? parsed.translation ?? "";
    if (!sourceText && !translatedText) return null;
    if (looksLikeBackendErrorText(sourceText) || looksLikeBackendErrorText(translatedText)) return null;

    const caption: CaptionUpdate = {
      id: parsed.id ?? `caption-${Date.now()}`,
      sourceText,
      translatedText,
      isFinal: parsed.isFinal ?? parsed.final ?? false,
      startedAt: parsed.startedAt ?? Date.now(),
      receivedAt: Date.now(),
    };
    if (typeof parsed.revision === "number") caption.revision = parsed.revision;
    return caption;
  } catch {
    return null;
  }
}

function looksLikeBackendErrorText(text: string): boolean {
  return /timeout waiting next packet|server[_\s-]?error|火山\s*asr\s*错误|backend connection failed|后端连接失败|"\s*error\s*"\s*:/i.test(
    text,
  );
}

async function publishCaption(tabId: number, caption: CaptionUpdate): Promise<void> {
  await chrome.runtime.sendMessage({ type: "caption:update", tabId, caption } satisfies RuntimeMessage);
}
