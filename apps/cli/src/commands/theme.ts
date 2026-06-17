import {
  THEME_NAMES,
  detectColorTier,
  detectThemeSync,
  paint,
  paletteFor,
  type ThemeName,
} from '@excalibur/tui';
import type { Command } from 'commander';
import type { CliDeps } from '../deps';
import { CliUsageError } from '../errors';
import { readRawConfig, writeRawConfig } from '../lib/config-file';

/**
 * `excalibur theme [name]` — list the TUI themes (with live colour swatches) or
 * set one, persisting `ui.theme` to `.excalibur/config.yaml`. Names: auto | dark
 * | light | daltonized (colorblind-safe) | high-contrast. Read-only when listing;
 * scriptable.
 */
export function registerThemeCommand(program: Command, deps: CliDeps): void {
  program
    .command('theme')
    .description('list TUI themes, or set one (persisted to .excalibur/config.yaml)')
    .argument('[name]', 'theme to set: auto | dark | light | daltonized | high-contrast')
    .action((name: string | undefined) => {
      const repoRoot = deps.cwd();
      const raw = readRawConfig(repoRoot);
      const ui =
        typeof raw['ui'] === 'object' && raw['ui'] !== null
          ? (raw['ui'] as Record<string, unknown>)
          : {};
      const current = typeof ui['theme'] === 'string' ? ui['theme'] : 'auto';

      if (name === undefined) {
        const tier = detectColorTier(deps.env, deps.ui.isOutputTty());
        const mode = detectThemeSync() ?? 'dark';
        deps.ui.heading(deps.t('theme.heading'));
        for (const tn of THEME_NAMES) {
          const p = paletteFor(tn, mode);
          const swatch = `${paint('●', p.accent, tier)}${paint('+', p.diffAddFg, tier)}${paint('-', p.diffDelFg, tier)}`;
          const marker = tn === current ? '→' : ' ';
          deps.ui.write(`${marker} ${tn.padEnd(14)} ${swatch}`);
        }
        deps.ui.write();
        deps.ui.info(deps.t('theme.usage'));
        return;
      }

      if (!THEME_NAMES.includes(name as ThemeName)) {
        throw new CliUsageError(deps.t('theme.unknown', { name, names: THEME_NAMES.join(', ') }));
      }
      ui['theme'] = name;
      raw['ui'] = ui;
      writeRawConfig(repoRoot, raw);
      deps.ui.success(deps.t('theme.set', { name }));
    });
}
