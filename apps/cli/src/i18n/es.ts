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

  // apply
  "apply.confirm": "¿Aplicar el parche {id} a tu árbol de trabajo?",
  "apply.cancelled": "Aplicación cancelada.",
  "apply.applied": "Se aplicó el parche {id} a tu árbol de trabajo ({files}).",
  "apply.no-files": "no se detectaron archivos",

  // changes
  "changes.heading": "Cambios · {runId}",
  "changes.noFileChanges": "  No se registraron cambios de archivos para esta ejecución.",
  "changes.diffstat": "  {files} archivo{plural} · +{insertions} −{deletions}",
  "changes.noUnifiedDiff": "  (no se registró ningún diff unificado para esta ejecución)",

  // cmux
  "cmux.stub": "Stub honesto: la integración con CMUX se activa en el hito OSS-10 — sesiones multipanel (planificador / implementador / revisor / pruebas / registros) con los artefactos guardados en .excalibur/runs/.",
  "cmux.detected": "CMUX detectado en esta máquina — estás listo para OSS-10.",
  "cmux.not-installed": "CMUX no está instalado. Es opcional: todos los flujos de trabajo funcionan sin él.",
  "cmux.fallback": "Mientras tanto: excalibur run \"<task>\" ejecuta los mismos flujos de trabajo en una sola terminal.",

  // discovery
  "discovery.sessionCreated": "Sesión de Discovery {id} ({inputType}) → {dir}",
  "discovery.answerPrompt": "Responde las preguntas a continuación — pulsa Enter para omitir cualquiera de ellas.",
  "discovery.doNotBuild": "Recomendación: no construir. La evidencia recopilada no justifica este trabajo — consulta recommendation.md para conocer los motivos. No se sugiere nada más.",
  "discovery.suggestedNextSteps": "Próximos pasos sugeridos:",
  "discovery.artifacts": "Artefactos: {dir}",
  "discovery.workItemSourcesM4": "Las fuentes de Discovery de tickets (Linear, Jira, GitHub Issues) estarán disponibles en M4. Hasta entonces, pega el texto del ticket: excalibur discovery \"<text>\" --type work_item",
  "discovery.invalidType": "--type debe ser uno de: {types} (se recibió \"{got}\").",
  "discovery.fileNotFound": "Archivo no encontrado: {path}",
  "discovery.provideIdea": "Proporciona una idea para clarificar: excalibur discovery \"Add contract renewal reminders\"",

  // doctor
  "doctor.check.nodeVersion": "versión de node",
  "doctor.detail.nodeTooOld": " — Excalibur requiere Node ≥ 22",
  "doctor.check.gitAvailable": "git disponible",
  "doctor.detail.gitNotFound": "git no encontrado en el PATH",
  "doctor.check.gitRepository": "repositorio git",
  "doctor.detail.gitBranch": "rama: {branch}",
  "doctor.detail.gitNotRepo": "no es un repositorio git — diffs y ramas no disponibles",
  "doctor.detail.excaliburNotInit": "no inicializado — ejecuta `excalibur init` (los valores por defecto siguen funcionando)",
  "doctor.detail.configValid": "válido",
  "doctor.detail.configMissing": "ausente — valores por defecto activos",
  "doctor.check.safetyPreset": "preajuste de seguridad",
  "doctor.detail.presetActive": "{presetId} activo",
  "doctor.detail.presetUnknown": "preajuste desconocido \"{presetId}\" — recurriendo a {fallback}",
  "doctor.check.instructionSources": "fuentes de instrucciones",
  "doctor.detail.sourcesReachable": "{count} configuradas, todas accesibles",
  "doctor.detail.sourcesMissing": "ausentes: {paths}",
  "doctor.check.modelProviders": "proveedores de modelos",
  "doctor.detail.providersMissing": "sin providers.yaml — usando el mock integrado (ejecuta `excalibur models setup`)",
  "doctor.detail.providersValid": "providers.yaml válido",
  "doctor.check.apiKeyEnv": "env de clave api ({name})",
  "doctor.detail.keyEnvSet": "{keyEnv} está definida",
  "doctor.detail.keyEnvUnset": "{keyEnv} no está definida",
  "doctor.check.detectedCommands": "comandos detectados",
  "doctor.detail.commandsNone": "ninguno detectado — los agentes no pueden verificar cambios",
  "doctor.check.workflowCatalog": "catálogo de flujos de trabajo",
  "doctor.detail.workflowCounts": "{workflows} flujos de trabajo, {methodologies} metodologías",
  "doctor.check.extensions": "extensiones",
  "doctor.detail.extensionsLoaded": "{count} cargadas",
  "doctor.detail.loadError": "error de carga",
  "doctor.check.extensionWarnings": "advertencias de extensiones",
  "doctor.check.enterpriseCredentials": "credenciales empresariales",
  "doctor.detail.credentialsConnected": "conectado a {baseUrl}",
  "doctor.detail.credentialsNone": "no configurado (opcional)",
  "doctor.error.failed": "doctor encontró {count} comprobación(es) fallida(s).",

  // fork
  "fork.noSteps": "La ejecución \"{runId}\" no tiene pasos registrados.",
  "fork.atNotWhole": "--at debe ser un número de paso entero entre 1 y {total} (se obtuvo \"{at}\").",
  "fork.atOutOfRange": "--at debe ser un paso entre 1 y {total} (se obtuvo \"{at}\").",
  "fork.created": "Bifurcación {forkRunId} creada. Inspecciónala en su worktree, o reprodúcela: excalibur replay {forkRunId}",

  // logs
  "logs.noRuns": "Aún no hay ejecuciones locales. Inicia una con: excalibur run \"<task>\"",
  "logs.heading": "{id} — {title} ({status})",
  "logs.noEvents": "No se registraron eventos.",

  // patch
  "patch.taskEmpty": "La tarea no puede estar vacía.",
  "patch.applyConfirm": "¿Aplicar el parche a tu árbol de trabajo?",
  "patch.applied": "Parche {id} aplicado a tu árbol de trabajo ({files}).",
  "patch.noFilesDetected": "no se detectaron archivos",
  "patch.next": "Siguiente: excalibur apply {id} · excalibur branch {id} · excalibur reject {id}",

  // pr
  "pr.noRuns": "Aún no hay ejecuciones locales. Inicia una con: excalibur run \"<task>\"",
  "pr.saved": "Guardado en {path}",
  "pr.stub": "Stub honesto: `pr-create` se activa en el hito OSS-9 (M2), abriendo pull requests a través de la CLI de GitHub.",
  "pr.ghDetected": "CLI de GitHub (gh) detectada — estás listo para M2.",
  "pr.ghMissing": "CLI de GitHub (gh) no encontrada en PATH. Instálala desde https://cli.github.com para estar listo.",
  "pr.untilThen": "Mientras tanto: excalibur pr-summary imprime un resumen que puedes pegar en un PR.",

  // replay
  "replay.at-must-be-positive": "--at debe ser un número de paso positivo (se recibió \"{at}\").",

  // review
  "review.cleanTree": "El árbol de trabajo está limpio — no hay nada que revisar.",
  "review.noTypecheck": "No hay ningún comando de typecheck configurado — se omiten los diagnósticos.",
  "review.runningDiagnostics": "Ejecutando diagnósticos: {typecheck}…",
  "review.typecheckErrors": "El typecheck informó {count} error(es) — se ancla la revisión en ellos.",
  "review.typecheckClean": "El typecheck está limpio.",

  // run
  "run.task_empty": "La tarea no puede estar vacía.",

  // swarm
  "swarm.taskEmpty": "La tarea no puede estar vacía.",
  "swarm.needsGitRepo": "El enjambre necesita un repositorio git: cada agente se ejecuta en un árbol de trabajo aislado.",
  "swarm.decomposing": "Descomponiendo la tarea en subtareas independientes…",
  "swarm.heading": "Enjambre: {reason}",
  "swarm.singleUnit": "Solo una unidad independiente: esto se ejecuta como un único agente (sin paralelismo real).",
  "swarm.confirmRun": "¿Ejecutar {count} agente(s) en paralelo?",
  "swarm.cancelled": "Enjambre cancelado.",
  "swarm.running": "Ejecutando… cada agente trabaja en su propio árbol de trabajo aislado.",
  "swarm.noChanges": "No se produjeron cambios.",
  "swarm.confirmApply": "¿Aplicar los cambios fusionados a tu árbol de trabajo?",
  "swarm.leftUnapplied": "Se dejó sin aplicar. El diff fusionado se muestra arriba.",
  "swarm.applied": "Se aplicaron los cambios fusionados del enjambre a tu árbol de trabajo.",
  "swarm.applyFailed": "No se pudo aplicar el diff fusionado: {error}",

  // weekly-plan
  "weekly-plan.saved": "Guardado en {path}",
};
