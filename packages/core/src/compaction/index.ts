/**
 * Context compaction (plan §"Compactación de contexto"). Automatic, config-only,
 * provider-agnostic: keeps a long session within the model's context window by
 * folding older turns into a structured summary emitted as the 24th `compaction`
 * ExcaliburEvent — so replay/time-machine/fork keep working and the lossless raw
 * stream stays the source of truth. The offline `defaultSummarizer` proves the
 * full loop with no real model; M2's `createModelSummarizer` swaps in a
 * model-backed (cheap-routed) summarizer via the async `compact` path.
 */
export * from './types';
export * from './transcript';
export * from './compactor';
export * from './session-compactor';
export * from './model-summarizer';
