import type { CliDeps } from '../deps';
import { CliUsageError } from '../errors';
import { chatWithGuidance, loadGatewayContext, requireConfiguredModel } from './context';
import { validateConfiguredModels } from './model-validate';

/**
 * Sends a tiny request to the resolved default provider and reports whether it
 * answered (latency + tokens). Throws a {@link CliUsageError} on failure so the
 * caller sees actionable guidance instead of a stack trace. Shared by the
 * `models test` / `models setup` commands and the auto-onboarding close, so a
 * freshly pasted key is validated the moment it's saved.
 */
export async function runConnectionTest(deps: CliDeps): Promise<void> {
  const context = loadGatewayContext(deps.cwd());
  requireConfiguredModel(context, deps.t); // refuses with setup guidance when unconfigured
  const config = context.providers.providers[context.providerName];
  const modelLabel =
    config?.model !== undefined && config.model.length > 0 ? ` (${config.model})` : '';
  if (config?.type === 'mock') {
    deps.ui.info(deps.t('models.test-mock', { provider: context.providerName }));
    return;
  }
  // A live spinner during the round-trip so a slow provider never looks frozen
  // (no-op on a non-TTY, so scripted tests are unaffected).
  const spinner = deps.ui.createSpinner();
  spinner.start(() =>
    deps.t('models.test-sending', { provider: context.providerName, modelLabel }),
  );
  const startedAt = Date.now();
  try {
    const { output } = await chatWithGuidance(deps, context, {
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      maxTokens: 16,
      // No `temperature` — a reasoning model (e.g. kimi-k2.7-code) 400s on it,
      // which would make the connection test wrongly report a broken provider.
    });
    spinner.stop();
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    const reply = output.content.trim().replace(/\s+/g, ' ').slice(0, 60);
    const tokens = `${output.usage.inputTokens}→${output.usage.outputTokens} tok`;
    const cost = output.costCents !== null ? ` · ${output.costCents.toFixed(3)}¢` : '';
    deps.ui.success(
      deps.t('models.test-connected', {
        provider: context.providerName,
        modelLabel,
        seconds,
        tokens,
        cost,
      }),
    );
    if (reply.length > 0) {
      deps.ui.info(deps.t('models.test-reply', { reply }));
    }
    // Best-effort: warn if any configured (good/fast) model id is stale. Never
    // blocks — the connection already works.
    await validateConfiguredModels(deps).catch(() => undefined);
  } catch (error) {
    spinner.stop();
    const message = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(
      deps.t('models.test-failed', {
        provider: context.providerName,
        modelLabel,
        message,
      }),
    );
  }
}
