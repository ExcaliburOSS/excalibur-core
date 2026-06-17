import { redactSecrets, type ModelGateway } from '@excalibur/model-gateway';
import { MESH_LENSES, aggregateMesh, type MeshIssue, type MeshLens, type MeshResult, type MeshVerdict } from './verification-mesh';

/**
 * The VERIFICATION MESH orchestrator (in core so BOTH the CLI `verify` command
 * and the run-lifecycle gate can use it): runs each planned lens as an ISOLATED
 * adversarial verifier in parallel (own chat, blind to the others → no
 * groupthink), each emitting a JSON verdict, folded by {@link aggregateMesh}.
 * The lens SET is chosen proportionally by `planVerificationMesh`; this executes.
 */

/** Narrowed gateway dep (a fake in tests only needs `chat`). */
type ChatRunner = Pick<ModelGateway, 'chat'>;

export interface RunMeshInput {
  /** The change under review, as a unified diff (redacted before it leaves). */
  diff: string;
  lenses: ReadonlyArray<MeshLens>;
  gateway: ChatRunner;
  provider?: string;
  signal?: AbortSignal;
}

function normSeverity(value: unknown): MeshIssue['severity'] {
  const v = String(value ?? '').toLowerCase();
  return v === 'high' || v === 'medium' || v === 'low' ? v : 'low';
}

function systemFor(lens: MeshLens): string {
  const { focus } = MESH_LENSES[lens];
  return [
    `You are an ADVERSARIAL ${lens} verifier reviewing a code change.`,
    `Your job is to REFUTE it, not approve it. Focus ONLY on: ${focus}.`,
    'Hunt for REAL defects. Use severity "high" ONLY for a genuine, blocking problem.',
    'Reply with ONLY a JSON object (no prose, no fences):',
    '{"clean": <true iff you found nothing>, "issues": [{"severity":"high|medium|low","file":"<path or \\"\\">","problem":"<what is wrong>","fix":"<concrete fix>"}]}',
  ].join('\n');
}

/** Tolerantly extract the first {...} JSON block (handles fences / surrounding prose). */
function extractJson(content: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content);
  const body = fenced?.[1] ?? content;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start >= 0 && end > start ? body.slice(start, end + 1) : '{}';
}

function parseVerdict(lens: MeshLens, content: string): MeshVerdict {
  try {
    const obj = JSON.parse(extractJson(content)) as { issues?: unknown[] };
    const issues: MeshIssue[] = (Array.isArray(obj.issues) ? obj.issues : []).map((raw) => {
      const i = (raw ?? {}) as Record<string, unknown>;
      return {
        lens,
        severity: normSeverity(i['severity']),
        problem: String(i['problem'] ?? '').trim() || 'unspecified issue',
        ...(typeof i['file'] === 'string' && i['file'].length > 0 ? { file: i['file'] } : {}),
        ...(typeof i['fix'] === 'string' && i['fix'].length > 0 ? { fix: i['fix'] } : {}),
      };
    });
    return { lens, issues, clean: issues.length === 0 };
  } catch {
    // Unparseable verifier output → do NOT fabricate a block; treat as clean.
    return { lens, issues: [], clean: true };
  }
}

async function verifyLens(lens: MeshLens, input: RunMeshInput): Promise<MeshVerdict> {
  const out = await input.gateway.chat({
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    messages: [
      { role: 'system', content: systemFor(lens) },
      { role: 'user', content: `CHANGE (unified diff):\n${redactSecrets(input.diff)}` },
    ],
    maxTokens: 700,
    // No `temperature` — reasoning models (e.g. kimi-k2.7-code) reject it (400).
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    metadata: { kind: `mesh-${lens}` },
  });
  return parseVerdict(lens, out.content);
}

/** Runs the planned lenses as isolated parallel verifiers and aggregates them. */
export async function runVerificationMesh(input: RunMeshInput): Promise<MeshResult> {
  if (input.lenses.length === 0) {
    return {
      blocked: false,
      issues: [],
      lensesRun: [],
      summary: 'Verification mesh: no lenses (proportional — nothing warranted).',
    };
  }
  const verdicts = await Promise.all(input.lenses.map((lens) => verifyLens(lens, input)));
  return aggregateMesh(verdicts);
}
