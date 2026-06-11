interface PdfTranslationData {
  title: string;
  sourceUrl: string;
  createdAt: number;
  paragraphs: Array<{ source: string; translation: string }>;
}

const STORAGE_PREFIX = "pdfTranslation:";

const titleEl = getElement<HTMLHeadingElement>("title");
const sourceEl = getElement<HTMLAnchorElement>("source");
const contentEl = getElement<HTMLElement>("content");

void init();

async function init(): Promise<void> {
  const id = new URLSearchParams(location.search).get("id");
  if (!id) {
    renderError("缺少 PDF 翻译结果编号。");
    return;
  }

  const key = `${STORAGE_PREFIX}${id}`;
  const stored = await chrome.storage.local.get(key);
  const data = stored[key] as PdfTranslationData | undefined;
  if (!data) {
    renderError("没有找到这个 PDF 翻译结果。");
    return;
  }

  titleEl.textContent = data.title || "PDF 翻译";
  sourceEl.href = data.sourceUrl;
  sourceEl.textContent = "打开原始 PDF";
  renderParagraphs(data.paragraphs);
}

function renderParagraphs(paragraphs: PdfTranslationData["paragraphs"]): void {
  contentEl.textContent = "";
  if (paragraphs.length === 0) {
    contentEl.append(createElement("p", "empty", "这个 PDF 没有可选择的文本。扫描版 PDF 需要 OCR 支持。"));
    return;
  }

  for (const paragraph of paragraphs) {
    const article = document.createElement("article");
    article.className = "paragraph";
    article.append(
      createElement("p", "translation", paragraph.translation || paragraph.source),
      createElement("p", "source", paragraph.source),
    );
    contentEl.append(article);
  }
}

function renderError(message: string): void {
  titleEl.textContent = "PDF 翻译不可用";
  sourceEl.removeAttribute("href");
  sourceEl.textContent = "";
  contentEl.textContent = "";
  contentEl.append(createElement("p", "empty", message));
}

function createElement(tagName: "p", className: string, text: string): HTMLParagraphElement {
  const element = document.createElement(tagName);
  element.className = className;
  element.textContent = text;
  return element;
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}
