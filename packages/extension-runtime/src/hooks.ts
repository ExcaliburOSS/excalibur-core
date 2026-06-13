/**
 * Hook registry (extensions spec §6). Extensions subscribe to lifecycle
 * hooks; the core emits them at well-known points. Handlers run sequentially
 * (awaited one by one, in registration order) and a failing handler never
 * breaks the emit — errors are collected and exposed via `errors()`.
 */

/** The well-known lifecycle hook names (spec §6). */
export const EXCALIBUR_HOOKS = [
  'workItem.received',
  'workItem.commandDetected',
  'discovery.started',
  'discovery.completed',
  'interaction.created',
  'patch.created',
  'run.created',
  'run.phaseStarted',
  'run.phaseCompleted',
  'run.completed',
  'run.failed',
  'pr.opened',
  'dailySummary.generating',
  'weeklyPlanning.started',
] as const;
export type ExcaliburHook = (typeof EXCALIBUR_HOOKS)[number];

/** A hook handler: sync or async, receives the emitted event. */
export type HookHandler<TEvent = unknown> = (event: TEvent) => Promise<void> | void;

/** One isolated handler failure collected during `emit`. */
export interface HookHandlerError {
  hookName: string;
  message: string;
  error: unknown;
}

export class HookRegistry {
  private readonly handlers = new Map<string, Array<HookHandler>>();
  private readonly errorList: HookHandlerError[] = [];

  /** Subscribe a handler to a hook. Handlers run in registration order. */
  on<TEvent>(hookName: string, handler: (event: TEvent) => Promise<void> | void): void {
    let list = this.handlers.get(hookName);
    if (list === undefined) {
      list = [];
      this.handlers.set(hookName, list);
    }
    // The registry stores handlers untyped; each `on<TEvent>` call site owns
    // the pairing between hook name and event type.
    list.push(handler as HookHandler);
  }

  /**
   * Emit an event to all handlers of a hook, awaiting each handler in turn.
   * Handler errors are isolated: they are collected into `errors()` and never
   * propagate to the emitter.
   */
  async emit<TEvent>(hookName: string, event: TEvent): Promise<void> {
    const list = this.handlers.get(hookName);
    if (list === undefined) {
      return;
    }
    // Iterate over a snapshot so handlers registered mid-emit do not run.
    for (const handler of [...list]) {
      try {
        await handler(event);
      } catch (error) {
        this.errorList.push({
          hookName,
          message: error instanceof Error ? error.message : String(error),
          error,
        });
      }
    }
  }

  /** Handler errors collected across all emits, in occurrence order. */
  errors(): ReadonlyArray<HookHandlerError> {
    return [...this.errorList];
  }

  /** Number of handlers currently registered for a hook. */
  handlerCount(hookName: string): number {
    return this.handlers.get(hookName)?.length ?? 0;
  }
}
