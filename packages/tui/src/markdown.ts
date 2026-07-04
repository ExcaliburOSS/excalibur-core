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

export type MdSpanStyle =
  | 'plain'
  | 'bold'
  | 'italic'
  | 'code'
  // #3 syntax-highlight token classes (inside a code fence): keyword, string,
  // comment, number, type/Capitalized identifier. Renderers map them to palette
  // colours; a renderer that doesn't know them falls back to the base colour.
  | 'kw'
  | 'str'
  | 'com'
  | 'num'
  | 'ty';

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

// #3 — dependency-free keyword sets for the common language families. A capitalized
// identifier renders as a type; everything else as plain. Deliberately small +
// deterministic (no grammar, no deps): enough to make code READ like code.
const KW_JS = new Set(
  (
    'const let var function return if else for while do switch case break continue new class extends ' +
    'implements interface type enum import export from default async await yield try catch finally throw ' +
    'typeof instanceof in of this super static public private protected readonly void null undefined ' +
    'true false as satisfies keyof namespace declare abstract get set'
  ).split(' '),
);
const KW_PY = new Set(
  (
    'def class return if elif else for while import from as with try except finally raise lambda yield ' +
    'global nonlocal pass break continue in is not and or None True False async await self'
  ).split(' '),
);
const KW_GO = new Set(
  (
    'func return if else for range switch case break continue type struct interface map chan go defer ' +
    'package import var const nil true false'
  ).split(' '),
);
const KW_RUST = new Set(
  (
    'fn let mut return if else for while loop match struct enum trait impl pub use mod const static ' +
    'self Self where async await move ref dyn as in true false'
  ).split(' '),
);

function keywordsFor(lang: string): Set<string> {
  if (/^(py|python)$/.test(lang)) return KW_PY;
  if (lang === 'go') return KW_GO;
  if (/^(rs|rust)$/.test(lang)) return KW_RUST;
  return KW_JS; // ts/tsx/js/jsx/json/… and the default
}

function lineCommentStart(lang: string): string {
  return /^(py|python|sh|bash|zsh|yaml|yml|toml|rb|ruby)$/.test(lang) ? '#' : '//';
}

const IDENT_CHAR = /[A-Za-z0-9_$]/;

/**
 * #3 — a tiny, deterministic, dependency-free syntax highlighter for ONE line of
 * code. Emits {@link MdSpan}s tagged with token classes (kw/str/com/num/ty/plain)
 * so a fenced code snippet READS like an editor. Never throws; a line it can't
 * classify degrades to a single plain span. Line-based (no cross-line block
 * comments) — which is exactly what the per-line markdown model needs.
 */
export function highlightCode(line: string, lang = ''): MdSpan[] {
  const kws = keywordsFor(lang);
  const comment = lineCommentStart(lang);
  const spans: MdSpan[] = [];
  const push = (text: string, style: MdSpanStyle): void => {
    if (text.length > 0) spans.push({ text, style });
  };
  let i = 0;
  while (i < line.length) {
    // Line comment → the rest of the line.
    if (line.startsWith(comment, i)) {
      push(line.slice(i), 'com');
      break;
    }
    const ch = line[i]!;
    // String literal (single/double/back-tick), escape-aware, closed at EOL.
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) {
        if (line[j] === '\\') j += 1;
        j += 1;
      }
      push(line.slice(i, Math.min(j + 1, line.length)), 'str');
      i = j + 1;
      continue;
    }
    // Number (not mid-identifier).
    if (ch >= '0' && ch <= '9' && (i === 0 || !IDENT_CHAR.test(line[i - 1]!))) {
      let j = i;
      while (j < line.length && /[0-9._xa-fA-Fbo]/.test(line[j]!)) j += 1;
      push(line.slice(i, j), 'num');
      i = j;
      continue;
    }
    // Identifier / keyword / type.
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < line.length && IDENT_CHAR.test(line[j]!)) j += 1;
      const word = line.slice(i, j);
      const style: MdSpanStyle = kws.has(word) ? 'kw' : /^[A-Z]/.test(word) ? 'ty' : 'plain';
      push(word, style);
      i = j;
      continue;
    }
    // A run of punctuation / whitespace → plain (stops at the next token start).
    let j = i;
    while (j < line.length && !/[A-Za-z0-9_$"'`]/.test(line[j]!) && !line.startsWith(comment, j)) {
      j += 1;
    }
    push(line.slice(i, Math.max(j, i + 1)), 'plain');
    i = Math.max(j, i + 1);
  }
  return spans.length > 0 ? spans : [{ text: line, style: 'plain' }];
}

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
      const isDiff = fenceLang === 'diff' || fenceLang === 'patch';
      const kind: MdLineKind = isDiff
        ? raw.startsWith('+')
          ? 'code-add'
          : raw.startsWith('-')
            ? 'code-del'
            : raw.startsWith('@@')
              ? 'code-meta'
              : 'code'
        : 'code';
      // #3 — a plain code line is SYNTAX-HIGHLIGHTED into token spans; diff lines
      // keep their single plain span (they carry their own add/del/meta colour).
      const spans =
        isDiff || kind !== 'code'
          ? [{ text: raw, style: 'plain' as const }]
          : highlightCode(raw, fenceLang);
      out.push({ kind, spans });
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
