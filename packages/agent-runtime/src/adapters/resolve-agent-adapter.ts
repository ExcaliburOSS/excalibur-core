import { ConfigValidationError, type ExcaliburConfig } from '@excalibur/shared';
import type { AgentAdapter } from '../types';
import { CustomCommandAdapter } from './custom-command/custom-command-adapter';
import { NativeAgentAdapter } from './native/native-agent-adapter';

/**
 * Selects the agent adapter from config `agents.default` (defaults to `native`).
 *
 * - `native` (or unset) → {@link NativeAgentAdapter}: Excalibur's own tool loop,
 *   driven through the model gateway.
 * - a `custom-command` agent → {@link CustomCommandAdapter}: drives an external
 *   CLI (e.g. a vendor's own client that holds a subscription) — Excalibur
 *   orchestrates it and never touches its credential.
 *
 * @throws ConfigValidationError when `agents.default` names a missing entry or
 *   an unsupported agent type.
 */
export function resolveAgentAdapter(config: ExcaliburConfig): AgentAdapter {
  const agents = config.agents;
  const name = agents?.default ?? 'native';
  if (name === 'native') {
    return new NativeAgentAdapter();
  }
  const entry = agents?.[name];
  if (entry === undefined) {
    throw new ConfigValidationError(
      `agents.default is "${name}" but there is no agents.${name} entry configured.`,
      { agent: name },
    );
  }
  const type = (entry as { type?: unknown }).type;
  if (type === 'native') {
    return new NativeAgentAdapter();
  }
  if (type === 'custom-command') {
    return CustomCommandAdapter.fromConfig(name, entry);
  }
  throw new ConfigValidationError(
    `Agent "${name}" has unsupported type "${String(type)}" (expected "native" or "custom-command").`,
    { agent: name },
  );
}

/**
 * Whether the resolved agent runs through Excalibur's MODEL GATEWAY (so a real
 * provider must be configured). The native loop does; a `custom-command`
 * passthrough does NOT — the external CLI does its own inference, so a
 * subscription-only user with no `providers.yaml` can still run it.
 */
export function agentUsesGateway(config: ExcaliburConfig): boolean {
  const name = config.agents?.default ?? 'native';
  if (name === 'native') {
    return true;
  }
  const entry = config.agents?.[name] as { type?: unknown } | undefined;
  return entry?.type !== 'custom-command';
}
