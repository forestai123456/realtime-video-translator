# 听我解释 (Hear Me Out)

Chrome MV3 扩展 — 为网页视频生成实时字幕，支持视频、网页和 PDF 翻译。

## Repository Status

This repository contains the full source code for development. It does not commit generated build output or local secrets.

- Source code lives in `src/`.
- The local realtime ASR/translation backend lives in `scripts/realtime-translation-server.mjs`.
- Browser extension build output is generated into `dist/` by `npm run build`.
- Runtime secrets belong in a local `.env` file. Use `.env.example` as the template.

This project is intentionally focused on the video subtitle path first:

- Injects a subtitle overlay into every webpage.
- Starts and stops from the extension popup.
- Supports a local streaming service for realtime ASR and translation.
- Includes a local Volcengine/Doubao ASR backend plus Microsoft web translation.
- Captures tab audio with the MV3-safe path: `tabCapture.getMediaStreamId()` in the service worker, then `getUserMedia()` inside an offscreen document.

## Build

```bash
npm install
npm run typecheck
npm run build
```

The unpacked extension is generated in `dist/`.

`dist/` is intentionally ignored by Git. For now, clone the repository and build locally before loading the extension. A downloadable packaged release can be added later when the project is ready for public users.

## Load in Chrome or Edge

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this project's `dist/` directory.
5. Open a video page and click the extension icon.
6. Choose the speech service and translation service in the popup.
7. Turn on `视频实时翻译`.

## Translate A Normal Web Page

The popup has two separate tools:

- `视频实时翻译`: captures the current tab audio and shows realtime subtitles.
- `网页翻译`: translates visible English text on the current page.
- `划词翻译`: shows a small translation popover for selected text without translating the whole page.

To translate a static page:

1. Keep the local backend running with `npm run dev:server`.
2. Open an English webpage.
3. Click the extension icon.
4. Click `翻译当前页`.
5. Click `恢复` to put the original page text back.

Page translation uses the local backend. By default it uses a balanced AI translation path when an OpenAI-compatible key is configured, and falls back to Microsoft web translation when no key is available. It skips inputs, code blocks, scripts, styles, and the extension's own subtitle overlay.

To translate only one word or sentence:

1. Keep `划词翻译` enabled in the popup.
2. Select text on a normal webpage.
3. Click the floating `翻译` button near the selection.

Selection translation uses the same target language and translation service as page translation. It does not rewrite the page DOM; the result only appears in the floating popover.

## Test Real Video Audio

Create a local `.env` file in the project root:

```env
VOLCENGINE_APP_ID="your App ID"
VOLCENGINE_ACCESS_TOKEN="your Access Token"
VOLCENGINE_RESOURCE_ID="volc.seedasr.sauc.duration"
VOLCENGINE_ASR_WS_URL="wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"

# Optional generic ASR fallback. The popup can also save these values locally.
# ASR_PROVIDER="volcengine"
# ASR_APP_ID="your App ID"
# ASR_ACCESS_TOKEN="your Access Token"
# ASR_API_KEY="your ASR API key"
# ASR_API_SECRET="your ASR API secret"
# ASR_SECRET_ID="your Tencent SecretId"
# ASR_SECRET_KEY="your Tencent SecretKey"
# ASR_APP_KEY="your Aliyun/Baidu AppKey"
# ASR_WS_URL="wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
# ASR_MODEL="doubao-seed-asr"

# Optional. Default is Microsoft web translation with no API key.
TRANSLATION_PROVIDER="microsoft"

# Optional. Static pages default to balanced speed/accuracy.
PAGE_TRANSLATION_PROVIDER="balanced"

# Optional. PDFs default to context-aware accurate translation.
PDF_TRANSLATION_PROVIDER="accurate"

# Optional DeepSeek/OpenAI-compatible translator.
# TRANSLATION_PROVIDER="ai"
# AI_TRANSLATION_BASE_URL="https://api.deepseek.com"
# AI_TRANSLATION_API_KEY="your API key"
# AI_TRANSLATION_MODEL="deepseek-v4-flash"
# AI_TRANSLATION_DISABLE_THINKING="true"

# Optional long-stream stability tuning.
# VOLCENGINE_ASR_ROTATE_MS="270000"
# ASR_KEEPALIVE_MS="1000"
# ASR_KEEPALIVE_IDLE_MS="1500"
# ASR_AUDIO_BUFFER_MAX_MS="8000"
# SUBTITLE_PENDING_FRAGMENT_LIMIT="36"
# SUBTITLE_PROCESSED_FRAGMENT_LIMIT="50000"
# SUBTITLE_TRANSLATION_TIMEOUT_MS="8000"
```

Then start the local backend:

```bash
npm run dev:server
```

Reload the unpacked extension from `chrome://extensions`, open a page with a playing video, and turn on `视频实时翻译`.

The extension captures the current tab audio and streams 16 kHz PCM16 frames to the local backend. The backend connects to Volcengine's optimized bidirectional streaming ASR endpoint, then translates recognized text to Chinese with Microsoft web translation and sends caption updates back to the page overlay.

The popup no longer exposes the internal WebSocket address. The local backend still runs at `ws://localhost:8787/realtime` by default, while users configure understandable options such as `语音服务`, `翻译服务`, `目标语言`, and API credentials.

Speech service presets currently include Volcengine/Doubao, Aliyun Model Studio Qwen-ASR Realtime, Tencent Cloud ASR, Baidu Realtime ASR, and iFlytek realtime transcription. Volcengine is the default path used during development. Aliyun defaults to the newer DashScope API-key flow and still keeps the older NLS AppKey + Token path as a backend compatibility fallback. The other providers follow their WebSocket handshake/signature formats in the local backend, but you still need valid credentials from the matching vendor to test them.

The subtitle overlay shows frozen subtitle chunks only. Realtime ASR interim text is buffered by the backend and converted into short completed sentence or clause fragments before translation. The page overlay keeps at most two Chinese lines on screen, and video pause suspends the audio session so queued captions do not keep rolling after playback stops.

For long livestreams, the backend keeps the ASR session alive during speechless sections with silent audio packets, caps queued audio/subtitle buffers, times out stuck subtitle translations, and rotates the upstream Volcengine ASR connection periodically. Video pause still stops the audio session so the backend does not keep processing after playback is paused.

## Translation Providers

The popup supports Microsoft free translation plus OpenAI-compatible or Anthropic-compatible model providers:

- DeepSeek
- Xiaomi MiMo
- Kimi
- GLM / Zhipu
- Qwen / DashScope
- MiniMax
- Custom compatible endpoint

The popup stores API keys in Chrome local extension storage. `.env` remains supported as a backend fallback for development and command-line testing.

## Preset Service References

Speech recognition presets:

- Volcengine/Doubao: [Streaming speech recognition model 2.0](https://www.volcengine.com/docs/6561/1354869)
- Aliyun Model Studio: [Qwen-ASR Realtime WebSocket](https://www.alibabacloud.com/help/en/model-studio/real-time-speech-recognition-user-guide)
- Tencent Cloud: [Realtime speech recognition WebSocket](https://cloud.tencent.com/document/product/1093/48982)
- Baidu AI Cloud: [Realtime ASR WebSocket](https://cloud.baidu.com/doc/SPEECH/s/jlbxejt2i)
- iFlytek: [Realtime transcription API](https://www.xfyun.cn/doc/asr/rtasr/API.html)

Translation model presets:

- DeepSeek: [API documentation](https://api-docs.deepseek.com/)
- Xiaomi MiMo: [Models provider documentation](https://mimo.xiaomi.com/mimocode/models-provider)
- Kimi: [Kimi API documentation](https://platform.kimi.com/docs/guide/start-using-kimi-api)
- GLM / Zhipu: [Model pricing and model list](https://open.bigmodel.cn/pricing)
- Qwen / DashScope: [OpenAI-compatible mode](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)
- MiniMax: [OpenAI-compatible API](https://platform.minimaxi.com/docs/api-reference/text-openai-api)

Example:

```env
TRANSLATION_PROVIDER=ai
AI_TRANSLATION_BASE_URL=https://api.deepseek.com
AI_TRANSLATION_API_KEY=sk-...
AI_TRANSLATION_MODEL=deepseek-v4-flash
AI_TRANSLATION_DISABLE_THINKING=true
```

`TRANSLATION_PROVIDER` controls fallback realtime video subtitle translation. `PAGE_TRANSLATION_PROVIDER` controls fallback static webpages. `PDF_TRANSLATION_PROVIDER` controls fallback PDFs. Settings saved in the popup take priority for extension-triggered requests.

Recommended setup:

```env
TRANSLATION_PROVIDER=ai
PAGE_TRANSLATION_PROVIDER=balanced
PDF_TRANSLATION_PROVIDER=accurate
```

`balanced` uses AI for webpage batches when an API key is present, with Microsoft fallback. `accurate` translates PDF/document paragraphs with nearby context, which is slower but more precise. If no AI key is configured, the backend falls back to Microsoft translation.

## Backend Protocol

When video subtitles start, the extension sends:

```json
{
  "type": "session.start",
  "targetLanguage": "zh-CN",
  "sampleRate": 16000,
  "format": "pcm16",
  "asr": {
    "provider": "volcengine",
    "appId": "...",
    "accessToken": "...",
    "resourceId": "volc.seedasr.sauc.duration",
    "endpoint": "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
    "model": "doubao-seed-asr"
  },
  "translation": {
    "provider": "microsoft",
    "protocol": "openai",
    "apiKey": "",
    "baseUrl": "",
    "model": "",
    "disableThinking": true
  }
}
```

After that, it streams binary `Int16Array` PCM frames at 16 kHz. Each frame is about 40 ms.

The backend should send JSON caption updates after a subtitle fragment is stable enough to display:

```json
{
  "id": "caption-1",
  "sourceText": "stable English subtitle fragment",
  "translatedText": "稳定的中文字幕片段",
  "isFinal": true,
  "startedAt": 1781125243000
}
```

The UI ignores interim updates. Send display-ready `isFinal: true` fragments to avoid word-by-word subtitle flicker.

## Source Layout

- `src/manifest.json`: Chrome MV3 extension manifest.
- `src/background.ts`: popup commands, settings, offscreen lifecycle, `tabCapture.getMediaStreamId()`.
- `src/offscreen/`: tab audio capture, AudioWorklet, local backend streaming, demo caption mode.
- `src/content/`: subtitle overlay, page translation, video pause/resume handling.
- `src/popup/`: extension popup controls.
- `src/pdf/`: PDF translation result page.
- `scripts/build.mjs`: esbuild-based extension bundler.
- `scripts/realtime-translation-server.mjs`: local multi-provider ASR and translation backend.
- `test-fixtures/`: local manual test page and media fixtures.

## License

MIT

## FluentRead Reference

FluentRead uses a browser-extension content-script model for in-page translation UI and page-level controls. This prototype borrows that product architecture idea, but the implementation here is new and scoped to realtime video subtitles first.
