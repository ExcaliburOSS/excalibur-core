/**
 * Canonical prompt-injection scanner (F8) for ALL untrusted inbound content —
 * fetched web pages (web_fetch/web_search/web_extract/web_crawl/research) AND
 * MCP tool output (F6's mcp/injection-scan re-exports this, so there is ONE
 * detector and one "this is data, not instructions" contract). Pure heuristics:
 * no deps, no network, ReDoS-bounded.
 *
 * Signals are STRUCTURAL (not a per-language keyword gate): instruction-override,
 * role/system injection, exfiltration (verb + URL/secret, or a high-entropy token
 * next to an exfil verb), tool-call bait, hidden text (zero-width / bidi / HTML
 * comments / display:none), and fence breakout. Each category contributes a
 * weight to a 0–100 score; thresholds map the score to clean | suspicious |
 * malicious. `cleaned` strips hidden characters so they never reach the model.
 */

export type InjectionVerdict = 'clean' | 'suspicious' | 'malicious';

export interface InjectionSignal {
  category: string;
  weight: number;
  evidence: string;
}

export interface InjectionScanResult {
  verdict: InjectionVerdict;
  /** 0–100. */
  score: number;
  signals: InjectionSignal[];
  /** The text with zero-width / bidi / BOM characters stripped. */
  cleaned: string;
}

export interface InjectionThresholds {
  maliciousThreshold?: number;
  suspiciousThreshold?: number;
}

const MAX_LINE = 2000;
const DEFAULT_MALICIOUS = 70;
const DEFAULT_SUSPICIOUS = 30;

/** Zero-width, bidi-control, and BOM characters used to hide instructions. */
const HIDDEN_CHARS_RE = /[​-‏‪-‮⁦-⁩﻿]/g;

/** Strips hidden (zero-width / bidi / BOM) characters from `text`. */
export function stripHidden(text: string): string {
  return text.replace(HIDDEN_CHARS_RE, '');
}

/** A long, high-entropy token (likely a secret/key) — Shannon entropy, bounded. */
function looksHighEntropy(token: string): boolean {
  if (token.length < 20) return false;
  const freq = new Map<string, number>();
  for (const ch of token) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / token.length;
    entropy -= p * Math.log2(p);
  }
  return entropy >= 3.5;
}

interface Detector {
  category: string;
  weight: number;
  test: (line: string) => boolean;
}

const DETECTORS: Detector[] = [
  {
    category: 'instruction-override',
    weight: 50,
    test: (l) =>
      /\b(ignore|disregard|forget|override|olvida|ignora|ignorez|oubliez|missachte)\b[\s\S]{0,40}\b(previous|above|prior|earlier|all|anterior|précédent|vorher|system)\b[\s\S]{0,24}\b(instruction|instrucc|prompt|rule|regla|règle|anweisung)/i.test(
        l,
      ),
  },
  {
    category: 'role-injection',
    weight: 50,
    test: (l) =>
      /(^|\s)(system|assistant)\s*:/i.test(l) ||
      /<\/?\s*(system|assistant|tool)\b/i.test(l) ||
      /\[\s*(system|assistant)\s*\]/i.test(l) ||
      /\b(you are now|act as|new system prompt|disregard your)\b/i.test(l),
  },
  {
    category: 'exfiltration',
    weight: 50,
    test: (l) => {
      if (
        /\b(send|post|exfiltrate|upload|leak|email|curl|fetch)\b[\s\S]{0,40}(https?:\/\/|api[_-]?key|secret|token|password|credential)/i.test(
          l,
        )
      ) {
        return true;
      }
      // A high-entropy token adjacent to an exfil verb (e.g. "send sk-AbCd…").
      if (/\b(send|post|leak|exfiltrate|email)\b/i.test(l)) {
        return l.split(/\s+/).some((t) => looksHighEntropy(t));
      }
      return false;
    },
  },
  {
    category: 'tool-bait',
    weight: 25,
    test: (l) =>
      /\b(call|invoke|run|use)\s+(the\s+)?(tool|function|web_fetch|run_command|apply_patch|write_file)\b/i.test(
        l,
      ),
  },
  {
    category: 'hidden-text',
    weight: 30,
    test: (l) =>
      HIDDEN_CHARS_RE.test(l) ||
      /<!--[\s\S]{0,200}(ignore|system|instruction)/i.test(l) ||
      /(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(l),
  },
  {
    category: 'fence-breakout',
    weight: 30,
    test: (l) => /```[\s\S]{0,20}(system|assistant|instruction)/i.test(l),
  },
];

/** Scans `text` for structural injection signals → scored verdict + cleaned text. */
export function scanForInjection(
  text: string,
  thresholds: InjectionThresholds = {},
): InjectionScanResult {
  const malicious = thresholds.maliciousThreshold ?? DEFAULT_MALICIOUS;
  const suspicious = thresholds.suspiciousThreshold ?? DEFAULT_SUSPICIOUS;
  const found = new Map<string, InjectionSignal>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.length > MAX_LINE ? rawLine.slice(0, MAX_LINE) : rawLine;
    for (const detector of DETECTORS) {
      if (!found.has(detector.category)) {
        // Reset lastIndex on the global hidden-chars regex before .test in detectors.
        HIDDEN_CHARS_RE.lastIndex = 0;
        if (detector.test(line)) {
          found.set(detector.category, {
            category: detector.category,
            weight: detector.weight,
            evidence: line.trim().slice(0, 120),
          });
        }
      }
    }
  }
  const signals = [...found.values()];
  const score = Math.min(
    100,
    signals.reduce((sum, s) => sum + s.weight, 0),
  );
  const verdict: InjectionVerdict =
    score >= malicious ? 'malicious' : score >= suspicious ? 'suspicious' : 'clean';
  return { verdict, score, signals, cleaned: stripHidden(text) };
}
