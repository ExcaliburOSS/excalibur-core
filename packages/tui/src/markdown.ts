/**
 * D2 (F1.5) — the shared MARKDOWN model for agent prose. The agent's narration is
 * the product's primary output and it used to print raw (`##`, `>`, backticks and
 * fences as literal grey italics — the TUI audit's second-loudest defect). This is
 * a deliberately small, LINE-based transformer: it never throws, renders partial
 * input gracefully (a streaming narration re-parses per frame, so an unclosed
 * fence or an unbalanced `**` must degrade to literal text, never corrupt), and
 * returns a pure model both presenters can style (Ink maps spans to <Text>
 * colours; an ANSI renderer can map the same spans through picocolors).
 */

export type MdSpanStyle = 'plain' | 'bold' | 'italic' | 'code';

export interface MdSpan {
  text: string;
  style: MdSpanStyle;
}

export type MdLineKind =
  | 'heading'
  | 'quote'
  | 'bullet'
  | 'code'
  | 'code-add'
  | 'code-del'
  | 'code-meta'
  | 'blank'
  | 'text';

export interface MdLine {
  kind: MdLineKind;
  spans: MdSpan[];
  /** Ordered-list marker (`2.`) or `•` for bullets; undefined otherwise. */
  marker?: string;
}

/** Splits inline `code`, **bold** and *italic* runs; unbalanced markers stay literal. */
export function inlineSpans(text: string): MdSpan[] {
  const spans: MdSpan[] = [];
  // Tokenize on the three inline forms. Each alternative captures its INNER text;
  // an opener without a closer simply never matches and flows through as plain.
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|(?<![\w*])\*([^*\s][^*]*)\*(?![\w*])/g;
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index > last) {
      spans.push({ text: text.slice(last, m.index), style: 'plain' });
    }
    if (m[1] !== undefined) {
      spans.push({ text: m[1], style: 'code' });
    } else if (m[2] !== undefined) {
      spans.push({ text: m[2], style: 'bold' });
    } else if (m[3] !== undefined) {
      spans.push({ text: m[3], style: 'italic' });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    spans.push({ text: text.slice(last), style: 'plain' });
  }
  return spans.length > 0 ? spans : [{ text: '', style: 'plain' }];
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}(\d{1,3})\.\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const FENCE = /^\s{0,3}(```|~~~)\s*([\w+-]*)\s*$/;

/**
 * Parses prose into styled lines. Fence state is tracked across lines so a
 * still-streaming (unclosed) block renders as code rather than flipping the rest
 * of the message into literal backticks.
 */
export function parseMarkdown(text: string): MdLine[] {
  const out: MdLine[] = [];
  let inFence = false;
  let fenceLang = '';
  for (const raw of text.split('\n')) {
    const fence = FENCE.exec(raw);
    if (fence !== null) {
      inFence = !inFence;
      fenceLang = inFence ? (fence[2] ?? '').toLowerCase() : '';
      continue; // the fence line itself is chrome, not content
    }
    if (inFence) {
      const kind: MdLineKind =
        fenceLang === 'diff' || fenceLang === 'patch'
          ? raw.startsWith('+')
            ? 'code-add'
            : raw.startsWith('-')
              ? 'code-del'
              : raw.startsWith('@@')
                ? 'code-meta'
                : 'code'
          : 'code';
      out.push({ kind, spans: [{ text: raw, style: 'plain' }] });
      continue;
    }
    if (raw.trim().length === 0) {
      out.push({ kind: 'blank', spans: [{ text: '', style: 'plain' }] });
      continue;
    }
    const heading = HEADING.exec(raw);
    if (heading !== null) {
      out.push({ kind: 'heading', spans: inlineSpans(heading[2] ?? '') });
      continue;
    }
    const quote = QUOTE.exec(raw);
    if (quote !== null) {
      out.push({ kind: 'quote', spans: inlineSpans(quote[1] ?? '') });
      continue;
    }
    const ordered = ORDERED.exec(raw);
    if (ordered !== null) {
      out.push({ kind: 'bullet', marker: `${ordered[1]}.`, spans: inlineSpans(ordered[2] ?? '') });
      continue;
    }
    const bullet = BULLET.exec(raw);
    if (bullet !== null) {
      out.push({ kind: 'bullet', marker: '•', spans: inlineSpans(bullet[1] ?? '') });
      continue;
    }
    out.push({ kind: 'text', spans: inlineSpans(raw) });
  }
  // Trim leading/trailing blanks — the surrounding layout owns the breathing room.
  while (out.length > 0 && out[0]?.kind === 'blank') {
    out.shift();
  }
  while (out.length > 0 && out[out.length - 1]?.kind === 'blank') {
    out.pop();
  }
  return out;
}
