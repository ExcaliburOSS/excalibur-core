import type { ReportTemplateDefinition } from '@excalibur/declarative-schemas';
import type { ExtensionManifest } from '@excalibur/extension-runtime';
import { BUILT_IN_EXTENSION_VERSION, builtInContribution, type BuiltInExtensionPack } from './types';

const EXTENSION_ID = 'core-reports';

/**
 * Sections of `excalibur daily` (`generateDailyReport`, contract §4.6):
 * completed/failed runs, patches, recent commits, pending items.
 */
export const DAILY_SUMMARY_REPORT: ReportTemplateDefinition = {
  id: 'daily-summary',
  type: 'report_template',
  name: 'Daily Summary',
  description:
    'Async daily summary of local Excalibur activity: runs, patches, git commits and pending items.',
  sections: ['Completed runs', 'Failed runs', 'Patches', 'Recent commits', 'Pending items'],
};

/** Sections of `excalibur weekly-plan` (`generateWeeklyPlan`, contract §4.6). */
export const WEEKLY_PLAN_REPORT: ReportTemplateDefinition = {
  id: 'weekly-plan',
  type: 'report_template',
  name: 'Weekly Plan',
  description:
    'Lightweight weekly planning report: last week in review, carryover, planned focus and risks.',
  sections: [
    'Last week summary',
    'Completed work',
    'Carryover',
    'Planned focus',
    'Risks and blockers',
  ],
};

const REPORTS: ReadonlyArray<ReportTemplateDefinition> = [DAILY_SUMMARY_REPORT, WEEKLY_PLAN_REPORT];

const manifest: ExtensionManifest = {
  id: EXTENSION_ID,
  name: 'Core Reports',
  version: BUILT_IN_EXTENSION_VERSION,
  kind: 'declarative',
  description:
    'Built-in report templates for the local Agentic Agile rituals: daily summary and weekly plan.',
  contributes: {
    reportTemplates: REPORTS.map((definition) => definition.id),
  },
};

/** `core-reports` — the daily-summary and weekly-plan report templates. */
export const CORE_REPORTS_PACK: BuiltInExtensionPack = {
  manifest,
  contributions: REPORTS.map((definition) =>
    builtInContribution(EXTENSION_ID, 'report_template', definition.id, definition),
  ),
};
