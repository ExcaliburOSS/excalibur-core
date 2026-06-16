import type { Catalog } from '@excalibur/shared';

/**
 * Spanish message catalog. Each key mirrors `en.ts`; a missing key falls back to
 * English via the translator, so partial coverage is safe during migration.
 */
export const ES: Catalog = {
  'welcome.epigraph': 'La espada está desenvainada. ¿Qué construimos?',

  'init.detected': 'Detectado:',
  'init.detected.none': 'nada específico — se aplican los valores por defecto',
  'init.usingInstructions': 'Usando instrucciones existentes:',
  'init.created': 'Creado:',
  'init.skipped': '  Se omitieron {count} fichero(s) existente(s) — vuelve a ejecutar con --force para sobrescribir.',
  'init.enriching': 'Enriqueciendo AGENTS.md con tu modelo…',
  'init.noProvider':
    'Aún no hay proveedor de modelo configurado — los comandos usan el proveedor mock integrado (M1). Ejecuta `excalibur models setup` cuando quieras.',
  'init.tryNow': 'Prueba ahora:',
  'init.cancelled': 'Init cancelado — no se escribió nada.',
  'init.applyQuestion': '¿Aplicar estos cambios?',
  'init.applyQuestionUpdate': 'Algunos ficheros ya existen (ver arriba). ¿Aplicar los cambios?',
};
