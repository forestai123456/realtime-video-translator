# Realtime Video Translator

Chrome MV3 extension prototype for low-latency AI video subtitles and translation.

This project is intentionally focused on the video subtitle path first:

- Injects a subtitle overlay into every webpage.
- Starts and stops from the extension popup.
- Supports a WebSocket backend for streaming tab audio to realtime translation.
- Includes a local Volcengine/Doubao ASR backend plus Microsoft web translation.
- Captures tab audio with the MV3-safe path: `tabCapture.getMediaStreamId()` in the service worker, then `getUserMedia()` inside an offscreen document.

## Build

```bash
npm install
npm run typecheck
npm run build
```

The unpacked extension is generated in `dist/`.

## Load in Chrome or Edge

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this project's `dist/` directory.
5. Open a video page and click the extension icon.
6. Keep `WebSocket backend` set to `ws://localhost:8787/realtime`.
7. Click `Start subtitles`.

## Translate A Normal Web Page

The popup has two separate tools:

- `Video subtitles`: captures the current tab audio and shows realtime subtitles.
- `Page translation`: translates visible English text on the current page.

To translate a static page:

1. Keep the local backend running with `npm run dev:server`.
2. Open an English webpage.
3. Click the extension icon.
4. Click `Translate page`.
5. Click `Restore` to put the original page text back.

Page translation uses the local backend. By default it uses a balanced AI translation path when an OpenAI-compatible key is configured, and falls back to Microsoft web translation when no key is available. It skips inputs, code blocks, scripts, styles, and the extension's own subtitle overlay.

## Test Real Video Audio

Create a local `.env` file in the project root:

```env
VOLCENGINE_APP_ID="your App ID"
VOLCENGINE_ACCESS_TOKEN="your Access Token"
VOLCENGINE_RESOURCE_ID="volc.seedasr.sauc.duration"
VOLCENGINE_ASR_WS_URL="wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"

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
```

Then start the local backend:

```bash
npm run dev:server
```

Reload the unpacked extension from `chrome://extensions`, open a page with a playing video, and click `Start subtitles`.

The extension captures the current tab audio and streams 16 kHz PCM16 frames to the local backend. The backend connects to Volcengine's optimized bidirectional streaming ASR endpoint, then translates recognized text to Chinese with Microsoft web translation and sends caption updates back to the page overlay.

The subtitle overlay shows frozen subtitle chunks only. Realtime ASR interim text is buffered by the backend and converted into short completed sentence or clause fragments before translation. The page overlay keeps at most two Chinese lines on screen, and video pause suspends the audio session so queued captions do not keep rolling after playback stops.

## Custom AI Translation

The backend supports an OpenAI-compatible translation provider for DeepSeek and similar model vendors. Keep secrets in `.env`, not in the extension popup.

Example:

```env
TRANSLATION_PROVIDER=ai
AI_TRANSLATION_BASE_URL=https://api.deepseek.com
AI_TRANSLATION_API_KEY=sk-...
AI_TRANSLATION_MODEL=deepseek-v4-flash
AI_TRANSLATION_DISABLE_THINKING=true
```

`TRANSLATION_PROVIDER` controls realtime video subtitle translation. `PAGE_TRANSLATION_PROVIDER` controls static webpages. `PDF_TRANSLATION_PROVIDER` controls PDFs.

Recommended setup:

```env
TRANSLATION_PROVIDER=ai
PAGE_TRANSLATION_PROVIDER=balanced
PDF_TRANSLATION_PROVIDER=accurate
```

`balanced` uses AI for webpage batches when an API key is present, with Microsoft fallback. `accurate` translates PDF/document paragraphs with nearby context, which is slower but more precise. If no AI key is configured, the backend falls back to Microsoft translation.

## Mock Mode

Mock mode is only a UI/demo path. It does not listen to video audio.

To run mock captions intentionally:

1. Clear the `WebSocket backend` field.
2. Enable `Use mock captions when backend is empty`.
3. Click `Start subtitles`.

## Backend Protocol

When `WebSocket backend` is configured, the extension sends:

```json
{
  "type": "session.start",
  "targetLanguage": "zh-CN",
  "sampleRate": 16000,
  "format": "pcm16"
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

- `src/background.ts`: popup commands, settings, offscreen lifecycle, `tabCapture.getMediaStreamId()`.
- `src/offscreen/offscreen.ts`: tab audio stream, AudioWorklet, WebSocket streaming, mock caption mode.
- `src/offscreen/audioWorkletProcessor.js`: downsampling and PCM frame generation.
- `src/content/contentScript.ts`: page subtitle overlay.
- `src/popup/*`: extension popup controls.

## FluentRead Reference

FluentRead uses a browser-extension content-script model for in-page translation UI and page-level controls. This prototype borrows that product architecture idea, but the implementation here is new and scoped to realtime video subtitles first.
