import { type ModelGateway } from '@excalibur/model-gateway';
import { makeCitedSource, renderCitedReport, type CitedSource } from './citations';
import { verifyClaim, type ClaimVerdict } from './claim-verifier';

/**
 * Native multi-agent deep-research pipeline (F7): plan sub-queries → fan-out web
 * search → fetch the top sources (hashed + timestamped) → extract candidate
 * claims → ADVERSARIALLY verify each (multi-vote) → synthesize a cited answer.
 * Works on the FREE stack (SearXNG/DuckDuckGo + native fetch). The search,
 * fetch, and gateway are all INJECTED so core never imports agent-runtime
 * (dependency direction) and the pipeline is unit-tested fully offline.
 */

type ChatRunner = Pick<ModelGateway, 'chat'>;

export interface ResearchHit {
  url: string;
  title: string;
  snippet: string;
}
export type ResearchSearcher = (query: string) => Promise<ResearchHit[]>;
export type ResearchFetcher = (url: string) => Promise<{ markdown: string; title: string } | null>;

export interface DeepResearchInput {
  question: string;
  gateway: ChatRunner;
  search: ResearchSearcher;
  fetch: ResearchFetcher;
  /** ISO timestamp for provenance (injected so the pipeline is deterministic in tests). */
  now: string;
  maxSources?: number;
  maxSubQueries?: number;
  votes?: number;
  model?: string;
  provider?: string;
  signal?: AbortSignal;
  /** Progress callback (`plan` | `search` | `fetch` | `extract` | `verify` | `synthesize`). */
  onStage?: (stage: string, detail?: string) => void;
}

export interface DeepResearchResult {
  question: string;
  /** Synthesized answer with inline `[n]` citations. */
  answer: string;
  /** Full cited markdown report (answer + numbered sources). */
  report: string;
  sources: CitedSource[];
  claims: ClaimVerdict[];
}

const DEFAULTS = { maxSources: 5, maxSubQueries: 3, votes: 3 };

/** Splits a fenced/numbered model list into trimmed lines (tolerant). */
function parseList(text: string, cap: number): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*\d.)]+\s*)/, '').trim())
    .filter((l) => l.length > 0 && !/^```/.test(l))
    .slice(0, cap);
}

async function planSubQueries(input: DeepResearchInput, max: number): Promise<string[]> {
  const out = await input.gateway.chat({
    messages: [
      {
        role: 'system',
        content: `Break a research question into up to ${max} focused web-search queries that together cover it. Output ONE query per line, no numbering, no prose.`,
      },
      { role: 'user', content: input.question },
    ],
    metadata: { kind: 'research_plan' },
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  const queries = parseList(out.content, max);
  return queries.length > 0 ? queries : [input.question];
}

async function extractClaims(
  input: DeepResearchInput,
  sources: ReadonlyArray<CitedSource>,
): Promise<string[]> {
  const context = sources
    .map((s, i) => `[${i + 1}] ${s.title}\n${s.markdown.slice(0, 1200)}`)
    .join('\n\n');
  const out = await input.gateway.chat({
    messages: [
      {
        role: 'system',
        content:
          'From the SOURCES, extract up to 6 concise, falsifiable factual claims relevant to the QUESTION. Output ONE claim per line, no numbering.',
      },
      { role: 'user', content: `QUESTION: ${input.question}\n\nSOURCES:\n${context}` },
    ],
    metadata: { kind: 'research_extract' },
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  return parseList(out.content, 6);
}

async function synthesize(
  input: DeepResearchInput,
  sources: ReadonlyArray<CitedSource>,
  verdicts: ReadonlyArray<ClaimVerdict>,
): Promise<string> {
  const context = sources
    .map((s, i) => `[${i + 1}] ${s.title} (${s.url})\n${s.markdown.slice(0, 1500)}`)
    .join('\n\n');
  const verified = verdicts.filter((v) => v.verified).map((v) => v.claim);
  const unverified = verdicts.filter((v) => !v.verified).map((v) => v.claim);
  const out = await input.gateway.chat({
    messages: [
      {
        role: 'system',
        content:
          'Write a concise, well-structured answer to the QUESTION using ONLY the SOURCES. Cite sources inline as [n]. Prefer the VERIFIED claims; if you must mention an UNVERIFIED claim, clearly flag it as unverified. Do not invent facts or citations.',
      },
      {
        role: 'user',
        content: `QUESTION: ${input.question}\n\nVERIFIED CLAIMS:\n${verified.join('\n') || '(none)'}\n\nUNVERIFIED CLAIMS:\n${unverified.join('\n') || '(none)'}\n\nSOURCES:\n${context}`,
      },
    ],
    metadata: { kind: 'research_synthesize' },
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  return out.content.trim();
}

/** Deduplicates URLs (case-insensitive), preserving first-seen order. */
function dedupeHits(hits: ReadonlyArray<ResearchHit>): ResearchHit[] {
  const seen = new Set<string>();
  const out: ResearchHit[] = [];
  for (const hit of hits) {
    const key = hit.url.toLowerCase();
    if (hit.url.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

/** Runs the full research pipeline. Throws only on a gateway/search hard failure. */
export async function runDeepResearch(input: DeepResearchInput): Promise<DeepResearchResult> {
  const maxSources = input.maxSources ?? DEFAULTS.maxSources;
  const maxSub = input.maxSubQueries ?? DEFAULTS.maxSubQueries;
  const votes = input.votes ?? DEFAULTS.votes;
  const stage = (s: string, d?: string): void => input.onStage?.(s, d);

  stage('plan');
  const subQueries = await planSubQueries(input, maxSub);

  stage('search', `${subQueries.length} queries`);
  const allHits: ResearchHit[] = [];
  for (const q of subQueries) {
    try {
      allHits.push(...(await input.search(q)));
    } catch {
      // a single sub-query failing must not abort the whole research.
    }
  }
  const hits = dedupeHits(allHits).slice(0, maxSources);

  stage('fetch', `${hits.length} sources`);
  const sources: CitedSource[] = [];
  for (const hit of hits) {
    try {
      const page = await input.fetch(hit.url);
      if (page !== null && page.markdown.trim().length > 0) {
        sources.push(makeCitedSource(hit.url, page.title || hit.title, page.markdown, input.now));
      }
    } catch {
      // skip an unreachable source.
    }
  }

  if (sources.length === 0) {
    const answer = `No sources could be fetched for "${input.question}".`;
    return {
      question: input.question,
      answer,
      report: renderCitedReport(input.question, answer, []),
      sources: [],
      claims: [],
    };
  }

  stage('extract');
  const claims = await extractClaims(input, sources);

  stage('verify', `${claims.length} claims`);
  const verdicts = await Promise.all(
    claims.map((c) =>
      verifyClaim(c, sources, input.gateway, votes, {
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      }),
    ),
  );

  stage('synthesize');
  const answer = await synthesize(input, sources, verdicts);
  return {
    question: input.question,
    answer,
    report: renderCitedReport(input.question, answer, sources),
    sources,
    claims: verdicts,
  };
}
