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

  // branch
  "branch.not-a-repo": "No se puede crear la rama {branchName}: {repoRoot} no es un repositorio git. Ejecuta `git init` primero.",
  "branch.empty-diff": "El parche {patchId} tiene un diff vacío — no hay nada que aplicar sobre una rama. Vuelve a generarlo con `excalibur patch \"<task>\"`.",
  "branch.confirm": "¿Crear la rama git {branchName} y aplicar el parche sobre ella?",
  "branch.cancelled": "Creación de la rama cancelada.",
  "branch.applied-failed": "Se creó la rama {branchName}, pero el parche no se aplicó: {reason}. Estás en {branchName}; resuélvelo manualmente o vuelve a generar el parche.",
  "branch.no-files-detected": "no se detectaron archivos",
  "branch.applied-success": "Se creó la rama {branchName} y se aplicó el parche ({files}).",

  // login
  "login.experimental-note": "Experimental: el plano de control de Excalibur Enterprise aún no es público. Todo sigue funcionando localmente sin una cuenta.",
  "login.not-connected-sync": "Sin conexión. Ejecuta primero `excalibur login` (o define {baseUrlEnv} y {apiKeyEnv}).",
  "login.no-local-runs": "Aún no hay ejecuciones locales que sincronizar. Crea una con: excalibur run \"<task>\"",
  "login.synced": "Ejecución {runId} sincronizada con {baseUrl}.",
  "login.ask-base-url": "URL base de Enterprise (p. ej. https://excalibur.your-company.com):",
  "login.base-url-required": "Se requiere una URL base de Enterprise. Usa --base-url <url> o responde a la solicitud.",
  "login.ask-api-key": "Clave de API (almacenada localmente con modo de archivo 0600):",
  "login.api-key-required": "Se requiere una clave de API. Usa --api-key <key> o responde a la solicitud.",
  "login.credentials-saved": "Credenciales guardadas en {filePath} (modo 0600).",
  "login.env-precedence": "Las variables de entorno {baseUrlEnv} / {apiKeyEnv} tienen prioridad cuando están definidas.",
  "login.not-connected-status": "Sin conexión. Ejecuta `excalibur login` o define {baseUrlEnv} y {apiKeyEnv}.",
  "login.connected": "Conectado a {baseUrl}.",
  "login.credentials-file": "Archivo de credenciales: {path}",

  // methodologies
  "methodologies.unknown": "Metodología desconocida \"{id}\". Disponibles: {known}",
  "methodologies.heading": "{name} ({id})",
  "methodologies.use-when": "Usar cuando:",
  "methodologies.avoid-when": "Evitar cuando:",
  "methodologies.default-workflow": "Flujo de trabajo predeterminado: {workflow}",
  "methodologies.phases": "Fases: {phases}",
  "methodologies.risk-profile": "Perfil de riesgo: {risk}",

  // models
  "models.test-mock": "El proveedor \"{provider}\" es el mock sin conexión — no hay nada que alcanzar por la red. Configura un proveedor real con `excalibur models setup` para probar una conexión en vivo.",
  "models.test-sending": "Probando el proveedor \"{provider}\"{modelLabel} — enviando una petición mínima…",
  "models.test-connected": "Conectado — {provider}{modelLabel} respondió en {seconds}s · {tokens}{cost}.",
  "models.test-reply": "Respuesta: \"{reply}\"",
  "models.test-failed": "No se pudo alcanzar el proveedor \"{provider}\"{modelLabel}: {message} Comprueba que la variable de entorno de la API key esté exportada y que la URL base/el modelo sean correctos (`excalibur models list`).",
  "models.list-none": "No hay ningún proveedor de LLM configurado. Ejecuta `excalibur models setup` — la opción gratuita por defecto es Ollama local; Kimi K2 (Moonshot) es la opción de pago recomendada (trae tu propia clave).",
  "models.status-built-in": "listo (integrado)",
  "models.status-ready-set": "listo · define {apiKeyEnv}",
  "models.status-ready": "listo",
  "models.setup-skipped": "Configuración del proveedor omitida. Excalibur necesita un LLM — ejecuta `excalibur models setup` cuando quieras (gratis: Ollama local · recomendado: Kimi K2 vía Moonshot, BYOK).",
  "models.setup-wrote": "Se escribió {filePath}",
  "models.setup-keys-note": "Las API keys se leen de las variables de entorno en el momento de la llamada — nunca se almacenan.",
  "models.setup-test-confirm": "¿Probar la conexión ahora? (envía una petición mínima)",

  // skills
  "skills.none-detected": "No se detectaron skills (se buscó **/SKILL.md en el repositorio y en ~/.claude/skills).",
  "skills.list-footer": "Las skills nunca se ejecutan automáticamente; actívalas de forma explícita por repositorio.",
  "skills.inspect-heading": "{id} — {name}",
  "skills.inspect-description": "Descripción: {description}",
  "skills.inspect-path": "Ruta: {path} · Ámbito: {scope}",
  "skills.inspect-trust": "Confianza: {trust} · Habilitada: {enabled}",
  "skills.inspect-triggers": "Disparadores: {triggers}",
  "skills.inspect-dependencies": "Dependencias: {dependencies}",
  "skills.inspect-tools": "Herramientas requeridas: {tools}",
  "skills.enable-needs-accept-risk": "La skill \"{id}\" es {trustLevel}. Revisa {path} primero y luego vuelve a ejecutar con --accept-risk. La opción --yes por sí sola nunca habilita skills sin revisar.",
  "skills.enable-risk-accepted": "Habilitando la skill {trustLevel} \"{name}\" — aceptaste el riesgo de forma explícita (--accept-risk).",
  "skills.enabled": "Skill \"{id}\" habilitada en {dir}/config.yaml.",
  "skills.enabled-footer": "Las skills nunca se ejecutan automáticamente — solo se incorporan al contexto efectivo.",
  "skills.disabled": "Skill \"{id}\" deshabilitada en {dir}/config.yaml.",

  // status
  "status.no-discovery-sessions": "No hay sesiones de descubrimiento locales. Inicia una con: excalibur discovery \"<idea>\"",
  "status.no-runs": "Aún no hay ejecuciones locales. Inicia una con: excalibur run \"<task>\"",
  "status.rewind-hint": "Rebobina cualquier ejecución como un vídeo: excalibur rewind <id>",
  "status.counts": "Parches: {patches} · Interacciones: {interactions} · Ejecuciones: {runs}",
  "status.next-steps-heading": "Próximos pasos útiles:",
  "status.next-step-team": "  - Comparte los estándares del equipo: excalibur init --team",
  "status.next-step-instructions": "  - Añade instrucciones personalizadas en .excalibur/instructions/",
  "status.next-step-paths": "  - Refuerza las reglas para rutas sensibles en .excalibur/config.yaml (autonomy.paths)",
  "status.next-step-github": "  - Conecta GitHub Issues y elementos de trabajo (llega en M4)",

  // update
  "update.checking": "Buscando actualizaciones… (instalada {current})",
  "update.check-failed": "No se pudieron comprobar las actualizaciones{errSuffix}. Puedes actualizar en cualquier momento con: {cmd}",
  "update.up-to-date": "Estás al día — @excalibur/cli {current} es la última versión.",
  "update.ahead": "La versión instalada de @excalibur/cli {current} es más reciente que la última publicada ({latest}). No hay nada que actualizar.",
  "update.available": "Actualización disponible: {current} → {latest}",
  "update.upgrade-with": "Actualiza con: {cmd}",
  "update.confirm-run": "¿Ejecutar \"{cmd}\" ahora?",
  "update.running": "Ejecutando: {cmd}",
  "update.upgraded": "Actualizado a @excalibur/cli@latest ({latest}). Reinicia tu terminal para usarlo.",
  "update.upgrade-failed": "El comando de actualización falló: {message}. Ejecútalo manualmente: {cmd}",

  // workflows
  "workflows.explain-hint": "Explica uno con: excalibur workflows explain <id>",
  "workflows.unknown": "Flujo de trabajo desconocido \"{id}\". Disponibles: {known}",
  "workflows.title": "{name} ({id})",
  "workflows.mode": "Modo: {mode}",
  "workflows.levels": "Niveles de autonomía admitidos: {levels}",
  "workflows.phases-heading": "Fases:",
  "workflows.phase-role": "rol: {role}",
  "workflows.phase-optional": "(opcional)",
  "workflows.phase-approval": "aprobación: {approval}",
  "workflows.phase-confirmation": "requiere confirmación",
  "workflows.artifacts": "Artefactos: {artifacts}",
};
