import { makeTranslator, type Catalog, type Locale, type Translator } from '@excalibur/shared';

/**
 * Generated-prose catalogs for `excalibur init` / onboarding (plan §"Idioma":
 * "core owns AGENTS.md / instruction copy"). `@excalibur/core` writes the
 * deterministic AGENTS.md + `.excalibur/instructions/*.md`, so it co-locates that
 * copy here. `EN` is the source-of-truth (byte-identical to the prior literals so
 * en-locale snapshots are unchanged); `ES` is the translation. `{var}` is
 * interpolated; detected values (languages, commands, paths) are passed in.
 */
const EN: Catalog = {
  // shared values
  'init.unknown': 'unknown',
  'init.none-detected': 'none detected',
  'init.yes': 'yes',
  'init.no': 'no',
  // shared section bits
  'init.commands': '## Commands',
  'init.languages': '- Languages: {value}',
  'init.frameworks': '- Frameworks: {value}',
  'init.package-manager': '- Package manager: {value}',
  'init.secrets': '- Never commit secrets; use environment variables.',

  // general.md
  'init.g.title': '# Project instructions — {name}',
  'init.g.intro': 'General guidance Excalibur prepends to every model prompt for this repository.',
  'init.detected-stack': '## Detected stack',
  'init.g.no-commands': '_No commands detected._',
  'init.working-agreements': '## Working agreements',
  'init.wa-small': '- Keep changes small and reviewable.',
  'init.wa-verify': '- Run the detected test and typecheck commands before declaring work done.',
  'init.wa-docs':
    '- Update the relevant documentation (ADRs, design/module docs, API reference, CHANGELOG) before declaring work done.',

  // architecture.md
  'init.arch.title': '# Architecture instructions',
  'init.arch.backend': '- Backend detected: {value}.',
  'init.arch.frontend': '- Frontend detected: {value}.',
  'init.arch.api-dirs': '- API directories: {value}.',
  'init.arch.domain-dirs': '- Domain directories: {value}.',
  'init.arch.describe': 'Describe module boundaries, layering rules and dependency direction here.',

  // testing.md
  'init.test.title': '# Testing instructions',
  'init.test.dirs': '- Test directories: {value}.',
  'init.test.run': '- Run tests with `{cmd}`.',
  'init.test.no-cmd': '- No test command detected — add one before relying on agent verification.',
  'init.test.describe':
    'Describe the testing strategy (unit/integration/e2e) and coverage expectations here.',

  // documentation.md
  'init.docs.title': '# Documentation instructions',
  'init.docs.1':
    '- Treat documentation as part of "done" — like passing tests, not an afterthought.',
  'init.docs.2': '- Record notable technical decisions as ADRs (e.g. `docs/adr/NNNN-title.md`).',
  'init.docs.3': '- Keep module and public API docs current with the change{suffix}.',
  'init.docs.modules-suffix': ' (modules: {value})',
  'init.docs.4': '- Add a `CHANGELOG.md` entry for any user-facing or behavioural change.',
  'init.docs.describe':
    'Describe where documentation lives (docs site, ADR directory, API reference) and the conventions to follow here.',

  // security.md
  'init.sec.title': '# Security instructions',
  'init.sec.1': '- Never read or write `.env*` files, private keys or secret stores.',
  'init.sec.sensitive': '- Sensitive paths detected: {value}.',
  'init.sec.3': '- Changes to authentication, billing or payment code require human review.',

  // AGENTS.md
  'init.am.banner-1':
    '> Guidance for AI coding agents working in this repository. `AGENTS.md` is the',
  'init.am.banner-2':
    '> cross-tool standard read by Excalibur, Cursor, GitHub Copilot, OpenCode and others.',
  'init.am.banner-3':
    '> Excalibur generated this from the repository on first `init` — edit it freely and',
  'init.am.banner-4': '> keep it in Git. Excalibur-specific configuration lives in `.excalibur/`.',
  'init.am.stack': '## Stack',
  'init.am.no-commands': '_No commands detected — add them here._',
  'init.am.install': '- Install: `{cmd}`',
  'init.am.layout': '## Project layout',
  'init.am.backend-frontend': '- Backend: {backend} · Frontend: {frontend}',
  'init.am.api': '- API: {value}',
  'init.am.domain': '- Domain modules: {value}',
  'init.am.tests': '- Tests: {value}',
  'init.am.migrations': '- Migrations: {value}',
  'init.am.verify': '- Run `{test}`{and} before considering a change done.',
  'init.am.and-typecheck': ' and `{cmd}`',
  'init.am.verify-add':
    '- Add a test command so changes can be verified before they are considered done.',
  'init.am.conv-small': '- Keep changes small, focused and reviewable.',
  'init.am.conv-docs':
    '- Update the relevant documentation (ADRs, module/API docs, CHANGELOG) as part of any change — not just code.',
  'init.am.architecture': '## Architecture',
  'init.am.conventions': '## Conventions',
  'init.am.sensitive-areas': '## Sensitive areas',
  'init.am.sensitive-detected': 'Take extra care and expect human review for: {value}.',
  'init.am.sensitive-default':
    'Treat authentication, billing, payments and secret-handling code as sensitive (human review).',
};

const ES: Catalog = {
  'init.unknown': 'desconocido',
  'init.none-detected': 'no detectado',
  'init.yes': 'sí',
  'init.no': 'no',
  'init.commands': '## Comandos',
  'init.languages': '- Lenguajes: {value}',
  'init.frameworks': '- Frameworks: {value}',
  'init.package-manager': '- Gestor de paquetes: {value}',
  'init.secrets': '- Nunca subas secretos; usa variables de entorno.',

  'init.g.title': '# Instrucciones del proyecto — {name}',
  'init.g.intro':
    'Guía general que Excalibur antepone a cada prompt del modelo para este repositorio.',
  'init.detected-stack': '## Stack detectado',
  'init.g.no-commands': '_No se detectaron comandos._',
  'init.working-agreements': '## Acuerdos de trabajo',
  'init.wa-small': '- Mantén los cambios pequeños y revisables.',
  'init.wa-verify':
    '- Ejecuta los comandos de test y typecheck detectados antes de dar el trabajo por terminado.',
  'init.wa-docs':
    '- Actualiza la documentación pertinente (ADRs, docs de diseño/módulo, referencia de API, CHANGELOG) antes de dar el trabajo por terminado.',

  'init.arch.title': '# Instrucciones de arquitectura',
  'init.arch.backend': '- Backend detectado: {value}.',
  'init.arch.frontend': '- Frontend detectado: {value}.',
  'init.arch.api-dirs': '- Directorios de API: {value}.',
  'init.arch.domain-dirs': '- Directorios de dominio: {value}.',
  'init.arch.describe':
    'Describe aquí los límites de módulos, las reglas de capas y la dirección de dependencias.',

  'init.test.title': '# Instrucciones de testing',
  'init.test.dirs': '- Directorios de tests: {value}.',
  'init.test.run': '- Ejecuta los tests con `{cmd}`.',
  'init.test.no-cmd':
    '- No se detectó comando de tests — añade uno antes de confiar en la verificación del agente.',
  'init.test.describe':
    'Describe aquí la estrategia de testing (unit/integration/e2e) y las expectativas de cobertura.',

  'init.docs.title': '# Instrucciones de documentación',
  'init.docs.1':
    '- Trata la documentación como parte de "hecho" — como que pasen los tests, no como algo accesorio.',
  'init.docs.2':
    '- Registra las decisiones técnicas relevantes como ADRs (p. ej. `docs/adr/NNNN-titulo.md`).',
  'init.docs.3':
    '- Mantén al día la documentación de módulos y de la API pública con el cambio{suffix}.',
  'init.docs.modules-suffix': ' (módulos: {value})',
  'init.docs.4':
    '- Añade una entrada en `CHANGELOG.md` para cualquier cambio visible para el usuario o de comportamiento.',
  'init.docs.describe':
    'Describe aquí dónde vive la documentación (sitio de docs, directorio de ADR, referencia de API) y las convenciones a seguir.',

  'init.sec.title': '# Instrucciones de seguridad',
  'init.sec.1':
    '- Nunca leas ni escribas ficheros `.env*`, claves privadas ni almacenes de secretos.',
  'init.sec.sensitive': '- Rutas sensibles detectadas: {value}.',
  'init.sec.3':
    '- Los cambios en código de autenticación, facturación o pagos requieren revisión humana.',

  'init.am.banner-1':
    '> Guía para agentes de IA que trabajen en este repositorio. `AGENTS.md` es el',
  'init.am.banner-2':
    '> estándar multi-herramienta que leen Excalibur, Cursor, GitHub Copilot, OpenCode y otros.',
  'init.am.banner-3':
    '> Excalibur lo generó a partir del repositorio en el primer `init` — edítalo libremente y',
  'init.am.banner-4':
    '> mantenlo en Git. La configuración propia de Excalibur vive en `.excalibur/`.',
  'init.am.stack': '## Stack',
  'init.am.no-commands': '_No se detectaron comandos — añádelos aquí._',
  'init.am.install': '- Instalar: `{cmd}`',
  'init.am.layout': '## Estructura del proyecto',
  'init.am.backend-frontend': '- Backend: {backend} · Frontend: {frontend}',
  'init.am.api': '- API: {value}',
  'init.am.domain': '- Módulos de dominio: {value}',
  'init.am.tests': '- Tests: {value}',
  'init.am.migrations': '- Migraciones: {value}',
  'init.am.verify': '- Ejecuta `{test}`{and} antes de dar un cambio por terminado.',
  'init.am.and-typecheck': ' y `{cmd}`',
  'init.am.verify-add':
    '- Añade un comando de tests para poder verificar los cambios antes de darlos por terminados.',
  'init.am.conv-small': '- Mantén los cambios pequeños, enfocados y revisables.',
  'init.am.conv-docs':
    '- Actualiza la documentación pertinente (ADRs, docs de módulo/API, CHANGELOG) como parte de cualquier cambio — no solo el código.',
  'init.am.architecture': '## Arquitectura',
  'init.am.conventions': '## Convenciones',
  'init.am.sensitive-areas': '## Áreas sensibles',
  'init.am.sensitive-detected': 'Ten especial cuidado y espera revisión humana para: {value}.',
  'init.am.sensitive-default':
    'Trata como sensible (revisión humana) el código de autenticación, facturación, pagos y manejo de secretos.',
};

/** Builds the init-prose translator for a locale (defaults to English). */
export function makeInitTranslator(locale: Locale = 'en'): Translator {
  return makeTranslator({ en: EN, es: ES }, locale);
}
