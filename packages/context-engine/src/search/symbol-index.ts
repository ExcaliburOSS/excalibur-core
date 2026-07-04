import { toPosixPath } from '../internal/fs-utils';

/**
 * G4 (Phase-G) — a LOCAL, deterministic, dependency-free SYMBOL index.
 *
 * Pure lexical content search degrades on a very large repo: a query naming a
 * definition (`computeScope`, `MissionState`, `runSwarmFlow`) has to compete with
 * every incidental mention of that identifier. This index extracts DEFINITIONS
 * (functions, classes, types, interfaces, top-level consts, …) per file with
 * language-aware regexes — NO tree-sitter, NO embeddings, NO network, byte-stable
 * across runs — so retrieval can jump straight to where a symbol is DEFINED and
 * surface the right file even when the content match is diluted.
 *
 * It complements (never replaces) the lexical search: {@link searchCode} folds a
 * `defines <symbol>` boost into its score, and the lexical pass still runs.
 */

/** A single definition site. */
export interface SymbolDef {
  /** The defined identifier, verbatim. */
  name: string;
  /** Repo-relative POSIX path of the defining file. */
  path: string;
  /** 1-based line of the definition. */
  line: number;
  /** What kind of definition (function, class, type, …) — for display/ranking. */
  kind: string;
}

/** The built index: exact-name lookup + a lowercased lookup for case-tolerant queries. */
export interface SymbolIndex {
  /** name → definition sites (exact). */
  byName: ReadonlyMap<string, ReadonlyArray<SymbolDef>>;
  /** lowercased name → definition sites (case-insensitive lookups). */
  byLowerName: ReadonlyMap<string, ReadonlyArray<SymbolDef>>;
  /** All definition sites, in deterministic (path, line) order. */
  all: ReadonlyArray<SymbolDef>;
}

/** One definition pattern for a language family: a regex whose first group is the name. */
interface DefPattern {
  re: RegExp;
  kind: string;
}

// Deterministic, dependency-free definition patterns. Anchored to line starts (with
// optional leading keywords) so incidental mentions are NOT matched as definitions.
const JS_TS: DefPattern[] = [
  {
    re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
    kind: 'function',
  },
  {
    re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    kind: 'class',
  },
  { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
  { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/, kind: 'type' },
  { re: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum' },
  // Top-level const/let assigned a value (incl. arrow fns / objects) — the common
  // "export const X = …" definition. Requires a `=` to avoid matching declarations in prose.
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/, kind: 'const' },
];

const PY: DefPattern[] = [
  { re: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/, kind: 'function' },
  { re: /^\s*class\s+([A-Za-z_][\w]*)/, kind: 'class' },
];

const GO: DefPattern[] = [
  { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/, kind: 'function' },
  { re: /^\s*type\s+([A-Za-z_][\w]*)\s+/, kind: 'type' },
];

const RUST: DefPattern[] = [
  { re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/, kind: 'function' },
  { re: /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_][\w]*)/, kind: 'type' },
];

const JVM: DefPattern[] = [
  {
    re: /^\s*(?:public|private|protected|final|abstract|static|\s)*class\s+([A-Za-z_][\w]*)/,
    kind: 'class',
  },
  { re: /^\s*(?:public|private|protected|\s)*interface\s+([A-Za-z_][\w]*)/, kind: 'interface' },
];

function patternsFor(path: string): DefPattern[] {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
    case 'mts':
    case 'cts':
      return JS_TS;
    case 'py':
      return PY;
    case 'go':
      return GO;
    case 'rs':
      return RUST;
    case 'java':
    case 'kt':
    case 'scala':
    case 'cs':
      return JVM;
    default:
      return [];
  }
}

/** Extracts the definition sites from ONE file's text (pure; deterministic). */
export function extractSymbols(path: string, text: string): SymbolDef[] {
  const patterns = patternsFor(path);
  if (patterns.length === 0) {
    return [];
  }
  const posix = toPosixPath(path);
  const out: SymbolDef[] = [];
  const seen = new Set<string>(); // dedupe name@line within a file
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    // Skip obvious comment lines cheaply (a definition keyword in a comment is not a def).
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) {
      continue;
    }
    for (const { re, kind } of patterns) {
      const m = re.exec(line);
      const name = m?.[1];
      if (name !== undefined && name.length > 0) {
        const key = `${name}@${i}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ name, path: posix, line: i + 1, kind });
        }
      }
    }
  }
  return out;
}

/** Builds a {@link SymbolIndex} from a set of files (pure; deterministic order). */
export function buildSymbolIndex(
  files: ReadonlyArray<{ path: string; text: string }>,
): SymbolIndex {
  const all: SymbolDef[] = [];
  for (const f of files) {
    all.push(...extractSymbols(f.path, f.text));
  }
  // Deterministic order: by path, then line, then name.
  all.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || (a.name < b.name ? -1 : 1),
  );
  const byName = new Map<string, SymbolDef[]>();
  const byLowerName = new Map<string, SymbolDef[]>();
  for (const d of all) {
    (byName.get(d.name) ?? byName.set(d.name, []).get(d.name)!).push(d);
    const lower = d.name.toLowerCase();
    (byLowerName.get(lower) ?? byLowerName.set(lower, []).get(lower)!).push(d);
  }
  return { byName, byLowerName, all };
}

/** A symbol-search hit: a file and the query symbols it DEFINES. */
export interface SymbolHit {
  path: string;
  /** The matched definition names in this file. */
  symbols: string[];
  /** Higher = more/stronger symbol matches. */
  score: number;
}

/**
 * Finds files that DEFINE the query's identifier-like terms. An exact-name match
 * scores highest; a case-insensitive match scores a bit less. Returns files ranked
 * by match strength (deterministic tie-break by path), capped to `maxFiles`.
 */
export function searchSymbols(
  index: SymbolIndex,
  terms: ReadonlyArray<string>,
  maxFiles = 8,
): SymbolHit[] {
  const perFile = new Map<string, { symbols: Set<string>; score: number }>();
  const bump = (d: SymbolDef, weight: number): void => {
    const entry = perFile.get(d.path) ?? { symbols: new Set<string>(), score: 0 };
    entry.symbols.add(d.name);
    entry.score += weight;
    perFile.set(d.path, entry);
  };
  for (const raw of terms) {
    const term = raw.trim();
    if (term.length < 3) {
      continue; // too short to be a meaningful symbol query
    }
    const exact = index.byName.get(term);
    if (exact !== undefined) {
      for (const d of exact) bump(d, 3);
      continue;
    }
    const ci = index.byLowerName.get(term.toLowerCase());
    if (ci !== undefined) {
      for (const d of ci) bump(d, 2);
    }
  }
  return [...perFile.entries()]
    .map(([path, v]) => ({ path, symbols: [...v.symbols].sort(), score: v.score }))
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, Math.max(0, maxFiles));
}
