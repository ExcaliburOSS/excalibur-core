import { Defuddle } from 'defuddle/node';

/** Main-content extraction result: a clean title + LLM-ready markdown. */
export interface ExtractedHtml {
  title: string;
  markdown: string;
}

/**
 * Extracts the main readable content of an HTML page as markdown (scripts,
 * styles, nav, chrome stripped) via defuddle — the same article extractor used
 * by readers, with a built-in DOM (no jsdom). Best-effort: on any failure it
 * falls back to a crude tag-strip so `web_fetch` always returns *something*.
 */
export async function htmlToMarkdown(html: string, url: string): Promise<ExtractedHtml> {
  try {
    const res = await Defuddle(html, url, { markdown: true });
    const markdown = (res.contentMarkdown ?? res.content ?? '').trim();
    const title = (res.title ?? '').trim();
    if (markdown.length > 0) {
      return { title, markdown };
    }
  } catch {
    // fall through to the crude fallback
  }
  return { title: crudeTitle(html), markdown: crudeStrip(html) };
}

/** Dependency-free last resort: drop scripts/styles, strip tags, collapse space. */
function crudeStrip(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function crudeTitle(html: string): string {
  return (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim();
}
