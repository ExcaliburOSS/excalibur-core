import type {
  AutonomyLevel,
  ExcaliburConfig,
  ExcaliburEvent,
  ExecutionStyle,
  RunRecord,
  RunStatus,
} from '@excalibur/shared';
import type { ModelGateway } from '@excalibur/model-gateway';
import {
  NativeAgentAdapter,
  type AgentAdapter,
  type ExtensionTool,
} from '@excalibur/agent-runtime';
import type { WorkflowDefinition } from '@excalibur/workflow-schema';
import { RunManager } from '../runs/run-manager';
import { createExtensionHost, workflowCatalog } from '../extensions/host';
import { selectWorkflow } from '../selection/select-workflow';
import { executeLocalRun } from './execute-local-run';

/**
 * Headless run controller (P0.3a) — the live, in-process registry of running
 * agentic runs that a server (the programmable `serve` write surface, the ACP
 * server) or the dashboard's interactive actions drive WITHOUT the CLI's
 * interactive plan-card / Ink machinery.
 *
 * For each run it owns the live runtime state the on-disk `RunManager` cannot:
 * an `AbortController` for cancellation, a buffer + listener set for live event
 * fan-out, and an async-approval bridge (the engine's `confirm` callback returns
 * a Promise that an out-of-band `approve()` resolves). It sits entirely on the
 * reusable `@excalibur/core` primitives so Excalibur Enterprise can mount it too.
 */

export type RunControllerStatus = RunStatus;

/** A run the controller is awaiting a human decision on. */
export interface PendingApproval {
  question: string;
}

/** A handle to one live (or finished) run. */
export interface RunHandle {
  readonly runId: string;
  readonly workflowId: string;
  /** Resolves with the final record when the run ends. */
  readonly record: Promise<RunRecord>;
  /** Live status: `running` until the record resolves, then the final status. */
  status(): RunControllerStatus;
  /** Every event emitted so far (for late joiners / polling). */
  events(): ExcaliburEvent[];
  /** Subscribe to events: the buffer is replayed first, then live events flow. Returns an unsubscribe fn. */
  subscribe(listener: (event: ExcaliburEvent) => void): () => void;
  /** The approval the run is currently blocked on, or null. */
  pendingApproval(): PendingApproval | null;
  /** Answer the current pending approval (no-op if none pending). */
  approve(decision: boolean): void;
  /** Cancel the run: unblock any pending approval (declined) and abort the loop. */
  cancel(): void;
}

/** Options to start a headless run. */
export interface StartRunOptions {
  repoRoot: string;
  task: string;
  gateway: ModelGateway;
  config: ExcaliburConfig;
  /** Default 3 (Level 3). */
  autonomyLevel?: AutonomyLevel;
  /** Default `team_default`. */
  executionStyle?: ExecutionStyle;
  /** Explicit workflow id (else selected from level/style). */
  workflow?: string;
  /** Defaults to a fresh `NativeAgentAdapter`. */
  adapter?: AgentAdapter;
  /** Extension-contributed tools (the caller activates extensions). */
  extensionTools?: ExtensionTool[];
  /** Hard budget cap in cents. */
  budgetCents?: number;
  /** Pre-built workflow catalog; built from the repo's extension host if omitted. */
  catalog?: ReadonlyArray<{ id: string; definition: WorkflowDefinition }>;
}

/** One run's live runtime state. Internal to the controller module. */
class RunExecution implements RunHandle {
  record!: Promise<RunRecord>;
  private finalStatus: RunControllerStatus | null = null;
  private readonly buffer: ExcaliburEvent[] = [];
  private readonly listeners = new Set<(event: ExcaliburEvent) => void>();
  private pending: { question: string; resolve: (decision: boolean) => void } | null = null;
  // A decision can arrive BEFORE the engine asks: the engine emits
  // `approval_requested` and only then awaits `confirm()`, so a client reacting to
  // that event (or an in-process caller) may `approve()` before the bridge promise
  // exists. Buffer it and apply it to the next `confirm()`.
  private bufferedDecision: boolean | null = null;
  private readonly controller = new AbortController();

  constructor(
    readonly runId: string,
    readonly workflowId: string,
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Engine `onEvent` sink: buffer + fan out to listeners (a faulty listener never breaks the run). */
  onEvent(event: ExcaliburEvent): void {
    this.buffer.push(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* a subscriber error must never break the run */
      }
    }
  }

  /** Engine `confirm` bridge: apply a pre-buffered decision, else park the question. */
  confirm(question: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (this.bufferedDecision !== null) {
        const decision = this.bufferedDecision;
        this.bufferedDecision = null;
        resolve(decision);
        return;
      }
      this.pending = { question, resolve };
    });
  }

  setFinalStatus(status: RunControllerStatus): void {
    this.finalStatus = status;
  }

  status(): RunControllerStatus {
    return this.finalStatus ?? 'running';
  }

  events(): ExcaliburEvent[] {
    return [...this.buffer];
  }

  subscribe(listener: (event: ExcaliburEvent) => void): () => void {
    for (const event of this.buffer) {
      try {
        listener(event);
      } catch {
        /* ignore */
      }
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  pendingApproval(): PendingApproval | null {
    return this.pending !== null ? { question: this.pending.question } : null;
  }

  approve(decision: boolean): void {
    const pending = this.pending;
    if (pending !== null) {
      this.pending = null;
      pending.resolve(decision);
      return;
    }
    // The engine hasn't reached `confirm()` yet (it emits the event first) —
    // remember the decision for the next confirm.
    this.bufferedDecision = decision;
  }

  cancel(): void {
    // Unblock any awaited approval (declined) so the awaiting engine can wind
    // down, THEN abort the in-flight tool loop / model call.
    this.approve(false);
    this.controller.abort();
  }
}

/** The live registry of runs. */
export class RunController {
  private readonly runs = new Map<string, RunExecution>();

  /** Starts a run headlessly and returns its handle. The run executes in the background. */
  async startRun(options: StartRunOptions): Promise<RunHandle> {
    const runManager = new RunManager(options.repoRoot);
    const catalog = options.catalog ?? workflowCatalog(await createExtensionHost(options.repoRoot));
    const autonomyLevel: AutonomyLevel = options.autonomyLevel ?? 3;
    const executionStyle: ExecutionStyle = options.executionStyle ?? 'team_default';
    const selection = selectWorkflow({
      config: options.config,
      catalog,
      autonomyLevel,
      executionStyle,
      ...(options.workflow !== undefined ? { explicitWorkflow: options.workflow } : {}),
    });
    const run = runManager.createRun({
      title: options.task,
      autonomyLevel,
      workflow: selection.workflowId,
      methodology: null,
      model: options.config.models?.default ?? null,
      executionStyle,
    });

    const exec = new RunExecution(run.id, selection.workflowId);
    exec.record = executeLocalRun({
      repoRoot: options.repoRoot,
      runManager,
      run,
      definition: selection.definition,
      gateway: options.gateway,
      adapter: options.adapter ?? new NativeAgentAdapter(),
      config: options.config,
      onEvent: (event) => exec.onEvent(event),
      confirm: (question) => exec.confirm(question),
      signal: exec.signal,
      ...(options.extensionTools !== undefined && options.extensionTools.length > 0
        ? { extensionTools: options.extensionTools }
        : {}),
      ...(options.budgetCents !== undefined ? { budgetCents: options.budgetCents } : {}),
    })
      .then((rec) => {
        exec.setFinalStatus(rec.status);
        return rec;
      })
      .catch((error: unknown) => {
        exec.setFinalStatus('failed');
        throw error;
      });
    // Swallow unhandled rejection: callers opt in by awaiting `handle.record`.
    exec.record.catch(() => undefined);

    this.runs.set(run.id, exec);
    return exec;
  }

  /** A live/finished run handle by id. */
  get(runId: string): RunHandle | undefined {
    return this.runs.get(runId);
  }

  /** The ids of all runs the controller has started this process. */
  list(): string[] {
    return [...this.runs.keys()];
  }

  /** Cancels a run by id; returns false if unknown. */
  cancel(runId: string): boolean {
    const exec = this.runs.get(runId);
    if (exec === undefined) {
      return false;
    }
    exec.cancel();
    return true;
  }

  /** Drops a finished run from the in-memory registry (its artifacts persist on disk). */
  forget(runId: string): void {
    this.runs.delete(runId);
  }
}
