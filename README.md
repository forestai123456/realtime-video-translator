# 听我解释

Chrome / Edge 浏览器扩展 — 为网页视频生成实时 AI 字幕，支持网页翻译和划词翻译。

## 功能

- **视频实时字幕**：捕获标签页音频，通过语音识别 + AI 翻译生成实时中文字幕
- **网页翻译**：一键将当前网页的英文内容翻译为中文
- **划词翻译**：选中文字后弹出翻译浮窗，不影响页面原文
- **PDF 翻译**：支持翻译 PDF 文档内容
- **双语对照**：可选择只看译文或中英双语模式

## 安装

### 前置要求

- Node.js 18+
- Chrome 或 Edge 浏览器

### 步骤

1. 克隆仓库

```bash
git clone https://github.com/forestai123456/听我解释.git
cd 听我解释
```

2. 安装依赖

```bash
npm install
```

3. 构建扩展

```bash
npm run build
```

构建产物在 `dist/` 目录。

4. 加载到浏览器

- 打开 `chrome://extensions`
- 开启右上角**开发者模式**
- 点击**加载已解压的扩展程序**
- 选择项目的 `dist/` 文件夹

## 使用方法

### 网页翻译

1. 打开一个英文网页
2. 点击浏览器工具栏的扩展图标
3. 点击 **翻译当前页** 按钮
4. 点击 **恢复** 可恢复原文

翻译引擎默认使用微软免费翻译。如需更高质量，可在设置中配置 AI 翻译服务。

### 划词翻译

1. 在扩展弹窗中开启 **划词翻译**
2. 在网页上选中一段文字
3. 点击出现的 **翻译** 按钮

### 视频实时字幕

视频字幕功能需要本地后端服务支持。

1. 创建 `.env` 文件（参考下方配置）
2. 启动后端服务

```bash
npm run dev:server
```

3. 重新加载扩展
4. 打开有视频的网页，点击扩展图标
5. 开启 **视频实时翻译**

## 翻译服务配置

扩展弹窗中可直接选择翻译服务，支持以下提供商：

| 服务 | 说明 |
|------|------|
| 微软翻译 | 免费，无需 API Key，速度快 |
| DeepSeek | 国产 AI，性价比高 |
| 小米 MiMo | 小米大模型 |
| Kimi | 月之暗面 |
| GLM / 智谱 | 智谱 AI |
| Qwen / 通义千问 | 阿里云百炼 |
| MiniMax | MiniMax 大模型 |
| 自定义 | 任何 OpenAI / Anthropic 兼容接口 |

## 语音识别服务配置

视频字幕的语音识别支持以下服务：

| 服务 | 说明 |
|------|------|
| 火山引擎 / 豆包 | 默认推荐，流式语音识别 2.0 |
| 阿里云百炼 / Qwen-ASR | 实时语音识别 |
| 腾讯云 ASR | 实时语音识别 |
| 百度智能云 ASR | 实时语音识别 |
| 科大讯飞 | 实时语音转写 |

## 环境变量（本地后端）

创建项目根目录的 `.env` 文件：

```env
# 火山引擎语音识别（默认）
VOLCENGINE_APP_ID=你的AppID
VOLCENGINE_ACCESS_TOKEN=你的AccessToken
VOLCENGINE_RESOURCE_ID=volc.seedasr.sauc.duration
VOLCENGINE_ASR_WS_URL=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async

# 翻译服务（默认微软免费翻译，可不填）
TRANSLATION_PROVIDER=microsoft

# 如使用 AI 翻译（以 DeepSeek 为例）
# TRANSLATION_PROVIDER=ai
# AI_TRANSLATION_BASE_URL=https://api.deepseek.com
# AI_TRANSLATION_API_KEY=你的API密钥
# AI_TRANSLATION_MODEL=deepseek-v4-flash
# AI_TRANSLATION_DISABLE_THINKING=true
```

更多配置项请参考 `.env.example`。

## 技术架构

```
src/
├── manifest.json          # Chrome MV3 扩展清单
├── background.ts          # 后台服务：设置管理、消息转发
├── content/
│   ├── contentScript.ts   # 内容脚本：字幕覆盖层、网页翻译、划词翻译
│   └── contentScript.css  # 字幕样式
├── offscreen/
│   ├── offscreen.ts       # 离屏文档：音频捕获
│   └── audioWorkletProcessor.js  # 音频处理
├── popup/
│   ├── popup.ts           # 扩展弹窗逻辑
│   ├── popup.html         # 弹窗界面
│   └── popup.css          # 弹窗样式
├── pdf/
│   ├── pdfTranslation.ts  # PDF 翻译页面
│   └── pdfTranslation.html
└── types.ts               # 类型定义

scripts/
├── build.mjs              # esbuild 构建脚本
└── realtime-translation-server.mjs  # 本地 ASR + 翻译后端
```

## 开发

```bash
# 类型检查
npm run typecheck

# 构建
npm run build

# 启动本地后端（视频字幕需要）
npm run dev:server
```

`dist/` 目录不纳入版本管理。每次修改代码后需要重新 `npm run build`，然后在浏览器扩展管理页面点击刷新。

## License

MIT
