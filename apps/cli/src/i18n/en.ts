import type { Catalog } from '@excalibur/shared';

/**
 * English message catalog — the source of truth for the CLI chrome. Keys are
 * namespaced by surface (`init.*`, `welcome.*`, …). `{var}` placeholders are
 * interpolated by the translator. New chrome is added here as keys (never
 * hardcoded literals), with the Spanish translation mirrored in `es.ts`.
 */
export const EN: Catalog = {
  // Welcome (arthurian flavor — plan §"Sabor artúrico"; on by default).
  'welcome.epigraph': 'The sword is drawn. What shall we build?',

  // `excalibur init` — the confidence-building final output (onboarding §12).
  'init.detected': 'Detected:',
  'init.detected.none': 'nothing specific — defaults apply',
  'init.usingInstructions': 'Using existing instructions:',
  'init.created': 'Created:',
  'init.skipped': '  Skipped {count} existing file(s) — re-run with --force to overwrite.',
  'init.enriching': 'Enriching AGENTS.md with your model…',
  'init.noProvider':
    'No model provider configured yet — commands use the built-in mock provider (M1). Run `excalibur models setup` when ready.',
  'init.tryNow': 'Try now:',
  'init.cancelled': 'Init cancelled — nothing was written.',
  'init.applyQuestion': 'Apply these changes?',
  'init.applyQuestionUpdate': 'Some files already exist (see above). Apply the changes?',
};
