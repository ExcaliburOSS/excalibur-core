import type { Catalog } from '@excalibur/shared';

/**
 * Spanish message catalog. Each key mirrors `en.ts`; a missing key falls back to
 * English via the translator, so partial coverage is safe during migration.
 */
export const ES: Catalog = {
  'welcome.epigraph': 'La espada está desenvainada. ¿Qué construimos?',

  // Chrome interactivo compartido.
  'common.select_hint': '↑/↓ para mover · Enter para elegir · Esc para cancelar',

  // Onboarding zero-config — primer `excalibur` en un repo sin configurar.
  'onboarding.title': 'Configurando Excalibur para este proyecto…',
  'onboarding.intro':
    'Primera vez por aquí — vamos a conectar un modelo y crear un .excalibur/ mínimo. Tarda unos segundos.',
  'onboarding.created': 'Creado:',
  'onboarding.noProvider':
    'Sin modelo configurado — funcionando con el mock offline integrado. Ejecuta `excalibur models setup` para conectar un modelo real.',

  // Ubicación del proyecto — "¿estás en un proyecto o creas uno nuevo?".
  'project-location.empty-folder': 'Carpeta vacía — configurando aquí tu nuevo proyecto.',
  'project-location.root-title': 'Vamos a crear un proyecto nuevo',
  'project-location.root-intro':
    'Estás en {cwd} — no es una carpeta de proyecto. Vamos a crear uno (con su propio repositorio git).',
  'project-location.ambiguous-q': 'Esta carpeta ({cwd}) aún no es un proyecto. ¿Qué quieres hacer?',
  'project-location.opt-create': 'Crear un proyecto nuevo',
  'project-location.opt-create-hint': 'una subcarpeta nueva con su propio repo git',
  'project-location.opt-here': 'Usar este directorio',
  'project-location.opt-here-hint': 'configurar Excalibur aquí mismo',
  'project-location.ask-name': 'Nombre del proyecto [my-project]:',
  'project-location.name-empty': 'Introduce un nombre de proyecto.',
  'project-location.name-separators':
    'El nombre no puede contener separadores de ruta ni "..". Usa un nombre de carpeta simple.',
  'project-location.name-reserved': 'El nombre no puede empezar por punto.',
  'project-location.name-exists': '"{name}" ya existe aquí — elige otro nombre.',
  'project-location.created': 'Proyecto {name} creado en {path}.',
  'new.name-required': 'Hace falta un nombre de proyecto: excalibur new <nombre>.',
  'new.next-steps': 'Ahora: cd {name} && excalibur — tu primer arranque conecta un modelo.',

  // Panel web acompañante, auto-arrancado con la shell interactiva.
  'dashboard.up': '▸ Panel web en {url}',

  'init.detected': 'Detectado:',
  'init.detected.none': 'nada específico — se aplican los valores por defecto',
  'init.usingInstructions': 'Usando instrucciones existentes:',
  'init.created': 'Creado:',
  'init.skipped':
    '  Se omitieron {count} fichero(s) existente(s) — vuelve a ejecutar con --force para sobrescribir.',
  'init.enriching': 'Enriqueciendo AGENTS.md con tu modelo…',
  'init.noProvider':
    'Aún no hay proveedor de modelo configurado — los comandos usan el proveedor mock integrado (M1). Ejecuta `excalibur models setup` cuando quieras.',
  'init.tryNow': 'Prueba ahora:',
  'init.cancelled': 'Init cancelado — no se escribió nada.',
  'init.applyQuestion': '¿Aplicar estos cambios?',
  'init.applyQuestionUpdate': 'Algunos ficheros ya existen (ver arriba). ¿Aplicar los cambios?',

  // branch
  'branch.not-a-repo':
    'No se puede crear la rama {branchName}: {repoRoot} no es un repositorio git. Ejecuta `git init` primero.',
  'branch.empty-diff':
    'El parche {patchId} tiene un diff vacío — no hay nada que aplicar sobre una rama. Vuelve a generarlo con `excalibur patch "<task>"`.',
  'branch.confirm': '¿Crear la rama git {branchName} y aplicar el parche sobre ella?',
  'branch.cancelled': 'Creación de la rama cancelada.',
  'branch.applied-failed':
    'Se creó la rama {branchName}, pero el parche no se aplicó: {reason}. Estás en {branchName}; resuélvelo manualmente o vuelve a generar el parche.',
  'branch.no-files-detected': 'no se detectaron archivos',
  'branch.applied-success': 'Se creó la rama {branchName} y se aplicó el parche ({files}).',

  // login
  'login.experimental-note':
    'Experimental: el plano de control de Excalibur Enterprise aún no es público. Todo sigue funcionando localmente sin una cuenta.',
  'login.not-connected-sync':
    'Sin conexión. Ejecuta primero `excalibur login` (o define {baseUrlEnv} y {apiKeyEnv}).',
  'login.no-local-runs':
    'Aún no hay ejecuciones locales que sincronizar. Crea una con: excalibur run "<task>"',
  'login.synced': 'Ejecución {runId} sincronizada con {baseUrl}.',
  'login.ask-base-url': 'URL base de Enterprise (p. ej. https://excalibur.your-company.com):',
  'login.base-url-required':
    'Se requiere una URL base de Enterprise. Usa --base-url <url> o responde a la solicitud.',
  'login.ask-api-key': 'Clave de API (almacenada localmente con modo de archivo 0600):',
  'login.api-key-required':
    'Se requiere una clave de API. Usa --api-key <key> o responde a la solicitud.',
  'login.credentials-saved': 'Credenciales guardadas en {filePath} (modo 0600).',
  'login.env-precedence':
    'Las variables de entorno {baseUrlEnv} / {apiKeyEnv} tienen prioridad cuando están definidas.',
  'login.not-connected-status':
    'Sin conexión. Ejecuta `excalibur login` o define {baseUrlEnv} y {apiKeyEnv}.',
  'login.connected': 'Conectado a {baseUrl}.',
  'login.credentials-file': 'Archivo de credenciales: {path}',

  // methodologies
  'methodologies.unknown': 'Metodología desconocida "{id}". Disponibles: {known}',
  'methodologies.heading': '{name} ({id})',
  'methodologies.use-when': 'Usar cuando:',
  'methodologies.avoid-when': 'Evitar cuando:',
  'methodologies.default-workflow': 'Flujo de trabajo predeterminado: {workflow}',
  'methodologies.phases': 'Fases: {phases}',
  'methodologies.risk-profile': 'Perfil de riesgo: {risk}',

  // models
  'models.test-mock':
    'El proveedor "{provider}" es el mock sin conexión — no hay nada que alcanzar por la red. Configura un proveedor real con `excalibur models setup` para probar una conexión en vivo.',
  'models.test-sending':
    'Probando el proveedor "{provider}"{modelLabel} — enviando una petición mínima…',
  'models.test-connected':
    'Conectado — {provider}{modelLabel} respondió en {seconds}s · {tokens}{cost}.',
  'models.test-reply': 'Respuesta: "{reply}"',
  'models.test-failed':
    'No se pudo alcanzar el proveedor "{provider}"{modelLabel}: {message} Comprueba que la variable de entorno de la API key esté exportada y que la URL base/el modelo sean correctos (`excalibur models list`).',
  'models.list-none':
    'No hay ningún proveedor de LLM configurado. Ejecuta `excalibur models setup` — la opción gratuita por defecto es Ollama local; Kimi K2 (Moonshot) es la opción de pago recomendada (trae tu propia clave).',
  'models.status-built-in': 'listo (integrado)',
  'models.status-ready-set': 'listo · define {apiKeyEnv}',
  'models.status-ready': 'listo',
  'models.setup-skipped':
    'Configuración del proveedor omitida. Excalibur necesita un LLM — ejecuta `excalibur models setup` cuando quieras (gratis: Ollama local · recomendado: Kimi K2 vía Moonshot, BYOK).',
  'models.setup-wrote': 'Se escribió {filePath}',
  'models.setup-keys-note':
    'Las API keys se leen de las variables de entorno en el momento de la llamada — nunca se almacenan.',
  'models.setup-test-confirm': '¿Probar la conexión ahora? (envía una petición mínima)',

  // skills
  'skills.none-detected':
    'No se detectaron skills (se buscó **/SKILL.md en el repositorio y en ~/.claude/skills).',
  'skills.list-footer':
    'Las skills nunca se ejecutan automáticamente; actívalas de forma explícita por repositorio.',
  'skills.inspect-heading': '{id} — {name}',
  'skills.inspect-description': 'Descripción: {description}',
  'skills.inspect-path': 'Ruta: {path} · Ámbito: {scope}',
  'skills.inspect-trust': 'Confianza: {trust} · Habilitada: {enabled}',
  'skills.inspect-triggers': 'Disparadores: {triggers}',
  'skills.inspect-dependencies': 'Dependencias: {dependencies}',
  'skills.inspect-tools': 'Herramientas requeridas: {tools}',
  'skills.enable-needs-accept-risk':
    'La skill "{id}" es {trustLevel}. Revisa {path} primero y luego vuelve a ejecutar con --accept-risk. La opción --yes por sí sola nunca habilita skills sin revisar.',
  'skills.enable-risk-accepted':
    'Habilitando la skill {trustLevel} "{name}" — aceptaste el riesgo de forma explícita (--accept-risk).',
  'skills.enabled': 'Skill "{id}" habilitada en {dir}/config.yaml.',
  'skills.enabled-footer':
    'Las skills nunca se ejecutan automáticamente — solo se incorporan al contexto efectivo.',
  'skills.disabled': 'Skill "{id}" deshabilitada en {dir}/config.yaml.',

  // status
  'ask.schema-invalid': 'La respuesta del modelo no cumplió del todo el esquema: {errors}',
  'mcp.none':
    'No hay servidores MCP configurados. Añádelos en `mcp.servers` de .excalibur/config.yaml (un `command` local o una `url` remota).',
  'mcp.col-name': 'NOMBRE',
  'mcp.col-transport': 'TRANSPORTE',
  'mcp.col-target': 'DESTINO',
  'mcp.col-trust': 'CONFIANZA',
  'mcp.probe-hint':
    'Ejecuta `excalibur mcp list --probe` para conectar y listar las herramientas de cada servidor.',
  // registro MCP + OAuth (F6)
  'mcp.col-score': 'PUNTUACIÓN',
  'mcp.col-desc': 'DESCRIPCIÓN',
  'mcp.registry-empty': 'Ningún servidor coincide en el registro firmado.',
  'mcp.add-hint': 'Añade uno con `excalibur mcp add <nombre>`.',
  'mcp.registry-unknown':
    'No hay servidor "{name}" en el registro. Ejecuta `excalibur mcp search`.',
  'mcp.added':
    'Añadido el servidor MCP "{name}" ({trust}, puntuación {score}) a .excalibur/config.yaml.',
  'mcp.added-oauth-hint': 'Es un servidor remoto — autorízalo con `excalibur mcp auth {name}`.',
  'mcp.auth-unknown': 'No hay servidor MCP "{name}" en .excalibur/config.yaml.',
  'mcp.auth-not-remote':
    'El servidor MCP "{name}" es local (stdio) — OAuth aplica a servidores remotos (url).',
  'mcp.auth-starting': 'Autorizando el servidor MCP "{name}" (abriendo el navegador)…',
  'mcp.auth-open': 'Si el navegador no se abrió, visita:\n  {url}',
  'mcp.auth-done':
    'Autorizado "{name}" — el token se guarda de forma segura (~/.config/excalibur/mcp).',
  'mcp.auth-failed': 'La autorización falló: {message}',
  // búsqueda web (F3)
  'search.usage':
    'Uso: excalibur search <consulta>. Gestiona el motor local con `search serve`, o elige backend con `search provider`.',
  'search.results-heading': 'Resultados de "{query}" (vía {provider})',
  'search.no-results': 'Sin resultados para "{query}" (vía {provider}).',
  'search.error': 'La búsqueda falló: {message}',
  'search.network-off':
    'La red está desactivada (permissions.network.mode = off). Actívala para buscar en la web.',
  'search.serve-consent':
    '¿Arrancar un contenedor SearXNG local con Docker para búsqueda ilimitada y privada?',
  'search.serve-starting':
    'Arrancando SearXNG local con Docker (la primera vez descarga la imagen)…',
  'search.serve-up': 'SearXNG disponible en {url} — Excalibur lo usará automáticamente.',
  'search.serve-cancelled':
    'Cancelado — no se arrancó ningún contenedor. La búsqueda sigue funcionando vía DuckDuckGo.',
  'search.serve-stopped': 'SearXNG local detenido y eliminado.',
  'search.serve-not-running': 'No hay contenedor SearXNG local que detener.',
  'search.serve-no-docker':
    'Docker no está disponible — la búsqueda recurre a DuckDuckGo sin clave (igualmente gratis, sin configuración).',
  'search.serve-status': 'SearXNG local: {state} (accesible: {reachable})',
  'search.reachable-yes': 'sí',
  'search.reachable-no': 'no',
  'search.provider-current':
    'Backend de búsqueda: {name}. Cambia con `excalibur search provider <nombre>`.',
  'search.provider-set': 'Backend de búsqueda fijado a {name}.',
  'search.provider-unknown': 'Backend desconocido "{name}". Elige uno de: {names}.',
  'search.provider-byok-hint':
    'Este backend es de pago (BYOK): define `search.apiKeyEnv` con el NOMBRE de la variable de entorno que contiene tu clave.',
  // navegador local (F4)
  'browser.node-missing':
    'Node/npx no está disponible, así que no se puede instalar el navegador local. La descarga Tier-1 sigue funcionando (gratis).',
  'browser.install-consent':
    '¿Instalar Chromium (vía Playwright, ~150MB) para que Excalibur pueda renderizar páginas con mucho JS?',
  'browser.installing': 'Instalando Chromium vía Playwright (descarga única)…',
  'browser.cancelled':
    'Cancelado — no se instaló Chromium. La descarga Tier-1 sigue funcionando (gratis).',
  'browser.enabled':
    'Navegador local activado — web_fetch escalará a un render real cuando haga falta.',
  'browser.disabled': 'Navegador local desactivado — fetch usa solo la vía rápida Tier-1.',
  'browser.status': 'Navegador local: {state} (escalado: {enabled})',
  'browser.on': 'activado',
  'browser.off': 'desactivado',
  'browser.removed': 'Chromium desinstalado y escalado de navegador desactivado.',
  'browser.remove-none': 'No hay Chromium que eliminar; escalado de navegador desactivado.',
  // fetch web + lectores alojados (F5)
  'web.usage':
    'Uso: excalibur web <url>. Configura un lector alojado opcional con `web reader <firecrawl|jina|browserbase>`.',
  'web.reader-none':
    'No hay lector alojado configurado — web_fetch usa las capas locales gratuitas (Tier-1 + el navegador opcional).',
  'web.reader-current': 'Lector alojado: {name} (env de la clave: {env}).',
  'web.reader-set': 'Lector alojado fijado a {name}.',
  'web.reader-unknown': 'Lector alojado desconocido "{name}". Elige uno de: {names}.',
  'web.reader-byok-hint':
    'Este lector es de pago (BYOK): define `scrape.apiKeyEnv` con el NOMBRE de la variable de entorno que contiene tu clave.',
  'web.reader-jina-hint':
    'Jina funciona sin clave (best-effort); define `scrape.apiKeyEnv` para límites más altos.',
  'web.error': 'la descarga web falló: {message}',
  'web.scan-denied': 'Esa URL está bloqueada por la política de red / la protección SSRF.',
  'web.scan-result': 'Escaneo de inyección: {verdict} (puntuación {score}, sha256 {hash}).',
  'web.scan-signals': 'Señales: {signals}',
  'web.prov-noruns':
    'Aún no hay ejecuciones — nada que auditar. Inicia una con: excalibur run "<tarea>"',
  'web.prov-none': 'Esta ejecución no hizo ninguna salida de red auditada.',
  'web.col-tool': 'HERRAMIENTA',
  'web.col-target': 'OBJETIVO',
  'web.col-decision': 'DECISIÓN',
  'web.col-source': 'FUENTE',
  'web.col-verdict': 'VEREDICTO',
  'web.col-hash': 'SHA256',
  'insights.no-runs':
    'Aún no hay ejecuciones locales — nada que resumir. Inicia una con: excalibur run "<tarea>"',
  'insights.title': 'Insights — {runs} ejecuciones',
  'insights.status': 'estado   ',
  'insights.completion': 'completadas',
  'insights.blocked': 'bloqueadas por verificación',
  'insights.spend': 'gasto    ',
  'insights.avg': '(media {cost}/ejecución)',
  'insights.tokens': 'tokens   ',
  'insights.calls': 'llamadas al modelo',
  'insights.activity': 'actividad',
  'insights.files': 'ficheros cambiados',
  'insights.approvals': 'aprobaciones',
  'insights.by-model': 'Por modelo',
  'insights.by-workflow': 'Por workflow',
  'insights.trend': 'Ejecuciones por día',
  'insights.col-name': 'NOMBRE',
  'insights.col-runs': 'EJEC.',
  'insights.col-cost': 'COSTE',
  'insights.col-tokens': 'TOKENS',
  'insights.since-invalid': 'Ignorando --since "{window}": usa una ventana como 7d o 24h.',
  'serve.listening': 'Servidor de Excalibur escuchando en {base} (solo lectura).',
  'serve.token': '  token: {token}',
  'serve.example': '  prueba: curl {base}/api/runs?token={token}',
  'serve.stop': '  Ctrl-C para parar.',
  'serve.port-in-use': 'El puerto {port} ya está en uso — usa --port <n>.',
  'work-items.none': 'No se encontraron issues.',
  'work-items.comments': '{count} comentario(s):',
  'work-items.comment-empty':
    'Indica el texto del comentario: excalibur work-items comment <número> <texto>',
  'work-items.commented': 'Comentado en la issue #{number}.',
  'work-items.running': 'Ejecutando la issue {key} como tarea: {title}',
  'work-items.create-empty': 'Un work item necesita un título.',
  'work-items.created': 'Work item local {key} creado.',
  'work-items.status-updated': 'Estado de {key} → {status}.',
  'diagnostics.noTypecheck':
    'No hay comando de typecheck configurado — se omiten los diagnósticos post-ejecución.',
  'diagnostics.cleanAfter': 'Diagnósticos: el typecheck está limpio tras la ejecución.',
  'diagnostics.repairing':
    'Diagnósticos: quedan {count} error(es) reales de compilación — ejecutando una pasada de reparación…',
  'diagnostics.repaired':
    'Diagnósticos: la pasada de reparación eliminó los errores de compilación. ✓',
  'diagnostics.stillErrors':
    'Diagnósticos: aún quedan {count} error(es) de compilación tras la reparación.',
  'diagnostics.skipBudget':
    'Diagnósticos: se omite la reparación — la ejecución alcanzó su tope de presupuesto (reparar volvería a gastarlo).',
  'status.no-discovery-sessions':
    'No hay sesiones de descubrimiento locales. Inicia una con: excalibur discovery "<idea>"',
  'status.no-runs': 'Aún no hay ejecuciones locales. Inicia una con: excalibur run "<task>"',
  'status.rewind-hint': 'Rebobina cualquier ejecución como un vídeo: excalibur rewind <id>',
  'status.counts': 'Parches: {patches} · Interacciones: {interactions} · Ejecuciones: {runs}',
  'status.next-steps-heading': 'Próximos pasos útiles:',
  'status.next-step-team': '  - Comparte los estándares del equipo: excalibur init --team',
  'status.next-step-instructions':
    '  - Añade instrucciones personalizadas en .excalibur/instructions/',
  'status.next-step-paths':
    '  - Refuerza las reglas para rutas sensibles en .excalibur/config.yaml (autonomy.paths)',
  'status.next-step-github': '  - Conecta GitHub Issues y elementos de trabajo (llega en M4)',

  // update
  'update.checking': 'Buscando actualizaciones… (instalada {current})',
  'update.check-failed':
    'No se pudieron comprobar las actualizaciones{errSuffix}. Puedes actualizar en cualquier momento con: {cmd}',
  'update.up-to-date': 'Estás al día — @excalibur-oss/excalibur {current} es la última versión.',
  'update.ahead':
    'La versión instalada de @excalibur-oss/excalibur {current} es más reciente que la última publicada ({latest}). No hay nada que actualizar.',
  'update.available': 'Actualización disponible: {current} → {latest}',
  'update.upgrade-with': 'Actualiza con: {cmd}',
  'update.confirm-run': '¿Ejecutar "{cmd}" ahora?',
  'update.running': 'Ejecutando: {cmd}',
  'update.upgraded':
    'Actualizado a @excalibur-oss/excalibur@latest ({latest}). Reinicia tu terminal para usarlo.',
  'update.upgrade-failed':
    'El comando de actualización falló: {message}. Ejecútalo manualmente: {cmd}',

  // workflows
  'workflows.explain-hint': 'Explica uno con: excalibur workflows explain <id>',
  'workflows.unknown': 'Flujo de trabajo desconocido "{id}". Disponibles: {known}',
  'workflows.title': '{name} ({id})',
  'workflows.mode': 'Modo: {mode}',
  'workflows.levels': 'Niveles de autonomía admitidos: {levels}',
  'workflows.phases-heading': 'Fases:',
  'workflows.phase-role': 'rol: {role}',
  'workflows.phase-optional': '(opcional)',
  'workflows.phase-approval': 'aprobación: {approval}',
  'workflows.phase-confirmation': 'requiere confirmación',
  'workflows.artifacts': 'Artefactos: {artifacts}',

  // apply
  'apply.confirm': '¿Aplicar el parche {id} a tu árbol de trabajo?',
  'apply.cancelled': 'Aplicación cancelada.',
  'apply.applied': 'Se aplicó el parche {id} a tu árbol de trabajo ({files}).',
  'apply.no-files': 'no se detectaron archivos',

  // changes
  'theme.heading': 'Temas del TUI (→ = actual):',
  'theme.usage': 'Elige uno con `excalibur theme <nombre>` (se guarda en .excalibur/config.yaml).',
  'theme.unknown': 'Tema desconocido «{name}». Elige uno de: {names}.',
  'theme.set': 'Tema cambiado a {name} (guardado). Reinicia el shell para verlo en todas partes.',
  'verify.no-changes': 'El run {runId} no cambió nada que verificar.',
  'verify.plan': 'Malla de verificación — {reason}.',
  'verify.running': 'Corriendo verificadores adversariales aislados: {lenses}…',
  'plans.none':
    'Aún no hay planes guardados. Aprueba un plan en modo plan y se guarda en .excalibur/plans/.',
  'plans.heading': 'Planes guardados ({count}) · más recientes primero:',
  'plans.footer': 'Cada plan es markdown portable — reejecútalo o forkéalo desde su run.',
  'session-log.empty': 'Aún no hay runs en esta sesión.',
  'session-log.heading': 'Registro de sesión · {runs} runs · {cost} total',
  'session-log.untitled': '(sin título)',
  'session-log.footer':
    'Escribe el número de un run para abrir su máquina del tiempo · q para salir',
  'session-log.prompt': '  log> ',
  'session-log.invalid': 'Escribe un número entre 1 y {max}, o q.',
  'changes.heading': 'Cambios · {runId}',
  'changes.noFileChanges': '  No se registraron cambios de archivos para esta ejecución.',
  'changes.diffstat': '  {files} archivo{plural} · +{insertions} −{deletions}',
  'changes.noUnifiedDiff': '  (no se registró ningún diff unificado para esta ejecución)',

  // cmux
  'cmux.stub':
    'Stub honesto: la integración con CMUX se activa en el hito OSS-10 — sesiones multipanel (planificador / implementador / revisor / pruebas / registros) con los artefactos guardados en .excalibur/runs/.',
  'cmux.detected': 'CMUX detectado en esta máquina — estás listo para OSS-10.',
  'cmux.not-installed':
    'CMUX no está instalado. Es opcional: todos los flujos de trabajo funcionan sin él.',
  'cmux.fallback':
    'Mientras tanto: excalibur run "<task>" ejecuta los mismos flujos de trabajo en una sola terminal.',

  // discovery
  'discovery.sessionCreated': 'Sesión de Discovery {id} ({inputType}) → {dir}',
  'discovery.answerPrompt':
    'Responde las preguntas a continuación — pulsa Enter para omitir cualquiera de ellas.',
  'discovery.shapeConsider': 'Aspectos que quizá quieras incluir en el alcance (espacio marca):',
  'discovery.shapePrompt': '¿Incluir en el alcance?',
  'discovery.doNotBuild':
    'Recomendación: no construir. La evidencia recopilada no justifica este trabajo — consulta recommendation.md para conocer los motivos. No se sugiere nada más.',
  'discovery.suggestedNextSteps': 'Próximos pasos sugeridos:',
  'discovery.artifacts': 'Artefactos: {dir}',
  'discovery.workItemSourcesM4':
    'Las fuentes de Discovery de tickets (Linear, Jira, GitHub Issues) estarán disponibles en M4. Hasta entonces, pega el texto del ticket: excalibur discovery "<text>" --type work_item',
  'discovery.invalidType': '--type debe ser uno de: {types} (se recibió "{got}").',
  'discovery.fileNotFound': 'Archivo no encontrado: {path}',
  'discovery.provideIdea':
    'Proporciona una idea para clarificar: excalibur discovery "Add contract renewal reminders"',

  // doctor
  'doctor.check.nodeVersion': 'versión de node',
  'doctor.detail.nodeTooOld': ' — Excalibur requiere Node ≥ 22',
  'doctor.check.gitAvailable': 'git disponible',
  'doctor.detail.gitNotFound': 'git no encontrado en el PATH',
  'doctor.check.gitRepository': 'repositorio git',
  'doctor.detail.gitBranch': 'rama: {branch}',
  'doctor.detail.gitNotRepo': 'no es un repositorio git — diffs y ramas no disponibles',
  'doctor.detail.excaliburNotInit':
    'no inicializado — ejecuta `excalibur init` (los valores por defecto siguen funcionando)',
  'doctor.detail.configValid': 'válido',
  'doctor.detail.configMissing': 'ausente — valores por defecto activos',
  'doctor.check.safetyPreset': 'preajuste de seguridad',
  'doctor.detail.presetActive': '{presetId} activo',
  'doctor.detail.presetUnknown': 'preajuste desconocido "{presetId}" — recurriendo a {fallback}',
  'doctor.check.instructionSources': 'fuentes de instrucciones',
  'doctor.detail.sourcesReachable': '{count} configuradas, todas accesibles',
  'doctor.detail.sourcesMissing': 'ausentes: {paths}',
  'doctor.check.modelProviders': 'proveedores de modelos',
  'doctor.detail.providersMissing':
    'sin providers.yaml — usando el mock integrado (ejecuta `excalibur models setup`)',
  'doctor.detail.providersValid': 'providers.yaml válido',
  'doctor.check.apiKeyEnv': 'env de clave api ({name})',
  'doctor.detail.keyEnvSet': '{keyEnv} está definida',
  'doctor.detail.keyEnvUnset': '{keyEnv} no está definida',
  'doctor.check.detectedCommands': 'comandos detectados',
  'doctor.detail.commandsNone': 'ninguno detectado — los agentes no pueden verificar cambios',
  'doctor.check.workflowCatalog': 'catálogo de flujos de trabajo',
  'doctor.detail.workflowCounts': '{workflows} flujos de trabajo, {methodologies} metodologías',
  'doctor.check.extensions': 'extensiones',
  'doctor.detail.extensionsLoaded': '{count} cargadas',
  'doctor.detail.loadError': 'error de carga',
  'doctor.check.extensionWarnings': 'advertencias de extensiones',
  'doctor.check.enterpriseCredentials': 'credenciales empresariales',
  'doctor.detail.credentialsConnected': 'conectado a {baseUrl}',
  'doctor.detail.credentialsNone': 'no configurado (opcional)',
  'doctor.error.failed': 'doctor encontró {count} comprobación(es) fallida(s).',

  // fork
  'fork.noSteps': 'La ejecución "{runId}" no tiene pasos registrados.',
  'fork.atNotWhole': '--at debe ser un número de paso entero entre 1 y {total} (se obtuvo "{at}").',
  'fork.atOutOfRange': '--at debe ser un paso entre 1 y {total} (se obtuvo "{at}").',
  'fork.created':
    'Bifurcación {forkRunId} creada. Inspecciónala en su worktree, o reprodúcela: excalibur replay {forkRunId}',

  // logs
  'logs.noRuns': 'Aún no hay ejecuciones locales. Inicia una con: excalibur run "<task>"',
  'logs.heading': '{id} — {title} ({status})',
  'logs.noEvents': 'No se registraron eventos.',

  // patch
  'patch.taskEmpty': 'La tarea no puede estar vacía.',
  'patch.applyConfirm': '¿Aplicar el parche a tu árbol de trabajo?',
  'patch.applied': 'Parche {id} aplicado a tu árbol de trabajo ({files}).',
  'patch.noFilesDetected': 'no se detectaron archivos',
  'patch.next': 'Siguiente: excalibur apply {id} · excalibur branch {id} · excalibur reject {id}',

  // pr
  'pr.noRuns': 'Aún no hay ejecuciones locales. Inicia una con: excalibur run "<task>"',
  'pr.saved': 'Guardado en {path}',
  'pr.ghRequired':
    'pr-create necesita la CLI de GitHub. Instálala desde https://cli.github.com y ejecuta `gh auth login`.',
  'pr.creating': 'Abriendo un pull request: {title}',
  'pr.confirmCreate': '¿Crear este pull request ahora?',
  'pr.cancelled': 'Cancelado — no se abrió ningún pull request.',
  'pr.defaultBody': 'Abierto por Excalibur.',
  'pr.created': 'Pull request abierto: {url}',
  'pr.createFailed': 'gh no pudo abrir el pull request: {reason}',

  // replay
  'replay.at-must-be-positive': '--at debe ser un número de paso positivo (se recibió "{at}").',

  // review
  'review.cleanTree': 'El árbol de trabajo está limpio — no hay nada que revisar.',
  'review.noTypecheck':
    'No hay ningún comando de typecheck configurado — se omiten los diagnósticos.',
  'review.runningDiagnostics': 'Ejecutando diagnósticos: {typecheck}…',
  'review.typecheckErrors':
    'El typecheck informó {count} error(es) — se ancla la revisión en ellos.',
  'review.typecheckClean': 'El typecheck está limpio.',

  // run
  'run.task_empty': 'La tarea no puede estar vacía.',

  // swarm
  'swarm.taskEmpty': 'La tarea no puede estar vacía.',
  'swarm.needsGitRepo':
    'El enjambre necesita un repositorio git: cada agente se ejecuta en un árbol de trabajo aislado.',
  'swarm.decomposing': 'Descomponiendo la tarea en subtareas independientes…',
  'swarm.heading': 'Enjambre: {reason}',
  'swarm.staged-heading':
    'Enjambre: {count} subtareas en {waves} olas de dependencias (cada ola parte del resultado fusionado de la anterior).',
  'swarm.wave': 'ola {n}',
  'swarm.verifying': 'Verificando el resultado fusionado contra los tests configurados…',
  'swarm.verified': 'Fan-in verificado: {detail}.',
  'swarm.verifyFailed':
    'Fan-in verificado FALLÓ: {detail}. Los cambios fusionados se REVIRTIERON, no se conservaron — los carriles estaban bien por separado pero rompen al combinarse.',
  'swarm.budget-stopped':
    'Tope de presupuesto alcanzado (${spent} de ${cap}) — no lanzo más carriles. Los carriles ya terminados son el resultado parcial.',
  'swarm.retryFailed': '{n} carril(es) fallaron — ¿los reintento ahora?',
  'swarm.mesh-running': 'Revisión adversarial del resultado fusionado ({lenses} lente(s))…',
  'swarm.mesh-blocked':
    'La malla de verificación BLOQUEÓ el merge (sobrevivió un problema de severidad alta). Los cambios fusionados se REVIRTIERON.',
  'swarm.healing':
    'El carril {id} agotó sus intentos — un pase de auto-reparación con el contexto del fallo…',
  'swarm.healed': 'El carril {id} se auto-reparó — se conserva su trabajo corregido.',
  'swarm.heal-failed': 'El carril {id} no pudo auto-repararse — se deja como fallido.',
  'swarm.verify-wave': 'Verificando la onda {wave} (gate antes de que corran sus dependientes)…',
  'swarm.wave-verified': 'Onda {wave} verificada — sus dependientes continúan.',
  'swarm.wave-reverted':
    'La onda {wave} FALLÓ la verificación ({detail}) — revertida para que los dependientes partan del último árbol sano.',
  // explore best-of-N (AO5)
  'explore.heading': 'Explorar: {n} enfoques candidatos en paralelo.',
  'explore.confirm': '¿Lanzo {n} agentes candidatos y elijo el mejor?',
  'explore.cancelled': 'Exploración cancelada.',
  'explore.running': 'Ejecutando candidatos… cada uno en su worktree aislado.',
  'explore.noCandidates': 'Ningún candidato produjo cambios utilizables.',
  'explore.winner': 'Ganador: candidato {n} — {approach}',
  'explore.confirmApply': '¿Aplico el candidato ganador a tu árbol de trabajo?',
  'explore.leftUnapplied': 'Dejo el ganador sin aplicar. El diff está arriba.',
  'explore.applyFailed': 'No se pudo aplicar el ganador: {error}',
  'explore.verifying': 'Verificando el ganador contra los tests configurados…',
  'explore.verified': 'Verificado: {detail}.',
  'explore.verifyFailed': 'El ganador FALLÓ los tests ({detail}) — REVERTIDO, no se conservó.',
  'explore.applied': 'Aplicado el candidato ganador.',
  // orchestrate — re-ejecutar / reanudar desde el manifiesto (AO5)
  'orchestrate.none': 'No hay ninguna orquestación previa. Lanza un swarm o /explore primero.',
  'orchestrate.noManifest': 'No se encontró manifiesto de orquestación para la ejecución {runId}.',
  'orchestrate.nothingToDo': 'Nada que reanudar — todos los carriles ya completaron.',
  'orchestrate.rerunning': 'Re-ejecutando {n} carril(es) de {runId}…',
  'orchestrate.reusing': 'Reutilizando {reused} carril(es) sin cambios; re-ejecutando {rerun}.',
  'orchestrate.resuming': 'Reanudando {n} carril(es) incompletos de {runId}…',
  'orchestrate.runningSpec': 'Ejecutando orquestación autoría: {n} paso(s) de {path}…',
  'orchestration.none': 'No se encontró ninguna orquestación. Lanza un swarm o /explore primero.',
  'orchestration.notFound': 'No se encontró orquestación para la ejecución {id}.',
  'orchestration.heading': 'Orquestación {id} · {task} · {status}',
  'orchestration.pause-set':
    'Orquestación {id} pausada — un swarm en vivo se detendrá al terminar sus carriles en vuelo.',
  'orchestration.resume-set':
    'Orquestación {id} reanudada — un swarm retenido continúa despachando carriles.',
  'orchestration.paused-held':
    'Orquestación pausada — reteniendo carriles nuevos (los en vuelo terminan). Reanuda para continuar.',
  'orchestration.resumed': 'Orquestación reanudada — despachando carriles de nuevo.',
  'chronogram.title': 'Cronograma',
  'chronogram.wave': 'Onda',
  'chronogram.depends': 'depende',
  'chronogram.done': 'hechos',
  'chronogram.running': 'en curso',
  'chronogram.failed': 'fallidos',
  'chronogram.pending': 'pendientes',
  'chronogram.paused': 'pausada',
  'swarm.singleUnit':
    'Solo una unidad independiente: esto se ejecuta como un único agente (sin paralelismo real).',
  'swarm.confirmRun': '¿Ejecutar {count} agente(s) en paralelo?',
  'swarm.cancelled': 'Enjambre cancelado.',
  'swarm.running': 'Ejecutando… cada agente trabaja en su propio árbol de trabajo aislado.',
  'swarm.noChanges': 'No se produjeron cambios.',
  'swarm.confirmApply': '¿Aplicar los cambios fusionados a tu árbol de trabajo?',
  'swarm.leftUnapplied': 'Se dejó sin aplicar. El diff fusionado se muestra arriba.',
  'swarm.applied': 'Se aplicaron los cambios fusionados del enjambre a tu árbol de trabajo.',
  'swarm.applyFailed': 'No se pudo aplicar el diff fusionado: {error}',

  // weekly-plan
  'weekly-plan.saved': 'Guardado en {path}',

  // action-render
  'action-render.phase': 'fase',
  'action-render.declined': 'rechazado',
  'action-render.error': 'error: {message}',
  'action-render.failed': 'fallido',
  'action-render.lines': '{count} línea{plural}',
  'action-render.entriesOne': '{count} entrada',
  'action-render.entriesMany': '{count} entradas',
  'action-render.matchesOne': '{count} línea coincidente',
  'action-render.matchesMany': '{count} líneas coincidentes',
  'action-render.written': 'escrito',
  'action-render.branch': 'rama {name}',
  'action-render.done': 'hecho',
  'action-render.applied': 'aplicado',
  'action-render.filesChanged': '{count} archivo{plural} modificado{plural}',
  'action-render.moreDiffLines': '+{count} líneas de diff más',

  // context
  'context.refuseRead':
    'No se leerá "{relPath}": {reason} Las rutas bloqueadas (secretos, claves, .env) nunca se leen en los prompts del modelo.',
  'context.confirmRead': '¿Leer "{relPath}" en el prompt? ({reason})',
  'context.declinedRead': 'Se rechazó leer "{relPath}".',
  'context.fileNotFound': 'Archivo no encontrado: {relPath}',

  // interactions
  'interactions.headerNeverChanges': '{command} → {workflow} · {autonomy} · nunca cambia el código',
  'interactions.savedInteraction': 'Interacción guardada {id} → {dir}',
  'interactions.patchHeader': 'patch → {workflow} · {autonomy} · aplicar requiere confirmación',
  'interactions.diffDidNotValidate':
    'El diff propuesto no se validó con `git apply --check`: {reason}. Revísalo antes de aplicarlo.',
  'interactions.patchTitle': 'Parche {id}',
  'interactions.filesAffected': 'Archivos afectados: {files}',
  'interactions.filesAffectedNone': '(ninguno detectado)',
  'interactions.savedPatch': 'Parche guardado {id} → {dir}',

  // patches
  'patches.noLocalPatches':
    'No se encontraron parches locales. Genera uno primero: excalibur patch "<task>".',
  'patches.notAGitRepo':
    'No se puede aplicar el parche {id}: {repoRoot} no es un repositorio git. Ejecuta `git init` primero.',
  'patches.emptyDiff':
    'El parche {id} tiene un diff vacío — no hay nada que aplicar. Regenéralo con `excalibur patch "<task>"`.',
  'patches.diffDidNotValidate':
    'El parche {id} no se validó con `git apply --check` en el momento de la propuesta; la aplicación de abajo podría fallar.',
  'patches.didNotApply':
    'El parche {id} no se aplicó: {message}. Prueba `excalibur branch {id}` (lo aplica sobre una rama nueva) o regenera el parche.',

  // provider-setup
  'provider-setup.paste_api_key':
    'Pega tu API key de {label} (o déjalo en blanco para configurar {envName} tú mismo más tarde) — la entrada está oculta:',
  'provider-setup.saved_key':
    'Guardé tu key de {label} en {path} (solo tú puedes leerla). Excalibur la carga automáticamente en cada arranque — no hay variable de entorno que configurar. Ejecuta `excalibur models test` para confirmar.',
  'provider-setup.save_key_failed':
    'No pude guardar tu key en el fichero de secretos ({message}). Puedes configurar {apiKeyEnv} en tu entorno en su lugar.',
  'provider-setup.detected_env':
    'Se detectó {defaultName} en tu entorno — pulsa Enter para usarla.',
  'provider-setup.ask_env_var_name':
    'Nombre de la variable de entorno que contiene la clave de API (nunca la clave en sí) [{defaultName}]:',
  'provider-setup.looks_like_key_value':
    'Eso parece el VALOR de una clave de API. Introduce en su lugar el NOMBRE de la variable de entorno (por ejemplo OPENAI_API_KEY) — Excalibur nunca almacena valores de claves.',
  'provider-setup.env_var_format':
    'Los nombres de variables de entorno usan letras mayúsculas, dígitos y guiones bajos.',
  'provider-setup.saved_env_set':
    'Guardado. ✓ {apiKeyEnv} ya está definida en tu entorno — este proveedor está listo. Ejecuta `excalibur models test` para confirmar la conexión.',
  'provider-setup.saved_env_unset':
    'Guardado. Asigna tu clave de API a {apiKeyEnv} (Excalibur solo almacena el nombre de la variable) y luego ejecuta `excalibur models test` para confirmar. Sin una clave definida, los comandos te pedirán que configures una — no hay un respaldo simulado.',
  'provider-setup.detected_env_optional':
    'Se detectó {suggestion} en tu entorno — escríbela para enviar un token bearer, o déjala en blanco para un endpoint sin clave.',
  'provider-setup.ask_env_var_optional':
    'Variable de entorno de la clave de API (déjala en blanco si tu endpoint no necesita autenticación) [{suggestion} o en blanco]:',
  'provider-setup.looks_like_key_value_optional':
    'Eso parece el VALOR de una clave — introduce el NOMBRE de la variable de entorno (o déjalo en blanco). Se usará en blanco.',
  'provider-setup.hint_subscription_key':
    'clave de suscripción autorizada · Excalibur nativo completo',
  'provider-setup.hint_cli_prohibited':
    'usa la CLI oficial del proveedor · la reutilización de tokens por terceros está prohibida (bajo tu propia responsabilidad)',
  'provider-setup.hint_cli_own_risk':
    'usa la CLI oficial del proveedor · bajo tu propia responsabilidad',
  'provider-setup.auto_configured':
    'Configurado automáticamente {label}: {good} para programar, {fast} para sugerencias rápidas y compactación — ambos en {apiKeyEnv}. Cambia cualquiera con `excalibur models setup`.',
  'provider-setup.ask_model': 'Modelo de {label}:',
  'provider-setup.subscription_key_native':
    'Tu suscripción de {label} funciona mediante una clave de suscripción (autorizada) — Excalibur nativo completo.',
  'provider-setup.cli_passthrough':
    'Excalibur usará la CLI oficial `{command}` ({loginHint}). Ese adaptador de paso está en camino — por ahora puedes conectar una clave de API en su lugar.',
  'provider-setup.confirm_api_key_instead':
    '¿Configurar ahora una clave de API de {label} en su lugar?',
  'provider-setup.no_problem_later':
    'Sin problema — ejecuta `excalibur models setup` cuando quieras para conectar {label}.',
  'provider-setup.opt_subscription': 'Suscripción',
  'provider-setup.opt_api_key': 'Clave de API',
  'provider-setup.hint_api_key':
    'pago por token · Excalibur nativo completo (empareja automáticamente un modelo bueno + rápido)',
  'provider-setup.how_do_you_use': '¿Cómo usas {label}?',
  'provider-setup.opt_ollama': 'Ollama (local) — gratis, sin clave',
  'provider-setup.hint_ollama_detected': '¡detectado en esta máquina!',
  'provider-setup.hint_ollama_install': 'instálalo desde ollama.com y luego `ollama pull <model>`',
  'provider-setup.opt_self_hosted': 'Autoalojado / tu propio modelo',
  'provider-setup.hint_self_hosted':
    'vLLM · TGI · una pasarela interna Qwen/Llama — tu endpoint, clave opcional',
  'provider-setup.opt_mock': 'Simulado',
  'provider-setup.hint_mock': 'solo sin conexión / pruebas — NO es un modelo real',
  'provider-setup.opt_later': 'Configurar más tarde',
  'provider-setup.select_provider':
    '¿Qué proveedor de modelos? (Excalibur es gratis — usa tu suscripción o clave de API, o ejecuta un modelo local/propio)',
  'provider-setup.ask_ollama_model': 'Nombre del modelo de Ollama [llama3]:',
  'provider-setup.saved_ollama':
    'Guardado. Excalibur usará tu Ollama local en http://localhost:11434 (sin clave, sin coste). Asegúrate de que Ollama esté en ejecución y de que el modelo esté descargado (`ollama pull <model>`). El texto fantasma necesita un segundo modelo rápido, así que permanece desactivado en modo de un solo modelo.',
  'provider-setup.ask_endpoint_url': 'URL base de tu endpoint [http://localhost:8000/v1]:',
  'provider-setup.ask_endpoint_model':
    'Nombre del modelo servido por tu endpoint [Qwen/Qwen2.5-Coder-32B-Instruct]:',
  'provider-setup.saved_self_hosted_auth':
    'Guardado. Excalibur llamará a {baseUrl} con el token bearer en {apiKeyEnv}.',
  'provider-setup.saved_self_hosted_keyless':
    'Guardado. Excalibur llamará a {baseUrl} sin autenticación (endpoint autoalojado sin clave).',
  // Onboarding: detección de clave + cabeceras de grupo del selector. (El inglés
  // es el de model-catalog.ts/los literales; aquí solo van las traducciones es.)
  'provider-setup.detected_use': 'Detectada {envVar} en tu entorno — ¿configurar {label}?',
  'provider-setup.group_recommended': 'Recomendados',
  'provider-setup.group_subscription': 'Suscripción o API',
  'provider-setup.group_api': 'Solo API',
  'provider-setup.group_local': 'Local',
  'provider-setup.group_detected': 'Detectados (clave en tu entorno)',
  // Catálogo de proveedores — hints (los labels son nombres de marca, sin traducir).
  'catalog.kimi.hint': 'clave de suscripción (Kimi Code) o API · kimi-k2.7-code',
  'catalog.minimax.hint': 'suscripción (plan coding de MiniMax) o API · MiniMax-M2',
  'catalog.glm.hint': 'suscripción GLM Coding Plan o API · GLM-4.6',
  'catalog.anthropic.hint': 'suscripción Claude Pro/Max (vía Claude Code) o API · Opus + Haiku',
  'catalog.openai.hint': 'suscripción ChatGPT (vía Codex) o API · gpt-5.5 + nano',
  'catalog.gemini.hint':
    'suscripción AI Pro/Ultra (vía Gemini/Antigravity CLI), API o capa gratuita · Flash',
  'catalog.deepseek.hint': 'API · v4-pro + v4-flash',
  'catalog.openrouter.hint': 'una clave, muchos modelos · API',
  'catalog.groq.hint': 'capa gratuita · inferencia ultrarrápida · gpt-oss + Llama',
  'catalog.xai.hint': 'API · grok-4 + grok-4-fast',
  'catalog.cerebras.hint': 'capa gratuita · la inferencia más rápida (wafer-scale) · Qwen + Llama',
  'catalog.together.hint': 'API · modelos abiertos (DeepSeek, Qwen, Llama)',
  'catalog.fireworks.hint': 'API · serving rápido de modelos abiertos',
  // Catálogo — disclaimers de suscripción (cli-passthrough).
  'catalog.anthropic.disclaimer':
    'Anthropic NO permite que herramientas de terceros usen credenciales Pro/Max en tu nombre. Excalibur solo ejecuta la propia CLI de Claude Code (que guarda tu login) y nunca almacena ni reenvía tu token — tu propia automatización, bajo tu responsabilidad.',
  'catalog.openai.disclaimer':
    'Usa tu suscripción de ChatGPT vía la CLI Codex de OpenAI (que guarda tu login). El uso de la suscripción se rige por los términos de OpenAI — bajo tu responsabilidad.',
  'catalog.gemini.disclaimer':
    'Google NO permite que herramientas de terceros usen tu suscripción; Excalibur solo ejecuta la CLI oficial de Google y nunca almacena tu token — bajo tu responsabilidad.',
  // Validación de modelo en vivo.
  'models.validate-stale':
    'El modelo "{model}" ({name}) no estaba en la lista de modelos del proveedor — puede haberse renombrado o quedado obsoleto. Ejecuta `excalibur models setup` para elegir uno actual.',

  // run-pipeline
  'run-pipeline.discoveryPrompt': '¿Ejecutar Discovery primero?',
  'run-pipeline.continuingWithoutDiscovery': 'Continuando sin Discovery.',
  'run-pipeline.unknownWorkflow':
    'Flujo de trabajo desconocido "{workflow}". Ejecuta `excalibur workflows list` para ver el catálogo.',
  'run-pipeline.reason': 'Motivo: {reason}',
  'run-pipeline.estimateFiles': '{count} fichero(s)',
  'run-pipeline.estimateFromRuns': '(según {count} ejecución(es) previas)',
  'run-pipeline.estimateHeuristic': '(estimación)',
  'run-pipeline.estimateOverBudget':
    'Aviso: la estimación {cost} supera tu --budget {budget} — la ejecución parará en el tope.',
  'run-pipeline.runPromptGate': '[Enter] continuar  [m] cambiar modo  [c] cancelar',
  'run-pipeline.runCancelled': 'Ejecución cancelada.',
  'run-pipeline.executionModePrompt': 'Modo de ejecución:',
  'run-pipeline.modeFastLabel': 'Rápido',
  'run-pipeline.modeFastHint': 'correcciones pequeñas, mínima ceremonia',
  'run-pipeline.modeCarefulLabel': 'Cuidadoso',
  'run-pipeline.modeCarefulHint': 'Nivel 4, aprobaciones más estrictas',
  'run-pipeline.modeStructuredLabel': 'Estructurado',
  'run-pipeline.modeStructuredHint': 'especificar → planificar → implementar → verificar',
  'run-pipeline.modeExploreLabel': 'Explorar',
  'run-pipeline.modeExploreHint': 'comparar alternativas de ingeniería',
  'run-pipeline.modeTeamDefaultLabel': 'Predeterminado del equipo',
  'run-pipeline.runDir': 'Ejecución {id} → {dir}',
  'run-pipeline.runCompleted': 'Ejecución {id} completada.',
  'run-pipeline.runFinishedStatus': 'La ejecución {id} finalizó con estado: {status}',
  'run-pipeline.artifacts': 'Artefactos: {dir}',
  'run-pipeline.inspectWith': 'Inspecciona con: excalibur logs {id}',

  // turn-receipt
  'turn-receipt.narrative-action': 'Cambios aplicados.',
  'turn-receipt.narrative-failed': 'El turno terminó con un error.',
  'turn-receipt.narrative-partial': 'El turno se detuvo antes de terminar.',
  'turn-receipt.narrative-answer': 'Listo.',
  'turn-receipt.file': 'archivo',
  'turn-receipt.files': 'archivos',
  'turn-receipt.declined': '{count} rechazado(s)',
  'turn-receipt.just-now': 'justo ahora',
  'turn-receipt.seconds-ago': 'hace {seconds}s',
  'turn-receipt.minutes-ago': 'hace {minutes}m',
  'turn-receipt.hours-ago': 'hace {hours}h',
  'turn-receipt.hint-apply': 'revisa y luego  excalibur apply {runId}',
  'turn-receipt.hint-fix-failures': 'soluciona las verificaciones fallidas de arriba',
  'turn-receipt.hint-branch': 'los cambios están en la rama {branch}',
  'turn-receipt.hint-resolve-block': 'resuelve el bloqueo para continuar',
  'turn-receipt.and-more': '…y {extra} más · /changes',

  // agent-turn
  'agent-turn.tool_needs_approval': '  ⚠ {tool} necesita aprobación: {reason}{detail}',
  'agent-turn.allow_action':
    '  ¿Permitir esta acción?  (s = sí · n = no · a = modo Auto, deja de preguntar)',
  'agent-turn.agent_header': '→ agente · {mode} · L{level}',
  'agent-turn.mode_answer': 'responder (solo lectura)',
  'agent-turn.mode_act': 'actuar',
  'agent-turn.run_dir': 'Ejecución {id} → {dir}',
  'agent-turn.plan_header': '→ plan · planificador (solo lectura) · L{level}',
  'agent-turn.plan_heading': 'Plan',
  'agent-turn.plan_non_interactive':
    'Plan listo. Vuelve a ejecutar con aprobación para ejecutarlo (no interactivo: no se ejecuta).',
  'agent-turn.plan_gate_prompt': '[approve / edit / cancel]',
  'agent-turn.plan_edit': 'Edita la tarea y vuelve a planificar.',
  'agent-turn.plan_cancelled': 'Plan cancelado. No se cambió nada.',
  'agent-turn.plan_saved': 'Plan guardado en .excalibur/plans/{file} y registrado en memoria.',
  'agent-turn.execute_header': '→ ejecutar · implementador · L{level}',
  'agent-turn.fork_redacted':
    'La base reconstruida contiene [REDACTED] donde se ocultó un secreto al capturarlo — complétalos antes de confiar en el árbol de trabajo bifurcado.',
  'agent-turn.fork_header': '⑂ bifurcación de {runId} @ paso {step}/{total}',
  'agent-turn.fork_reused':
    'Se reutilizaron {tokens} tokens en caché ({cost}) — solo la nueva instrucción se ejecuta en vivo.',
  'agent-turn.fork_worktree': 'Árbol de trabajo {worktree} · rama {branch}',
  'agent-turn.undo_no_changes':
    'La ejecución {runId} no registró cambios de archivos — no hay nada que deshacer.',
  'agent-turn.undo_cannot_reverse':
    'No se puede deshacer: los cambios de la ejecución no se revierten limpiamente sobre tu árbol de trabajo ({reason}). El árbol cambió desde la ejecución; resuélvelo primero.',
  'agent-turn.undo_warn':
    'Esto revierte tu árbol de trabajo al estado de la ejecución {runId} en el paso {step}/{total}.',
  'agent-turn.undo_proceed': '¿Continuar?',
  'agent-turn.undo_cancelled': 'Deshacer cancelado. No se cambió nada.',
  'agent-turn.undo_reverted_full':
    '✓ Árbol de trabajo revertido — los cambios de la ejecución se deshicieron.',
  'agent-turn.undo_cannot_reapply':
    'No se pudo reconstruir el paso {step} ({reason}). Tu árbol de trabajo quedó SIN CAMBIOS.',
  'agent-turn.undo_reverted_step': '✓ Árbol de trabajo revertido al paso {step}.',

  // extensions
  'extensions.list_extensions_heading': 'Extensiones:',
  'extensions.list_contributions_heading': 'Contribuciones:',
  'extensions.validate_ok': '{count} archivo(s) validado(s) — todo se ve bien.',
  'extensions.validate_invalid': 'extensions validate encontró {count} archivo(s) no válido(s).',
  'extensions.doctor_missing_entrypoint': 'falta la declaración del punto de entrada',
  'extensions.doctor_entrypoint_not_built':
    'el punto de entrada {entrypoint} aún no está compilado — ejecuta su compilación primero',
  'extensions.doctor_issue': '{id}: {issue}',
  'extensions.doctor_loaded_cleanly': '{id} ({source}) se cargó correctamente',
  'extensions.doctor_all_healthy': 'Todas las extensiones están en buen estado.',
  'extensions.enabled': 'Extensión "{id}" habilitada en {dir}/extensions.yaml.',
  'extensions.disabled': 'Extensión "{id}" deshabilitada en {dir}/extensions.yaml.',
  'extensions.install_not_local_dir':
    '"{path}" no es un directorio local. La instalación de extensiones desde npm llegará en M8 — hasta entonces, pasa una carpeta local que contenga excalibur.extension.yaml.',
  'extensions.install_no_manifest': '{path} no tiene un manifiesto excalibur.extension.yaml.',
  'extensions.install_already_installed':
    'La extensión "{id}" ya está instalada en {target}. Elimínala primero para reinstalarla.',
  'extensions.install_confirm': '¿Instalar la extensión "{id}" ({kind}) en {dir}/extensions/?',
  'extensions.install_cancelled': 'Instalación cancelada.',
  'extensions.install_done': 'Instalado "{id}" → {target}',
  'extensions.install_validate_hint': 'Ejecuta `excalibur extensions validate` para verificarla.',
  'extensions.create_scaffolded': 'Extensión {kind} "{name}" generada → {dir}',
  'extensions.create_programmatic_hint':
    'Las extensiones programáticas cargan su punto de entrada COMPILADO: ejecuta `npm install && npm run build` dentro de la carpeta primero.',
  'extensions.create_validate_hint': 'Valida con: excalibur extensions validate',

  // init
  'init.teamFullConflict': 'Usa --team o --full, pero no ambos.',
  'init.versionInGit': '¿Versionar la configuración de Excalibur en Git?',
  'init.addedToGitignore': 'Se añadió {dir}/ a .gitignore.',

  // instructions
  'instructions.scanProjectHeading': 'Instrucciones del proyecto (usadas automáticamente):',
  'instructions.scanSkillsHeading': 'Skills detectadas (revísalas antes de habilitarlas):',
  'instructions.scanGlobalHeading':
    'Instrucciones personales/globales (solo se referencian localmente, nunca se copian):',
  'instructions.scanContextHeading': 'Documentación del proyecto (contexto):',
  'instructions.noneDetected': 'No se detectaron fuentes de instrucciones.',
  'instructions.scanManageHint':
    'Gestiónalas con: excalibur instructions list|enable|disable|import',
  'instructions.inspectPath': 'Ruta: {path}',
  'instructions.inspectFormat': 'Formato: {format} · Tipo: {kind} · Ámbito: {scope}',
  'instructions.inspectTrust': 'Confianza: {trust} · Habilitada: {enabled}',
  'instructions.inspectContentHash': 'Hash de contenido: {hash}',
  'instructions.truncated': '… (truncado)',
  'instructions.enabled': 'Fuente de instrucciones "{id}" habilitada en {dir}/config.yaml.',
  'instructions.disabled': 'Fuente de instrucciones "{id}" deshabilitada en {dir}/config.yaml.',
  'instructions.importGlobalBlocked':
    '"{id}" es una fuente personal de ámbito global de usuario ({path}). Importarla copia contexto personal al repositorio — vuelve a ejecutar con --include-global si realmente quieres hacerlo.',
  'instructions.importConfirm': '¿Copiar {path} en {dir}/instructions/?',
  'instructions.importCancelled': 'Importación cancelada.',
  'instructions.sourceMissing': 'Falta el archivo de origen en disco: {path}',
  'instructions.importRedacted':
    'Los secretos encontrados en el origen se ocultaron en la copia importada.',
  'instructions.imported': 'Importado {path} → {target}',
  'instructions.doctorMissing': 'FALTA    {path}',
  'instructions.doctorChanged': 'CAMBIÓ   {path} (el hash de contenido difiere del último escaneo)',
  'instructions.doctorOk': 'OK       {path}',
  'instructions.doctorMissingRecorded':
    'FALTA    {path} (registrado en el último escaneo, ya no se detecta)',
  'instructions.doctorAllReachable': 'Todas las fuentes de instrucciones son accesibles.',

  // repl
  'repl.resume-wrong-repo':
    'La sesión {id} pertenece a {repoRoot}, no a este repositorio. Inicia una sesión nueva aquí o reanúdala desde su propio repositorio.',
  'repl.cancelled-back-to-prompt': 'Cancelado. De vuelta al prompt.',
  'repl.ctrl-c-again': 'Pulsa Ctrl-C de nuevo para salir.',
  'repl.goal-offer':
    'Esto parece un objetivo a completar. ¿Perseguirlo a lo largo de varios turnos hasta que un evaluador diga que está hecho (máx. {max})?',
  'repl.remember-usage': 'Uso: /remember <una decisión, rechazo, riesgo o convención que recordar>',
  'repl.remember-saved':
    'Recordado ({detail}). Las próximas ejecuciones que toquen estas rutas lo tendrán presente.',
  'repl.remember-reinforced':
    'Reforzada una memoria existente ({detail}) — evidencia ×{count}. Compone: cuanto más se repite, más seguro está Excalibur.',
  'repl.remember-failed': 'No se pudo guardar la memoria: {reason}',
  'repl.compact-nothing': 'Nada que compactar todavía: el contexto reciente ya cabe.',
  'repl.compacted-manual':
    'Compactados {n} turno(s) anteriores → resumen · {before}→{after} tokens. El detalle completo permanece en el historial de ejecuciones.',
  'repl.compacted-auto':
    'Compactados automáticamente {n} turno(s) anteriores → resumen · {before}→{after} tokens. El detalle completo permanece en el historial de ejecuciones.',
  'repl.compaction-failed': 'Falló la compactación: {reason}',
  'repl.plan-usage': 'Uso: /plan <tarea>. Describe qué quieres planificar.',
  'repl.goal-done-gate': '  objetivo · puerta-de-hecho: `{test}` debe pasar',
  'repl.goal-iteration': '  objetivo · iteración {n}/{max}: {status} — {reason}',
  'repl.goal-done': 'HECHO',
  'repl.goal-continue': 'continuar',
  'repl.goal-achieved': 'Objetivo logrado en {iterations} iteración(es).',
  'repl.goal-max-iterations':
    'Detenido en el límite de {iterations} iteraciones{reason}. Afina el objetivo o ejecuta /goal de nuevo para continuar.',
  'repl.goal-cancelled': 'Bucle de objetivo cancelado tras {iterations} iteración(es).',
  'repl.goal-evaluator-unavailable':
    'Bucle de objetivo detenido (evaluador no disponible) tras {iterations} iteración(es).',
  'repl.goal-usage':
    'Uso: /goal <objetivo> — Excalibur trabaja hacia él a lo largo de varios turnos hasta que un evaluador diga que está hecho.',
  'repl.loop-usage':
    'Uso: /loop [--every <seg>] [--times <n>] <prompt> — lo reejecuta periódicamente hasta ESC.',
  'repl.swarm-usage':
    'Uso: /swarm <tarea> — reparte la tarea entre agentes reales en paralelo (subtareas independientes, carriles en vivo).',
  'repl.explore-usage':
    'Uso: /explore <tarea> — ejecuta N enfoques candidatos en paralelo y aplica el mejor (best-of-N).',
  'repl.route-bg-offer':
    'Esto parece largo — ¿lo ejecuto en segundo plano (/bg) para que sigas trabajando?',
  'repl.route-swarm-offer':
    'Esto parece paralelizable — ¿lo reparto en un swarm de agentes reales (/swarm)?',
  'repl.route-research-offer':
    'Esto parece una pregunta de investigación — ¿hago investigación web profunda con fuentes citadas?',
  // Avisos de auto-enrutado (se muestran bajo autonomía en lugar del offer de
  // arriba — la forma se elige y ejecuta sola; el usuario nunca teclea un comando).
  'repl.route-goal-auto':
    'Auto-enrutado: lo persigo como objetivo a lo largo de los turnos hasta que un evaluador diga que está hecho (máx {max}).',
  'repl.route-bg-auto':
    'Auto-enrutado: lo ejecuto en segundo plano para que puedas seguir trabajando.',
  'repl.route-swarm-auto': 'Auto-enrutado: lo reparto en un swarm de agentes en paralelo.',
  'repl.route-research-auto': 'Auto-enrutado: investigación web profunda con fuentes citadas.',
  'repl.route-explore-offer':
    'Esto parece valer la pena explorar — ¿pruebo varios enfoques candidatos en paralelo y me quedo con el mejor (best-of-N)?',
  'repl.route-explore-auto':
    'Auto-enrutado: explorando enfoques candidatos en paralelo (best-of-N).',
  'repl.route-narrate-hint': '  (alto impacto — lo ejecuto ya; pulsa Esc para parar.)',
  'repl.auto-build-parallel':
    'Auto-orquestando: {count} flujos de trabajo independientes → un swarm en paralelo.',
  'repl.auto-build-sequential':
    'Auto-orquestando: un solo flujo de trabajo → una ejecución enfocada.',
  'repl.orchestration-hint':
    'Sugerencia: pídeme «muéstrame la orquestación» o «pausala» cuando quieras — o abre su cronograma en vivo en el dashboard.',
  'repl.plan-shape-intro':
    'Dando forma al plan — elige qué trabajo relacionado incluir (espacio marca):',
  'repl.plan-shape-prompt': '¿Incluir en el plan?',
  'repl.plan-shape-nav': '↑/↓ mover · espacio marca · a/n todo/nada · enter confirma · esc omitir',
  'repl.auto-build-review': 'Revisión adversarial del resultado ({lenses} lente(s))…',
  'repl.auto-build-review-high':
    'Sobrevivió un problema de severidad alta — revisa los cambios antes de fiarte de ellos.',
  // investigación profunda (F7)
  'research.network-off':
    'La red está desactivada (permissions.network.mode = off). Actívala para investigar en la web.',
  'research.starting': 'Investigando: {question}',
  'research.stage': '• {stage} {detail}',
  'research.summary':
    'Investigadas {sources} fuente(s) · {verified}/{claims} afirmaciones verificadas.',
  'research.ledger-blocked':
    '⚠ Algunas afirmaciones NO estaban respaldadas por las fuentes citadas (research.ledger activo).',
  'repl.bg-usage':
    'Uso: /bg <tarea> — ejecuta la tarea en segundo plano (su propia ejecución registrada) mientras sigues trabajando.',
  'repl.bg-started': '▸ segundo plano: {title} — en curso (usa /threads para verlo)',
  'repl.bg-done': '✓ segundo plano hecho: {title}',
  'repl.bg-failed': '✗ segundo plano falló: {title} — {error}',
  'repl.bg-active': '{n} en 2º plano',
  'repl.threads-none': 'No hay hilos en segundo plano en esta sesión. Inicia uno con /bg <tarea>.',
  'repl.threads-header':
    'Hilos en segundo plano — {running} en curso · {done} hechos · {failed} fallidos',
  'repl.help-swarm':
    '  /swarm <tarea>  reparte entre agentes reales en paralelo (subtareas independientes, carriles en vivo)',
  'repl.help-bg': '  /bg <tarea>    ejecuta una tarea en segundo plano mientras sigues trabajando',
  'repl.help-threads': '  /threads       lista los hilos en segundo plano (en curso + terminados)',
  'repl.loop-start':
    'En bucle cada {every}s, hasta {times}× — pulsa ESC para detener. (recurrencia, no finalización)',
  'repl.loop-iteration': '  bucle · iteración {iteration}/{times}',
  'repl.loop-completed': 'Bucle completado en {iterations} iteración(es).',
  'repl.loop-cancelled': 'Bucle cancelado tras {iterations} iteración(es).',
  'repl.shell-empty': 'Comando de shell vacío.',
  'repl.shell-failed': 'El comando falló (salida {code}).',
  'repl.help-title': 'Sesión interactiva de Excalibur — comandos',
  'repl.help-help': '  /help          muestra esta ayuda',
  'repl.help-plan': '  /plan <tarea>  planifica primero (solo lectura) → aprueba → ejecuta',
  'repl.help-goal':
    '  /goal <objetivo>  trabaja hacia él a lo largo de turnos hasta que un evaluador diga hecho',
  'repl.help-loop': '  /loop [--every s] [--times n] <prompt>  reejecuta periódicamente hasta ESC',
  'repl.help-discovery': '  /discovery <idea>  aclara una idea ambigua antes de construir',
  'repl.help-rewind':
    '  /rewind [id]   rebobina una ejecución paso a paso (máquina del tiempo; por defecto la última) · Esc-Esc',
  'repl.help-changes':
    '  /changes [id]  muestra la lista completa de archivos cambiados de una ejecución (por defecto la última)',
  'repl.help-fork':
    '  /fork <instr>  bifurca la última ejecución (reusa su contexto en caché) y ejecuta <instr> en vivo',
  'repl.help-undo':
    '  /undo          revierte el árbol de trabajo deshaciendo la última ejecución (con aprobación)',
  'repl.help-compact':
    '  /compact       condensa los turnos antiguos en un resumen (libera contexto)',
  'repl.help-remember':
    '  /remember <x>  guarda una decisión/riesgo/convención; las próximas ejecuciones que toquen esas rutas la tienen presente',
  'repl.help-model': '  /model         muestra el proveedor/modelo activo',
  'repl.help-clear': '  /clear         limpia la pantalla (mantiene la sesión)',
  'repl.help-exit': '  /exit, /quit   cierra la sesión y sal',
  'repl.help-freeform-1':
    'Escribe cualquier otra cosa en lenguaje natural (cualquier idioma) — el modelo decide',
  'repl.help-freeform-2':
    'si responder (solo lectura) o editar/ejecutar, según tu nivel de autonomía.',
  'repl.help-freeform-3':
    'Las acciones de herramientas piden aprobación en línea. `!cmd` ejecuta un comando de shell.',
  'repl.model-provider': 'Proveedor: {provider}',
  'repl.model-config': 'Config: {path}',
  'repl.model-mock':
    'Usando el proveedor mock integrado (sin providers.yaml — el valor por defecto sin configuración).',
  'repl.unknown-command': 'Comando desconocido: /{name}. Prueba /help.',
  'repl.discovery-usage': 'Uso: /discovery <idea>. Describe la idea a aclarar antes de construir.',
  'repl.changes-heading': 'Cambios · {runId}',
  'repl.changes-none': '  No se registraron cambios de archivos para esta ejecución.',
  'repl.changes-metrics-one': '  {files} archivo · +{insertions} −{deletions}',
  'repl.changes-metrics-many': '  {files} archivos · +{insertions} −{deletions}',
  'repl.changes-footer': '  Diff completo: excalibur changes --diff   ·   rebobinar: /rewind',
  'repl.fork-usage':
    'Uso: /fork <instrucción> — continúa la última ejecución con una nueva instrucción (reusando su contexto en caché).',
  'repl.resuming': 'Reanudando la sesión {id} ({turns} turnos de mensaje).',
  'repl.closed': 'Sesión {id} cerrada (ahora mismo · {timestamp}).',
  'repl.goodbye': 'Hasta luego.',
  'repl.welcome-tip-diff':
    'Tienes cambios sin confirmar — prueba “revisa el diff del árbol de trabajo”.',
  'repl.welcome-tip-default':
    'Describe lo que quieres en lenguaje natural — el modelo decide cómo actuar (preguntar, editar, ejecutar).',
  'repl.welcome-whats-new':
    'Bucle de agente con el modelo primero en la shell, aprobaciones en línea, modo plan.',

  // replay-scrubber
  'replay-scrubber.noLocalRuns':
    'Aún no hay ejecuciones locales. Inicia una con: excalibur run "<tarea>"',
  'replay-scrubber.header': '⏮  Rebobinar {id} — {title}',
  'replay-scrubber.headerMeta': '{workflow} · L{level} · {status} · {count} pasos · total {cost}',
  'replay-scrubber.phaseNamed': 'fase {name}',
  'replay-scrubber.noPhase': 'sin fase',
  'replay-scrubber.stepPosition': 'paso {current}/{total}',
  'replay-scrubber.noEvents': 'No se registraron eventos para esta ejecución.',
  'replay-scrubber.totalCost': 'Coste total: {cost}',
  'replay-scrubber.costSoFar': '  coste hasta ahora: {cost}',
  'replay-scrubber.recent': '  recientes:',
  'replay-scrubber.diffHeader': '--- diff acumulado en el cursor ---',
  'replay-scrubber.noDiffAtPoint': '(no se puede reconstruir ningún diff en este punto)',
  'replay-scrubber.controlsLead':
    'controles: n/p paso · ⏎ siguiente fase · e edición · t test · c comando · x fallo · a aprobación · g <n> ir a · 0/$ primero/último · d diff · ? explicar · pin <nota> · ',
  'replay-scrubber.controlFork': 'f bifurcar',
  'replay-scrubber.controlUndo': 'u deshacer',
  'replay-scrubber.controlsTail': ' · q salir',
  'replay-scrubber.forkPrompt': 'instrucción de la bifurcación › ',
  'replay-scrubber.forkCancelled': 'Bifurcación cancelada — no se indicó ninguna instrucción.',
  'replay-scrubber.forkCreated': 'Bifurcación {id} creada — reprodúcela: excalibur replay {id}',
  'replay-scrubber.whyStep': '¿Por qué el paso {step}? {summary}',
  'replay-scrubber.noDiffInRun':
    '(no se puede reconstruir ningún diff en este punto de la ejecución)',
  'replay-scrubber.noFurtherKind': 'No hay más pasos de tipo {kind} después de aquí.',
  'replay-scrubber.noFurtherPhase': 'No hay más límites de fase después de aquí.',
  'replay-scrubber.noEventsNothing':
    'No se registraron eventos para esta ejecución — nada que reproducir.',
  'replay-scrubber.replayPrompt': 'replay › ',
  'replay-scrubber.gotoUsage': 'Uso: g <n> (1..{max}).',
  'replay-scrubber.pinUsage': 'Uso: pin <nota> — anota el paso actual.',
  'replay-scrubber.pinned': 'Nota fijada en el paso {step}.',
  'replay-scrubber.unknownControl':
    "Control desconocido: {command}. Escribe 'h' para ver los controles, 'q' para salir.",

  // context (deps-threaded)
  'context.noProvider':
    'No hay ningún proveedor de LLM configurado — Excalibur necesita un modelo real. Ejecuta `excalibur models setup` para conectar uno (OpenAI, Anthropic, Groq, Ollama, …). (El proveedor mock solo existe para uso offline/tests, mediante un `type: mock` explícito en providers.yaml.)',
  'context.safetyLine': 'Seguridad: {preset} — {description}',
  'context.safetyOk': 'No se modificará ningún archivo sin aprobación.',
  'context.safetyUnknown': 'Preset desconocido — usando las reglas de {preset} por defecto.',
  'context.providerUnusable':
    'El proveedor "{provider}" no es utilizable: {error}. Ejecuta `excalibur models setup` para configurar un proveedor de LLM que funcione.',

  // wave5 deps-threaded (event stream, gate, gerunds)
  'run-pipeline.gate': '[Enter] ejecutar · [m] modo · [c] cancelar',
  'agent-turn.gerund-planner': 'Planificando…',
  'agent-turn.gerund-architect': 'Diseñando…',
  'agent-turn.gerund-reviewer': 'Revisando…',
  'agent-turn.gerund-tester': 'Escribiendo tests…',
  'agent-turn.gerund-default': 'Trabajando…',
  // Variantes con sabor artúrico (opt-in vía ui.flavor: arthurian).
  'agent-turn.gerund-planner-arthurian': 'Consultando a los sabios…',
  'agent-turn.gerund-architect-arthurian': 'Trazando los planes de batalla…',
  'agent-turn.gerund-reviewer-arthurian': 'Juicio por combate…',
  'agent-turn.gerund-tester-arthurian': 'Probando el filo…',
  'agent-turn.gerund-default-arthurian': 'En la forja…',
  'event.run-started': '▶ ejecución iniciada',
  'event.workflow': '  workflow: {workflow}',
  'event.methodology': '  metodología: {methodology}',
  'event.phase-started': '▶ {name}',
  'event.phase-completed': '✓ {name} completada',
  'event.assistant-message': '  mensaje del asistente',
  'event.model-call': '  llamada al modelo ({model})',
  'event.tool-call': '  herramienta: {tool}',
  'event.file-read': '  leído {path}',
  'event.file-write': '  escrito {path}{sim}',
  'event.command-started': '  $ {command}{sim}',
  'event.exit-ok': '  ⎿ salida 0{sim}',
  'event.exit-fail': '  ⎿ salida {exit}{sim}',
  'event.test-result': '  tests: {status}{sim}',
  'event.patch-generated': '  ± parche generado',
  'event.patch-applied': '  ± parche aplicado{sim}',
  'event.branch-created': '  rama: {branch}',
  'event.approval-requested': '  aprobación solicitada',
  'event.approval-approved': '  aprobación concedida',
  'event.approval-rejected': '  aprobación rechazada',
  'event.artifact-created': '  artefacto: {name}',
  'event.error': '  error: {message}',
  'event.verification-passed': '  ⚖ verificación: {summary}',
  'event.verification-blocked': '  ⚖ verificación BLOQUEADA: {summary}',
  'event.claim': '  ⊨ afirmación: {statement} — {status}',
  'event.policy-decision': '  ⛨ política: {decision}{message}',
  'event.task-update': '  ☑ tareas: {done}/{total}',
  'event.compaction': '  ⊟ contexto compactado: {before}→{after} tokens',
  'event.diagnostics': '  ⚠ diagnósticos {file}: {errors} error(es), {warnings} aviso(s)',
  'event.run-completed': '■ ejecución completada ({status})',
  'event.unknown': '  {type}',
  'event.simulated': ' (simulado)',

  // rail (tui labels, i18n)
  'rail.push': 'push',
  'rail.noPush': 'sin push',
  'rail.swarm': 'Swarm',
  'rail.lanes': 'carriles',
  'rail.merge': 'fusión',
  'rail.applied': 'aplicados',
  'rail.conflict': 'conflicto',
  'rail.tasks': 'Tareas',

  // auto-accept (approval UX)
  'agent-turn.auto_enabled':
    'Modo Auto ACTIVADO — Excalibur editará y ejecutará sin preguntar (guardado). Cámbialo con /auto.',
  'repl.context-last': '↳ Lo último: {what}',
  'repl.context-plan': '↳ Plan activo: {task}',
  'repl.context-memory': '↳ Recordando {count} decisión(es) sobre este repo.',
  'repl.resume-offer': '¿Retomar tu última sesión ({turns} turno(s))?',
  'repl.auto-setup-prompt':
    '¿Permitir que Excalibur edite ficheros y ejecute comandos automáticamente (sin pedir aprobación)?',
  'repl.auto-enabled':
    'Auto-aceptar ACTIVADO — Excalibur editará y ejecutará sin preguntar (guardado). Cámbialo con /auto.',
  'repl.auto-disabled':
    "Auto-aceptar DESACTIVADO — Excalibur pregunta antes de editar (responde 'a' = modo Auto para dejar de preguntar, o /auto).",
  'repl.auto-on': 'Auto-aceptar ACTIVADO — editando sin preguntar (guardado).',
  'repl.auto-off': 'Auto-aceptar DESACTIVADO — preguntará antes de editar (guardado).',
};
