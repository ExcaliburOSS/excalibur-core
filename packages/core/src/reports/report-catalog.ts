import { makeTranslator, type Catalog, type Locale, type Translator } from '@excalibur/shared';

/**
 * Report prose catalogs (plan §"Idioma": "core owns report/AGENTS.md copy").
 * `@excalibur/core` generates the daily/weekly markdown, so it co-locates the
 * report strings here — `EN` is the source-of-truth, `ES` the translation,
 * `{var}` placeholders interpolated. The CLI passes the active `locale`.
 */
const EN: Catalog = {
  'report.daily-title': '# Daily Report — {date}',
  'report.weekly-title': '# Weekly Plan — {week}',
  'report.completed-runs': 'Completed runs',
  'report.failed-runs': 'Failed runs',
  'report.patches': 'Patches',
  'report.commits': 'Commits',
  'report.pending': 'Pending',
  'report.last-week': 'Last week',
  'report.plan-next-week': 'Plan for next week',
  'report.no-completed-today': 'No completed runs today.',
  'report.no-failed-today': 'No failed runs today.',
  'report.no-patches-today': 'No patches generated today.',
  'report.no-commits-today': 'No commits today.',
  'report.nothing-pending': 'Nothing pending.',
  'report.no-activity': 'No activity recorded.',
  'report.no-completed-week': 'No completed runs last week.',
  'report.nothing-carried': 'Nothing carried over — plan new work.',
  'report.no-workflow': 'no workflow',
  'report.run-line': '- {id} — {title} ({workflow}, {level}) — {status}',
  'report.patch-line': '- {id} — {command} ({workflow}) — {status}',
  'report.commit-line': '- {hash} {subject} ({author})',
  'report.runs-summary': '- Runs: {total} total, {completed} completed, {failed} failed.',
  'report.commits-summary': '- Commits: {count}.',
  'report.patches-summary': '- Patches: {total} total, {open} open.',
  'report.plan-resume': '- Resume {id} — {title} ({status}).',
  'report.plan-revisit': '- Revisit failed run {id} — {title}.',
  'report.plan-review-patch': '- Review and apply (or reject) patch {id}.',
};

const ES: Catalog = {
  'report.daily-title': '# Informe diario — {date}',
  'report.weekly-title': '# Plan semanal — {week}',
  'report.completed-runs': 'Ejecuciones completadas',
  'report.failed-runs': 'Ejecuciones fallidas',
  'report.patches': 'Parches',
  'report.commits': 'Commits',
  'report.pending': 'Pendientes',
  'report.last-week': 'La semana pasada',
  'report.plan-next-week': 'Plan para la próxima semana',
  'report.no-completed-today': 'No hay ejecuciones completadas hoy.',
  'report.no-failed-today': 'No hay ejecuciones fallidas hoy.',
  'report.no-patches-today': 'No se generaron parches hoy.',
  'report.no-commits-today': 'No hay commits hoy.',
  'report.nothing-pending': 'Nada pendiente.',
  'report.no-activity': 'No se registró actividad.',
  'report.no-completed-week': 'No hubo ejecuciones completadas la semana pasada.',
  'report.nothing-carried': 'Nada pendiente — planifica trabajo nuevo.',
  'report.no-workflow': 'sin workflow',
  'report.run-line': '- {id} — {title} ({workflow}, {level}) — {status}',
  'report.patch-line': '- {id} — {command} ({workflow}) — {status}',
  'report.commit-line': '- {hash} {subject} ({author})',
  'report.runs-summary': '- Ejecuciones: {total} en total, {completed} completadas, {failed} fallidas.',
  'report.commits-summary': '- Commits: {count}.',
  'report.patches-summary': '- Parches: {total} en total, {open} abiertos.',
  'report.plan-resume': '- Retomar {id} — {title} ({status}).',
  'report.plan-revisit': '- Revisar la ejecución fallida {id} — {title}.',
  'report.plan-review-patch': '- Revisar y aplicar (o rechazar) el parche {id}.',
};

/** Builds the report translator for a locale (defaults to en). */
export function makeReportTranslator(locale: Locale = 'en'): Translator {
  return makeTranslator({ en: EN, es: ES }, locale);
}
