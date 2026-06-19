import { globFiles, readTextFile, toPosixPath } from '../internal/fs-utils';
import { isSecretPath } from './secret-paths';

/**
 * Deterministic, dependency-free lexical code retrieval (M2, Slice 2).
 *
 * Pure function of the repository contents and the query: NO AST, NO
 * embeddings, NO persisted index, NO network. Results are byte-identical
 * across runs (stable tokenization, deterministic globbing already sorted by
 * `globFiles`, POSIX-ascending tie-breaks). Designed to feed
 * `buildRepoContextSources`, which injects hits through the existing
 * `EffectiveInstructionBuilder.render()` so secret redaction and the
 * per-source / total caps apply automatically.
 *
 * Security: credential-bearing files (`.env*`, key files, `secrets/` /
 * `credentials/` directories) are excluded up front via {@link isSecretPath};
 * they can never become a retrieval hit.
 */

export interface CodeSearchOptions {
  /** Free-text query (a question, a file's identifiers, …). */
  query: string;
  /**
   * Repo-relative POSIX path the search is anchored to (the file under
   * `explain`/`review`). Files in the same directory, and files referenced by
   * a relative import in the anchor, get a relevance boost.
   */
  anchorPath?: string;
  /** Maximum number of files returned. Default 8. */
  maxFiles?: number;
  /** Per-file snippet character budget. Default 1200. */
  maxSnippetChars?: number;
  /** Total snippet character budget across all returned hits. Default 12000. */
  totalCharBudget?: number;
  /** Extra glob ignore patterns merged with the defaults. */
  extraIgnore?: string[];
  /** Glob include patterns. Defaults to the code-extension set. */
  include?: string[];
  /** Hard cap on the number of candidate files scanned. Default 2000. */
  maxScanFiles?: number;
}

export interface CodeSnippet {
  /** 1-based inclusive start line. */
  startLine: number;
  /** 1-based inclusive end line. */
  endLine: number;
  text: string;
}

export interface CodeSearchHit {
  /** Repo-relative POSIX path. */
  path: string;
  /** Relevance score normalized to 0..1. */
  score: number;
  snippets: CodeSnippet[];
  /** Human-readable scoring reasons (path match, coverage, anchor, …). */
  reasons: string[];
}

export interface CodeSearchResult {
  hits: CodeSearchHit[];
  stats: {
    scanned: number;
    matched: number;
    /** True when files or snippets were dropped to fit the caps/budgets. */
    truncated: boolean;
  };
  /** Normalized query terms actually used for scoring. */
  terms: string[];
}

const DEFAULT_MAX_FILES = 8;
const DEFAULT_MAX_SNIPPET_CHARS = 1200;
const DEFAULT_TOTAL_CHAR_BUDGET = 12000;
const DEFAULT_MAX_SCAN_FILES = 2000;

const DEFAULT_INCLUDE = [
  '**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,rb,php,cs,kt,swift,scala,c,h,cpp,hpp,vue,svelte,sql,md}',
];

/** Patterns skipped on top of the global SCAN_IGNORE (handled by globFiles). */
const EXTRA_DEFAULT_IGNORE = [
  '**/*.min.*',
  '**/*.map',
  '**/*.snap',
  '**/*-lock.json',
  '**/*.lock',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/bun.lockb',
];

/** Small fixed stopword set (English + code prose). */
const STOPWORDS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'for',
  'are',
  'was',
  'were',
  'this',
  'that',
  'with',
  'from',
  'into',
  'how',
  'what',
  'where',
  'when',
  'which',
  'does',
  'has',
  'have',
  'had',
  'can',
  'will',
  'should',
  'would',
  'about',
  'there',
  'here',
  'its',
  'our',
  'your',
  'their',
  'all',
  'any',
  'use',
  'used',
  'using',
  'get',
  'set',
  'not',
  'but',
  'you',
]);

/** Short terms kept despite the <3-char drop rule. */
const SHORT_TERM_WHITELIST: ReadonlySet<string> = new Set(['db', 'id', 'ui']);

const SNIPPET_CONTEXT_LINES = 3;
const TF_CAP_PER_TERM = 5;
const SNIPPET_TRUNCATION_MARKER = '…';

/** Exported-declaration shapes across the supported languages. */
const DECLARATION_PATTERN =
  /\b(?:export\s+(?:async\s+)?(?:function|class|const|interface|type|enum)\b|def\s+\w|func\s+\w|pub\s+fn\s+\w|class\s+\w)/;

/**
 * Splits an identifier or phrase into normalized lowercase tokens. Handles
 * camelCase, snake_case, kebab-case and PascalCase, and any non-alphanumeric
 * boundary.
 */
function splitTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0);
}

/** Light stemming: strip a single trailing `ing`/`ed`/`s`. */
function stem(token: string): string {
  if (token.length > 5 && token.endsWith('ing')) {
    return token.slice(0, -3);
  }
  if (token.length > 4 && token.endsWith('ed')) {
    return token.slice(0, -2);
  }
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
    return token.slice(0, -1);
  }
  return token;
}

function keepTerm(token: string): boolean {
  if (SHORT_TERM_WHITELIST.has(token)) {
    return true;
  }
  if (token.length < 3) {
    return false;
  }
  return !STOPWORDS.has(token);
}

/**
 * Tokenizes a query into a deterministic, sorted, de-duplicated term set.
 * Keeps both the raw and stemmed variant so identifier matches still land.
 */
export function tokenizeQuery(query: string): string[] {
  const terms = new Set<string>();
  for (const raw of splitTokens(query)) {
    // A stopword is dropped whole — its stem must not leak back in.
    if (STOPWORDS.has(raw)) {
      continue;
    }
    if (keepTerm(raw)) {
      terms.add(raw);
    }
    const stemmed = stem(raw);
    if (stemmed !== raw && keepTerm(stemmed)) {
      terms.add(stemmed);
    }
  }
  return [...terms].sort();
}

interface ScoredFile {
  path: string;
  score: number;
  reasons: string[];
  /** 1-based line numbers (sorted, unique) where any term matched. */
  matchLines: number[];
  lines: string[];
}

function dirOf(posixPath: string): string {
  const slash = posixPath.lastIndexOf('/');
  return slash >= 0 ? posixPath.slice(0, slash) : '';
}

function basenameOf(posixPath: string): string {
  const slash = posixPath.lastIndexOf('/');
  return slash >= 0 ? posixPath.slice(slash + 1) : posixPath;
}

/**
 * Collects the relative-import targets referenced by `content` (single-hop
 * string scan only — NO module resolution). Returns the imported basenames
 * (without extension) so the anchor boost can match neighbor files.
 */
function importedBasenames(content: string): Set<string> {
  const result = new Set<string>();
  const importRe = /(?:from|require\s*\(|import\s*\(?)\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(content)) !== null) {
    const spec = match[1];
    if (spec === undefined || (!spec.startsWith('.') && !spec.startsWith('/'))) {
      continue;
    }
    const base = basenameOf(spec).replace(/\.[^.]+$/, '');
    if (base.length > 0 && base !== 'index') {
      result.add(base.toLowerCase());
    }
  }
  return result;
}

/** Scores a single file against the query terms; returns null when no match. */
function scoreFile(
  relPath: string,
  content: string,
  terms: string[],
  anchor: { dir: string; imports: Set<string> } | null,
): ScoredFile | null {
  const lines = content.split('\n');
  const lowerPath = relPath.toLowerCase();
  const fileName = basenameOf(lowerPath);
  const reasons: string[] = [];

  let score = 0;
  const termsPresent = new Set<string>();
  const matchLines = new Set<number>();

  // (a) path / filename term match ×3.
  let pathHits = 0;
  for (const term of terms) {
    if (lowerPath.includes(term)) {
      pathHits += 1;
      termsPresent.add(term);
    }
  }
  if (pathHits > 0) {
    score += pathHits * 3;
    reasons.push(`path matches ${pathHits} term(s)`);
  }

  // (b) content term frequency ×1 (cap 5/term) + exact-case identifier +0.5,
  //     plus structural ×1.5 boost for declaration lines containing a term.
  const lowerLines = lines.map((line) => line.toLowerCase());
  for (const term of terms) {
    let tf = 0;
    let exactCaseSeen = false;
    for (let i = 0; i < lines.length; i += 1) {
      const lower = lowerLines[i] ?? '';
      if (!lower.includes(term)) {
        continue;
      }
      tf += 1;
      termsPresent.add(term);
      matchLines.add(i + 1);
      if (!exactCaseSeen && (lines[i] ?? '').includes(term)) {
        // term appears with its exact (already-lowercase) spelling — identifier hit.
        exactCaseSeen = true;
      }
      if (DECLARATION_PATTERN.test(lines[i] ?? '')) {
        score += 1.5;
      }
    }
    if (tf > 0) {
      score += Math.min(tf, TF_CAP_PER_TERM);
      if (exactCaseSeen) {
        score += 0.5;
      }
    }
  }

  // (c) term coverage ×2 (fraction of distinct terms present).
  if (termsPresent.size > 0) {
    const coverage = termsPresent.size / terms.length;
    score += coverage * 2;
    reasons.push(`covers ${termsPresent.size}/${terms.length} terms`);
  }

  // (d) anchor / neighbor boost ×2. A same-dir or imported neighbor is a hit
  //     even with zero query-term overlap — the anchor relationship IS the
  //     signal (powers `explain`/`review` neighbor context).
  let anchoredNeighbor = false;
  if (anchor !== null) {
    const sameDir = dirOf(relPath) === anchor.dir;
    const importedNeighbor = anchor.imports.has(fileName.replace(/\.[^.]+$/, ''));
    if (sameDir) {
      score += 2;
      anchoredNeighbor = true;
      reasons.push('same directory as anchor');
    }
    if (importedNeighbor) {
      score += 2;
      anchoredNeighbor = true;
      reasons.push('imported by anchor');
    }
  }

  if (termsPresent.size === 0 && !anchoredNeighbor) {
    return null;
  }

  // For an anchored neighbor with no term match, seed snippet windows from the
  // file's declaration lines (or its head) so the injected context is useful.
  if (matchLines.size === 0) {
    let seeded = 0;
    for (let i = 0; i < lines.length && seeded < 3; i += 1) {
      if (DECLARATION_PATTERN.test(lines[i] ?? '')) {
        matchLines.add(i + 1);
        seeded += 1;
      }
    }
    if (matchLines.size === 0) {
      matchLines.add(1);
    }
  }

  return {
    path: relPath,
    score,
    reasons,
    matchLines: [...matchLines].sort((a, b) => a - b),
    lines,
  };
}

interface RawWindow {
  start: number;
  end: number;
}

/** Merges ±context windows around match lines into non-overlapping ranges. */
function buildWindows(matchLines: number[], lineCount: number): RawWindow[] {
  const windows: RawWindow[] = [];
  for (const line of matchLines) {
    const start = Math.max(1, line - SNIPPET_CONTEXT_LINES);
    const end = Math.min(lineCount, line + SNIPPET_CONTEXT_LINES);
    const last = windows[windows.length - 1];
    if (last !== undefined && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      windows.push({ start, end });
    }
  }
  return windows;
}

/** Whether a window contains a declaration line (preferred when truncating). */
function windowHasDeclaration(lines: string[], window: RawWindow): boolean {
  for (let i = window.start; i <= window.end; i += 1) {
    if (DECLARATION_PATTERN.test(lines[i - 1] ?? '')) {
      return true;
    }
  }
  return false;
}

/** Extracts snippets for a file, capped at `maxSnippetChars`. */
function extractSnippets(
  scored: ScoredFile,
  maxSnippetChars: number,
): { snippets: CodeSnippet[]; truncated: boolean } {
  const windows = buildWindows(scored.matchLines, scored.lines.length);
  // Declaration-bearing windows first, then by position — deterministic.
  const ordered = windows
    .map((window, index) => ({
      window,
      index,
      declaration: windowHasDeclaration(scored.lines, window),
    }))
    .sort((a, b) => {
      if (a.declaration !== b.declaration) {
        return a.declaration ? -1 : 1;
      }
      return a.index - b.index;
    });

  const snippets: CodeSnippet[] = [];
  let used = 0;
  let truncated = false;
  for (const { window } of ordered) {
    const text = scored.lines.slice(window.start - 1, window.end).join('\n');
    const remaining = maxSnippetChars - used;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (text.length <= remaining) {
      snippets.push({ startLine: window.start, endLine: window.end, text });
      used += text.length;
    } else {
      const clipped = `${text.slice(0, Math.max(0, remaining - SNIPPET_TRUNCATION_MARKER.length)).trimEnd()}\n${SNIPPET_TRUNCATION_MARKER}`;
      snippets.push({ startLine: window.start, endLine: window.end, text: clipped });
      used += clipped.length;
      truncated = true;
      break;
    }
  }

  // Restore document order for stable, readable output.
  snippets.sort((a, b) => a.startLine - b.startLine);
  return { snippets, truncated };
}

/**
 * Deterministic lexical code search over `repoRoot`. Never throws on
 * unreadable files (they are skipped). Returns an empty hit list when the
 * query yields no usable terms.
 */
export async function searchRepoCode(
  repoRoot: string,
  options: CodeSearchOptions,
): Promise<CodeSearchResult> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxSnippetChars = options.maxSnippetChars ?? DEFAULT_MAX_SNIPPET_CHARS;
  const totalCharBudget = options.totalCharBudget ?? DEFAULT_TOTAL_CHAR_BUDGET;
  const maxScanFiles = options.maxScanFiles ?? DEFAULT_MAX_SCAN_FILES;
  const include = options.include ?? DEFAULT_INCLUDE;

  const terms = tokenizeQuery(options.query);
  if (terms.length === 0) {
    return { hits: [], stats: { scanned: 0, matched: 0, truncated: false }, terms: [] };
  }

  // (2) Enumerate candidates. globFiles already applies SCAN_IGNORE + sorting.
  const ignore = [...EXTRA_DEFAULT_IGNORE, ...(options.extraIgnore ?? [])];
  const globbed = await globFiles(repoRoot, [...include, ...ignore.map((p) => `!${p}`)]);

  // Exclude secret-bearing paths up front (security invariant). The negated
  // ignore patterns above are best-effort; this is the authoritative filter.
  const candidates = globbed.map(toPosixPath).filter((relPath) => !isSecretPath(relPath));

  const truncatedScan = candidates.length > maxScanFiles;
  const scanList = candidates.slice(0, maxScanFiles);

  // Anchor context: same-dir + relative-import neighbors (single-hop).
  let anchor: { dir: string; imports: Set<string> } | null = null;
  if (options.anchorPath !== undefined && options.anchorPath.length > 0) {
    const anchorRel = toPosixPath(options.anchorPath);
    const anchorContent = await readTextFile(`${repoRoot}/${anchorRel}`);
    anchor = {
      dir: dirOf(anchorRel),
      imports: anchorContent !== null ? importedBasenames(anchorContent) : new Set<string>(),
    };
  }

  // (3) Score each candidate file.
  const scored: ScoredFile[] = [];
  let scanned = 0;
  for (const relPath of scanList) {
    // Never score the anchor file itself.
    if (anchor !== null && relPath === toPosixPath(options.anchorPath ?? '')) {
      continue;
    }
    const content = await readTextFile(`${repoRoot}/${relPath}`);
    scanned += 1;
    if (content === null) {
      continue;
    }
    const fileScore = scoreFile(relPath, content, terms, anchor);
    if (fileScore !== null) {
      scored.push(fileScore);
    }
  }

  const matched = scored.length;
  if (matched === 0) {
    return {
      hits: [],
      stats: { scanned, matched: 0, truncated: truncatedScan },
      terms,
    };
  }

  // Normalize scores to 0..1; tie-break by POSIX path ascending.
  const maxScore = scored.reduce((max, file) => Math.max(max, file.score), 0);
  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  // (5) Keep top maxFiles, then accumulate snippets until totalCharBudget.
  const kept = scored.slice(0, maxFiles);
  let droppedFiles = scored.length > maxFiles || truncatedScan;

  const hits: CodeSearchHit[] = [];
  let totalUsed = 0;
  for (const file of kept) {
    const { snippets, truncated: snippetTruncated } = extractSnippets(file, maxSnippetChars);
    if (snippetTruncated) {
      droppedFiles = true;
    }
    const fitted: CodeSnippet[] = [];
    for (const snippet of snippets) {
      if (totalUsed >= totalCharBudget) {
        droppedFiles = true;
        break;
      }
      const remaining = totalCharBudget - totalUsed;
      if (snippet.text.length <= remaining) {
        fitted.push(snippet);
        totalUsed += snippet.text.length;
      } else {
        const clipped = `${snippet.text.slice(0, Math.max(0, remaining - SNIPPET_TRUNCATION_MARKER.length)).trimEnd()}\n${SNIPPET_TRUNCATION_MARKER}`;
        fitted.push({ startLine: snippet.startLine, endLine: snippet.endLine, text: clipped });
        totalUsed = totalCharBudget;
        droppedFiles = true;
        break;
      }
    }
    if (fitted.length === 0) {
      droppedFiles = true;
      continue;
    }
    hits.push({
      path: file.path,
      score: maxScore > 0 ? Math.round((file.score / maxScore) * 1e6) / 1e6 : 0,
      snippets: fitted,
      reasons: file.reasons,
    });
  }

  return {
    hits,
    stats: { scanned, matched, truncated: droppedFiles },
    terms,
  };
}
