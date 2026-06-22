/**
 * Dashboard i18n. The chrome copy is en+es from day one (Excalibur's baseline),
 * detected from the browser language with an `?lang=` override. Kept as a small
 * self-contained catalog (the CLI's `makeTranslator` lives in `@excalibur/shared`
 * but pulls runtime we don't want in the browser bundle, so this is a tiny local
 * translator with the same `{var}` template shape).
 */
export type Locale = 'en' | 'es';

type Catalog = Record<string, string>;

const EN: Catalog = {
  'nav.board': 'Board',
  'nav.runs': 'Runs',
  'nav.insights': 'Insights',
  'nav.plans': 'Plans',
  'app.tagline': 'task-first agent control',
  'board.empty': 'No work items yet. Create one with `excalibur work-items create`.',
  'board.runs': '{n} runs',
  'workItem.runs': 'Runs',
  'workItem.links': 'Links',
  'workItem.comments': 'Comments',
  'workItem.plans': 'Plans',
  'workItem.back': 'Back to board',
  'workItem.none': 'No work item found for {key}.',
  'runs.title': 'Runs',
  'runs.empty': 'No runs recorded yet.',
  'runs.col.run': 'Run',
  'runs.col.status': 'Status',
  'runs.col.workflow': 'Workflow',
  'runs.col.model': 'Model',
  'runs.col.started': 'Started',
  'insights.title': 'Insights',
  'insights.soon': 'Cost & token charts arrive in D4.',
  'plans.title': 'Plans & Discovery',
  'plans.soon': 'Plan and discovery views arrive in D3.',
  'common.loading': 'Loading…',
  'common.error': 'Error',
  'common.notFound': 'Not found',
};

const ES: Catalog = {
  'nav.board': 'Tablero',
  'nav.runs': 'Ejecuciones',
  'nav.insights': 'Métricas',
  'nav.plans': 'Planes',
  'app.tagline': 'control de agentes centrado en tareas',
  'board.empty': 'Aún no hay tareas. Crea una con `excalibur work-items create`.',
  'board.runs': '{n} ejecuciones',
  'workItem.runs': 'Ejecuciones',
  'workItem.links': 'Enlaces',
  'workItem.comments': 'Comentarios',
  'workItem.plans': 'Planes',
  'workItem.back': 'Volver al tablero',
  'workItem.none': 'No se encontró la tarea {key}.',
  'runs.title': 'Ejecuciones',
  'runs.empty': 'Todavía no hay ejecuciones.',
  'runs.col.run': 'Ejecución',
  'runs.col.status': 'Estado',
  'runs.col.workflow': 'Flujo',
  'runs.col.model': 'Modelo',
  'runs.col.started': 'Inicio',
  'insights.title': 'Métricas',
  'insights.soon': 'Las gráficas de coste y tokens llegan en D4.',
  'plans.title': 'Planes y Discovery',
  'plans.soon': 'Las vistas de planes y discovery llegan en D3.',
  'common.loading': 'Cargando…',
  'common.error': 'Error',
  'common.notFound': 'No encontrado',
};

const CATALOGS: Record<Locale, Catalog> = { en: EN, es: ES };

function detectLocale(): Locale {
  const override = new URLSearchParams(window.location.search).get('lang');
  if (override === 'en' || override === 'es') {
    return override;
  }
  const nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return nav === 'es' ? 'es' : 'en';
}

export const locale: Locale = detectLocale();

/** Translate a key, interpolating `{var}` placeholders. Falls back to English, then the key. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const template = CATALOGS[locale][key] ?? EN[key] ?? key;
  if (vars === undefined) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (_m, name: string) =>
    name in vars ? String(vars[name]) : `{${name}}`,
  );
}
