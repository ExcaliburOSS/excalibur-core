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

  // Zero-config onboarding — the first `excalibur` run in an unconfigured repo.
  'onboarding.title': 'Setting up Excalibur for this project…',
  'onboarding.intro':
    "First time here — let's connect a model and create a minimal .excalibur/. Takes a few seconds.",
  'onboarding.confirm': 'Set up Excalibur for this project now?',
  'onboarding.skipped':
    'No problem — running on the offline mock for now. Run `excalibur models setup` anytime.',
  'onboarding.created': 'Created:',
  'onboarding.noProvider':
    'No model configured — running on the built-in offline mock. Run `excalibur models setup` to connect a real model.',

  // Companion web dashboard auto-started with the interactive shell.
  'dashboard.up': '▸ Web dashboard at {url}',

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

  // branch
  'branch.not-a-repo':
    'Cannot create branch {branchName}: {repoRoot} is not a git repository. Run `git init` first.',
  'branch.empty-diff':
    'Patch {patchId} has an empty diff — nothing to apply onto a branch. Regenerate it with `excalibur patch "<task>"`.',
  'branch.confirm': 'Create git branch {branchName} and apply the patch onto it?',
  'branch.cancelled': 'Branch creation cancelled.',
  'branch.applied-failed':
    'Created branch {branchName}, but the patch did not apply: {reason}. You are on {branchName}; resolve it manually or regenerate the patch.',
  'branch.no-files-detected': 'no files detected',
  'branch.applied-success': 'Created branch {branchName} and applied the patch ({files}).',

  // login
  'login.experimental-note':
    'Experimental: the Excalibur Enterprise control plane is not public yet. Everything keeps working locally without an account.',
  'login.not-connected-sync':
    'Not connected. Run `excalibur login` first (or set {baseUrlEnv} and {apiKeyEnv}).',
  'login.no-local-runs': 'No local runs to sync yet. Create one with: excalibur run "<task>"',
  'login.synced': 'Synced run {runId} to {baseUrl}.',
  'login.ask-base-url': 'Enterprise base URL (e.g. https://excalibur.your-company.com):',
  'login.base-url-required':
    'An Enterprise base URL is required. Pass --base-url <url> or answer the prompt.',
  'login.ask-api-key': 'API key (stored locally with file mode 0600):',
  'login.api-key-required': 'An API key is required. Pass --api-key <key> or answer the prompt.',
  'login.credentials-saved': 'Credentials saved to {filePath} (mode 0600).',
  'login.env-precedence':
    'Environment variables {baseUrlEnv} / {apiKeyEnv} take precedence when set.',
  'login.not-connected-status':
    'Not connected. Run `excalibur login`, or set {baseUrlEnv} and {apiKeyEnv}.',
  'login.connected': 'Connected to {baseUrl}.',
  'login.credentials-file': 'Credentials file: {path}',

  // methodologies
  'methodologies.unknown': 'Unknown methodology "{id}". Available: {known}',
  'methodologies.heading': '{name} ({id})',
  'methodologies.use-when': 'Use when:',
  'methodologies.avoid-when': 'Avoid when:',
  'methodologies.default-workflow': 'Default workflow: {workflow}',
  'methodologies.phases': 'Phases: {phases}',
  'methodologies.risk-profile': 'Risk profile: {risk}',

  // models
  'models.test-mock':
    'Provider "{provider}" is the offline mock — nothing to reach over the network. Configure a real provider with `excalibur models setup` to test a live connection.',
  'models.test-sending': 'Testing provider "{provider}"{modelLabel} — sending a tiny request…',
  'models.test-connected':
    'Connected — {provider}{modelLabel} responded in {seconds}s · {tokens}{cost}.',
  'models.test-reply': 'Reply: "{reply}"',
  'models.test-failed':
    'Could not reach provider "{provider}"{modelLabel}: {message} Check the API key env var is exported and the base URL/model are correct (`excalibur models list`).',
  'models.list-none':
    'No LLM provider configured. Run `excalibur models setup` — the free default is local Ollama; Kimi K2 (Moonshot) is the recommended paid option (bring your own key).',
  'models.status-built-in': 'ready (built-in)',
  'models.status-ready-set': 'ready · set {apiKeyEnv}',
  'models.status-ready': 'ready',
  'models.setup-skipped':
    'Provider setup skipped. Excalibur needs an LLM — run `excalibur models setup` anytime (free: local Ollama · recommended: Kimi K2 via Moonshot, BYOK).',
  'models.setup-wrote': 'Wrote {filePath}',
  'models.setup-keys-note':
    'API keys are read from environment variables at call time — never stored.',
  'models.setup-test-confirm': 'Test the connection now? (sends a tiny request)',

  // skills
  'skills.none-detected':
    'No skills detected (looked for **/SKILL.md in the repo and ~/.claude/skills).',
  'skills.list-footer': 'Skills are never auto-executed; enable them explicitly per repository.',
  'skills.inspect-heading': '{id} — {name}',
  'skills.inspect-description': 'Description: {description}',
  'skills.inspect-path': 'Path: {path} · Scope: {scope}',
  'skills.inspect-trust': 'Trust: {trust} · Enabled: {enabled}',
  'skills.inspect-triggers': 'Triggers: {triggers}',
  'skills.inspect-dependencies': 'Dependencies: {dependencies}',
  'skills.inspect-tools': 'Tools required: {tools}',
  'skills.enable-needs-accept-risk':
    'Skill "{id}" is {trustLevel}. Review {path} first, then re-run with --accept-risk. The --yes flag alone never enables unreviewed skills.',
  'skills.enable-risk-accepted':
    'Enabling {trustLevel} skill "{name}" — you accepted the risk explicitly (--accept-risk).',
  'skills.enabled': 'Skill "{id}" enabled in {dir}/config.yaml.',
  'skills.enabled-footer': 'Skills are never auto-executed — they only join the effective context.',
  'skills.disabled': 'Skill "{id}" disabled in {dir}/config.yaml.',

  // status
  'ask.schema-invalid': "The model's answer did not fully conform to the schema: {errors}",
  'mcp.none':
    'No MCP servers configured. Add them under `mcp.servers` in .excalibur/config.yaml (a local `command` or a remote `url`).',
  'mcp.col-name': 'NAME',
  'mcp.col-transport': 'TRANSPORT',
  'mcp.col-target': 'TARGET',
  'mcp.col-trust': 'TRUST',
  'mcp.probe-hint': "Run `excalibur mcp list --probe` to connect and list each server's tools.",
  // web search (F3)
  'search.usage':
    'Usage: excalibur search <query>. Manage the local engine with `search serve`, or pick a backend with `search provider`.',
  'search.results-heading': 'Results for "{query}" (via {provider})',
  'search.no-results': 'No results for "{query}" (via {provider}).',
  'search.error': 'Search failed: {message}',
  'search.network-off':
    'Network is disabled (permissions.network.mode = off). Enable it to search the web.',
  'search.serve-consent':
    'Start a local SearXNG container via Docker for unlimited, private search?',
  'search.serve-starting': 'Starting a local SearXNG via Docker (the first run pulls the image)…',
  'search.serve-up': '✓ SearXNG is up at {url} — Excalibur will use it automatically.',
  'search.serve-cancelled':
    'Cancelled — no container was started. Search still works via DuckDuckGo.',
  'search.serve-stopped': '✓ Local SearXNG stopped and removed.',
  'search.serve-not-running': 'No local SearXNG container to stop.',
  'search.serve-no-docker':
    'Docker is not available — search falls back to keyless DuckDuckGo (still free, no setup).',
  'search.serve-status': 'Local SearXNG: {state} (reachable: {reachable})',
  'search.reachable-yes': 'yes',
  'search.reachable-no': 'no',
  'search.provider-current':
    'Search backend: {name}. Set another with `excalibur search provider <name>`.',
  'search.provider-set': 'Search backend set to {name}.',
  'search.provider-unknown': 'Unknown backend "{name}". Choose one of: {names}.',
  'search.provider-byok-hint':
    'This backend is paid (BYOK): set `search.apiKeyEnv` to the NAME of the env var holding your API key.',
  // local browser (F4)
  'browser.node-missing':
    'Node/npx is not available, so the local browser cannot be installed. Tier-1 fetch still works (free).',
  'browser.install-consent':
    'Install Chromium (via Playwright, ~150MB) so Excalibur can render JS-heavy pages?',
  'browser.installing': 'Installing Chromium via Playwright (one-time download)…',
  'browser.cancelled': 'Cancelled — Chromium was not installed. Tier-1 fetch still works (free).',
  'browser.enabled':
    '✓ Local browser enabled — web_fetch will escalate to a real render when needed.',
  'browser.disabled': '✓ Local browser disabled — fetch uses the fast Tier-1 path only.',
  'browser.status': 'Local browser: {state} (escalation: {enabled})',
  'browser.on': 'on',
  'browser.off': 'off',
  'browser.removed': '✓ Chromium uninstalled and browser escalation disabled.',
  'browser.remove-none': 'No Chromium to remove; browser escalation disabled.',
  // web fetch + hosted readers (F5)
  'web.usage':
    'Usage: excalibur web <url>. Configure an optional hosted reader with `web reader <firecrawl|jina|browserbase>`.',
  'web.reader-none':
    'No hosted reader configured — web_fetch uses the free local tiers (Tier-1 + the opt-in browser).',
  'web.reader-current': 'Hosted reader: {name} (key env: {env}).',
  'web.reader-set': 'Hosted reader set to {name}.',
  'web.reader-unknown': 'Unknown hosted reader "{name}". Choose one of: {names}.',
  'web.reader-byok-hint':
    'This reader is paid (BYOK): set `scrape.apiKeyEnv` to the NAME of the env var holding your API key.',
  'web.reader-jina-hint':
    'Jina works key-less (best-effort); set `scrape.apiKeyEnv` for higher limits.',
  'web.error': 'web fetch failed: {message}',
  'web.scan-denied': 'That URL is blocked by the network policy / SSRF protection.',
  'web.scan-result': 'Injection scan: {verdict} (score {score}, sha256 {hash}).',
  'web.scan-signals': 'Signals: {signals}',
  'insights.no-runs':
    'No local runs yet — nothing to summarise. Start one with: excalibur run "<task>"',
  'insights.title': 'Insights — {runs} runs',
  'insights.status': 'status   ',
  'insights.completion': 'completed',
  'insights.blocked': 'blocked by verification',
  'insights.spend': 'spend    ',
  'insights.avg': '(avg {cost}/run)',
  'insights.tokens': 'tokens   ',
  'insights.calls': 'model calls',
  'insights.activity': 'activity ',
  'insights.files': 'files changed',
  'insights.approvals': 'approvals',
  'insights.by-model': 'By model',
  'insights.by-workflow': 'By workflow',
  'insights.trend': 'Runs per day',
  'insights.col-name': 'NAME',
  'insights.col-runs': 'RUNS',
  'insights.col-cost': 'COST',
  'insights.col-tokens': 'TOKENS',
  'insights.since-invalid': 'Ignoring --since "{window}": use a window like 7d or 24h.',
  'serve.listening': 'Excalibur server listening on {base} (read-only).',
  'serve.token': '  token: {token}',
  'serve.example': '  try: curl {base}/api/runs?token={token}',
  'serve.stop': '  Ctrl-C to stop.',
  'serve.port-in-use': 'Port {port} is already in use — pass --port <n>.',
  'work-items.none': 'No issues found.',
  'work-items.comments': '{count} comment(s):',
  'work-items.comment-empty':
    'Provide a comment body: excalibur work-items comment <number> <text>',
  'work-items.commented': 'Commented on issue #{number}.',
  'work-items.running': 'Running issue {key} as a task: {title}',
  'work-items.create-empty': 'A work item needs a title.',
  'work-items.created': 'Created local work item {key}.',
  'work-items.status-updated': 'Set {key} → {status}.',
  'diagnostics.noTypecheck': 'No typecheck command configured — skipping post-run diagnostics.',
  'diagnostics.cleanAfter': 'Diagnostics: typecheck is clean after the run.',
  'diagnostics.repairing':
    'Diagnostics: {count} real compiler error(s) remain — running one repair pass…',
  'diagnostics.repaired': 'Diagnostics: the repair pass cleared the compiler errors. ✓',
  'diagnostics.stillErrors':
    'Diagnostics: {count} compiler error(s) still remain after the repair pass.',
  'diagnostics.skipBudget':
    'Diagnostics: skipping the repair pass — the run hit its budget cap (a repair would spend the budget again).',
  'status.no-discovery-sessions':
    'No local discovery sessions. Start one with: excalibur discovery "<idea>"',
  'status.no-runs': 'No local runs yet. Start one with: excalibur run "<task>"',
  'status.rewind-hint': 'Rewind any run like a video: excalibur rewind <id>',
  'status.counts': 'Patches: {patches} · Interactions: {interactions} · Runs: {runs}',
  'status.next-steps-heading': 'Useful next steps:',
  'status.next-step-team': '  - Share team standards: excalibur init --team',
  'status.next-step-instructions': '  - Add custom instructions under .excalibur/instructions/',
  'status.next-step-paths':
    '  - Tighten rules for sensitive paths in .excalibur/config.yaml (autonomy.paths)',
  'status.next-step-github': '  - Connect GitHub Issues and work items (arrives in M4)',

  // update
  'update.checking': 'Checking for updates… (installed {current})',
  'update.check-failed':
    'Could not check for updates{errSuffix}. You can upgrade anytime with: {cmd}',
  'update.up-to-date':
    "You're up to date — @excalibur-oss/excalibur {current} is the latest release.",
  'update.ahead':
    'Installed @excalibur-oss/excalibur {current} is newer than the latest published release ({latest}). Nothing to update.',
  'update.available': 'Update available: {current} → {latest}',
  'update.upgrade-with': 'Upgrade with: {cmd}',
  'update.confirm-run': 'Run "{cmd}" now?',
  'update.running': 'Running: {cmd}',
  'update.upgraded':
    'Upgraded to @excalibur-oss/excalibur@latest ({latest}). Restart your shell to use it.',
  'update.upgrade-failed': 'Upgrade command failed: {message}. Run it manually: {cmd}',

  // workflows
  'workflows.explain-hint': 'Explain one with: excalibur workflows explain <id>',
  'workflows.unknown': 'Unknown workflow "{id}". Available: {known}',
  'workflows.title': '{name} ({id})',
  'workflows.mode': 'Mode: {mode}',
  'workflows.levels': 'Supported autonomy levels: {levels}',
  'workflows.phases-heading': 'Phases:',
  'workflows.phase-role': 'role: {role}',
  'workflows.phase-optional': '(optional)',
  'workflows.phase-approval': 'approval: {approval}',
  'workflows.phase-confirmation': 'requires confirmation',
  'workflows.artifacts': 'Artifacts: {artifacts}',

  // apply
  'apply.confirm': 'Apply patch {id} to your working tree?',
  'apply.cancelled': 'Apply cancelled.',
  'apply.applied': 'Applied patch {id} to your working tree ({files}).',
  'apply.no-files': 'no files detected',

  // changes
  'theme.heading': 'TUI themes (→ = current):',
  'theme.usage': 'Set one with `excalibur theme <name>` (saved to .excalibur/config.yaml).',
  'theme.unknown': 'Unknown theme "{name}". Choose one of: {names}.',
  'theme.set': 'Theme set to {name} (saved). Restart the shell to see it everywhere.',
  'verify.no-changes': 'Run {runId} changed nothing to verify.',
  'verify.plan': 'Verification mesh — {reason}.',
  'verify.running': 'Running isolated adversarial verifiers: {lenses}…',
  'plans.none':
    "No saved plans yet. Approve a plan in plan mode and it's saved to .excalibur/plans/.",
  'plans.heading': 'Saved plans ({count}) · newest first:',
  'plans.footer': 'Each plan is portable markdown — re-run or fork it from its run.',
  'session-log.empty': 'No runs in this session yet.',
  'session-log.heading': 'Session log · {runs} runs · {cost} total',
  'session-log.untitled': '(untitled)',
  'session-log.footer': 'Type a run number to open its time-machine · q to exit',
  'session-log.prompt': '  log> ',
  'session-log.invalid': 'Enter a number between 1 and {max}, or q.',
  'changes.heading': 'Changes · {runId}',
  'changes.noFileChanges': '  No file changes recorded for this run.',
  'changes.diffstat': '  {files} file{plural} · +{insertions} −{deletions}',
  'changes.noUnifiedDiff': '  (no unified diff recorded for this run)',

  // cmux
  'cmux.stub':
    'Honest stub: the CMUX integration activates in milestone OSS-10 — multi-pane sessions (planner / implementer / reviewer / tests / logs) with artifacts kept in .excalibur/runs/.',
  'cmux.detected': 'CMUX detected on this machine — you are ready for OSS-10.',
  'cmux.not-installed': 'CMUX is not installed. It is optional: every workflow works without it.',
  'cmux.fallback':
    'Until then: excalibur run "<task>" executes the same workflows in one terminal.',

  // discovery
  'discovery.sessionCreated': 'Discovery session {id} ({inputType}) → {dir}',
  'discovery.answerPrompt': 'Answer the questions below — press Enter to skip any of them.',
  'discovery.doNotBuild':
    'Recommendation: do not build. The evidence collected does not justify this work — see recommendation.md for the reasons. Nothing further is suggested.',
  'discovery.suggestedNextSteps': 'Suggested next steps:',
  'discovery.artifacts': 'Artifacts: {dir}',
  'discovery.workItemSourcesM4':
    'Work-item Discovery sources (Linear, Jira, GitHub Issues) become available in M4. Until then, paste the ticket text: excalibur discovery "<text>" --type work_item',
  'discovery.invalidType': '--type must be one of: {types} (got "{got}").',
  'discovery.fileNotFound': 'File not found: {path}',
  'discovery.provideIdea':
    'Provide an idea to clarify: excalibur discovery "Add contract renewal reminders"',

  // doctor
  'doctor.check.nodeVersion': 'node version',
  'doctor.detail.nodeTooOld': ' — Excalibur requires Node ≥ 22',
  'doctor.check.gitAvailable': 'git available',
  'doctor.detail.gitNotFound': 'git not found on PATH',
  'doctor.check.gitRepository': 'git repository',
  'doctor.detail.gitBranch': 'branch: {branch}',
  'doctor.detail.gitNotRepo': 'not a git repository — diffs and branches unavailable',
  'doctor.detail.excaliburNotInit': 'not initialized — run `excalibur init` (defaults still work)',
  'doctor.detail.configValid': 'valid',
  'doctor.detail.configMissing': 'missing — defaults active',
  'doctor.check.safetyPreset': 'safety preset',
  'doctor.detail.presetActive': '{presetId} active',
  'doctor.detail.presetUnknown': 'unknown preset "{presetId}" — falling back to {fallback}',
  'doctor.check.instructionSources': 'instruction sources',
  'doctor.detail.sourcesReachable': '{count} configured, all reachable',
  'doctor.detail.sourcesMissing': 'missing: {paths}',
  'doctor.check.modelProviders': 'model providers',
  'doctor.detail.providersMissing':
    'no providers.yaml — using the built-in mock (run `excalibur models setup`)',
  'doctor.detail.providersValid': 'providers.yaml valid',
  'doctor.check.apiKeyEnv': 'api key env ({name})',
  'doctor.detail.keyEnvSet': '{keyEnv} is set',
  'doctor.detail.keyEnvUnset': '{keyEnv} is not set',
  'doctor.check.detectedCommands': 'detected commands',
  'doctor.detail.commandsNone': 'none detected — agents cannot verify changes',
  'doctor.check.workflowCatalog': 'workflow catalog',
  'doctor.detail.workflowCounts': '{workflows} workflows, {methodologies} methodologies',
  'doctor.check.extensions': 'extensions',
  'doctor.detail.extensionsLoaded': '{count} loaded',
  'doctor.detail.loadError': 'load error',
  'doctor.check.extensionWarnings': 'extension warnings',
  'doctor.check.enterpriseCredentials': 'enterprise credentials',
  'doctor.detail.credentialsConnected': 'connected to {baseUrl}',
  'doctor.detail.credentialsNone': 'not configured (optional)',
  'doctor.error.failed': 'doctor found {count} failing check(s).',

  // fork
  'fork.noSteps': 'Run "{runId}" has no recorded steps.',
  'fork.atNotWhole': '--at must be a whole step number between 1 and {total} (got "{at}").',
  'fork.atOutOfRange': '--at must be a step between 1 and {total} (got "{at}").',
  'fork.created':
    'Fork {forkRunId} created. Inspect it in its worktree, or replay it: excalibur replay {forkRunId}',

  // logs
  'logs.noRuns': 'No local runs yet. Start one with: excalibur run "<task>"',
  'logs.heading': '{id} — {title} ({status})',
  'logs.noEvents': 'No events recorded.',

  // patch
  'patch.taskEmpty': 'The task must not be empty.',
  'patch.applyConfirm': 'Apply patch to your working tree?',
  'patch.applied': 'Applied patch {id} to your working tree ({files}).',
  'patch.noFilesDetected': 'no files detected',
  'patch.next': 'Next: excalibur apply {id} · excalibur branch {id} · excalibur reject {id}',

  // pr
  'pr.noRuns': 'No local runs yet. Start one with: excalibur run "<task>"',
  'pr.saved': 'Saved to {path}',
  'pr.ghRequired':
    'pr-create needs the GitHub CLI. Install it from https://cli.github.com and run `gh auth login`.',
  'pr.creating': 'Opening a pull request: {title}',
  'pr.confirmCreate': 'Create this pull request now?',
  'pr.cancelled': 'Cancelled — no pull request was opened.',
  'pr.defaultBody': 'Opened by Excalibur.',
  'pr.created': 'Pull request opened: {url}',
  'pr.createFailed': 'gh could not open the pull request: {reason}',

  // replay
  'replay.at-must-be-positive': '--at must be a positive step number (got "{at}").',

  // review
  'review.cleanTree': 'Working tree is clean — nothing to review.',
  'review.noTypecheck': 'No typecheck command configured — skipping diagnostics.',
  'review.runningDiagnostics': 'Running diagnostics: {typecheck}…',
  'review.typecheckErrors': 'Typecheck reported {count} error(s) — anchoring the review on them.',
  'review.typecheckClean': 'Typecheck is clean.',

  // run
  'run.task_empty': 'The task must not be empty.',

  // swarm
  'swarm.taskEmpty': 'The task must not be empty.',
  'swarm.needsGitRepo': 'Swarm needs a git repository — each agent runs in an isolated worktree.',
  'swarm.decomposing': 'Decomposing the task into independent subtasks…',
  'swarm.heading': 'Swarm: {reason}',
  'swarm.singleUnit': 'Only one independent unit — this runs as a single agent (no real fan-out).',
  'swarm.confirmRun': 'Run {count} agent(s) in parallel?',
  'swarm.cancelled': 'Swarm cancelled.',
  'swarm.running': 'Running… each agent works in its own isolated worktree.',
  'swarm.noChanges': 'No changes were produced.',
  'swarm.confirmApply': 'Apply the merged changes to your working tree?',
  'swarm.leftUnapplied': 'Left unapplied. The merged diff is shown above.',
  'swarm.applied': 'Applied the merged swarm changes to your working tree.',
  'swarm.applyFailed': 'Could not apply the merged diff: {error}',

  // weekly-plan
  'weekly-plan.saved': 'Saved to {path}',

  // action-render
  'action-render.phase': 'phase',
  'action-render.declined': 'declined',
  'action-render.error': 'error: {message}',
  'action-render.failed': 'failed',
  'action-render.lines': '{count} line{plural}',
  'action-render.entriesOne': '{count} entry',
  'action-render.entriesMany': '{count} entries',
  'action-render.matchesOne': '{count} match line',
  'action-render.matchesMany': '{count} match linees',
  'action-render.written': 'written',
  'action-render.branch': 'branch {name}',
  'action-render.done': 'done',
  'action-render.applied': 'applied',
  'action-render.filesChanged': '{count} file{plural} changed',
  'action-render.moreDiffLines': '+{count} more diff lines',

  // context
  'context.refuseRead':
    'Refusing to read "{relPath}": {reason} Blocked paths (secrets, keys, .env) are never read into model prompts.',
  'context.confirmRead': 'Read "{relPath}" into the prompt? ({reason})',
  'context.declinedRead': 'Declined to read "{relPath}".',
  'context.fileNotFound': 'File not found: {relPath}',

  // interactions
  'interactions.headerNeverChanges': '{command} → {workflow} · {autonomy} · never changes code',
  'interactions.savedInteraction': 'Saved interaction {id} → {dir}',
  'interactions.patchHeader': 'patch → {workflow} · {autonomy} · apply requires confirmation',
  'interactions.diffDidNotValidate':
    'The proposed diff did not validate with `git apply --check`: {reason}. Review it before applying.',
  'interactions.patchTitle': 'Patch {id}',
  'interactions.filesAffected': 'Files affected: {files}',
  'interactions.filesAffectedNone': '(none detected)',
  'interactions.savedPatch': 'Saved patch {id} → {dir}',

  // patches
  'patches.noLocalPatches': 'No local patches found. Generate one first: excalibur patch "<task>".',
  'patches.notAGitRepo':
    'Cannot apply patch {id}: {repoRoot} is not a git repository. Run `git init` first.',
  'patches.emptyDiff':
    'Patch {id} has an empty diff — nothing to apply. Regenerate it with `excalibur patch "<task>"`.',
  'patches.diffDidNotValidate':
    'Patch {id} did not validate with `git apply --check` at proposal time; the apply below may fail.',
  'patches.didNotApply':
    'Patch {id} did not apply: {message}. Try `excalibur branch {id}` (applies onto a fresh branch) or regenerate the patch.',

  // provider-setup
  'provider-setup.detected_env':
    'Detected {defaultName} in your environment — press Enter to use it.',
  'provider-setup.ask_env_var_name':
    'Name of the environment variable holding the API key (never the key itself) [{defaultName}]:',
  'provider-setup.looks_like_key_value':
    'That looks like an API key VALUE. Enter the NAME of the environment variable instead (for example OPENAI_API_KEY) — Excalibur never stores key values.',
  'provider-setup.env_var_format':
    'Environment variable names use uppercase letters, digits and underscores.',
  'provider-setup.saved_env_set':
    'Saved. ✓ {apiKeyEnv} is already set in your environment — this provider is ready. Run `excalibur models test` to confirm the connection.',
  'provider-setup.saved_env_unset':
    'Saved. Set {apiKeyEnv} to your API key (Excalibur stores only the variable name), then run `excalibur models test` to confirm. With no key set, commands ask you to configure one — there is no mock fallback.',
  'provider-setup.detected_env_optional':
    'Detected {suggestion} in your environment — type it to send a bearer token, or leave blank for a keyless endpoint.',
  'provider-setup.ask_env_var_optional':
    'API key env var (leave blank if your endpoint needs no auth) [{suggestion} or blank]:',
  'provider-setup.looks_like_key_value_optional':
    'That looks like a key VALUE — enter the NAME of the env var (or blank). Using blank.',
  'provider-setup.hint_subscription_key': 'sanctioned subscription key · full native Excalibur',
  'provider-setup.hint_cli_prohibited':
    'drives the vendor’s official CLI · third-party token reuse is prohibited (at your own risk)',
  'provider-setup.hint_cli_own_risk': 'drives the vendor’s official CLI · at your own risk',
  'provider-setup.auto_configured':
    'Auto-configured {label}: {good} for coding, {fast} for fast suggestions & compaction — both on {apiKeyEnv}. Change either with `excalibur models setup`.',
  'provider-setup.ask_model': '{label} model:',
  'provider-setup.subscription_key_native':
    'Your {label} subscription runs through a subscription key (sanctioned) — full native Excalibur.',
  'provider-setup.cli_passthrough':
    'Excalibur will drive the official `{command}` CLI ({loginHint}). That passthrough adapter is coming — for now you can connect an API key instead.',
  'provider-setup.confirm_api_key_instead': 'Set up a {label} API key now instead?',
  'provider-setup.no_problem_later':
    'No problem — run `excalibur models setup` anytime to connect {label}.',
  'provider-setup.opt_subscription': 'Subscription',
  'provider-setup.opt_api_key': 'API key',
  'provider-setup.hint_api_key':
    'pay-per-token · full native Excalibur (auto-pairs a good + fast model)',
  'provider-setup.how_do_you_use': 'How do you use {label}?',
  'provider-setup.opt_ollama': 'Ollama (local) — free, no key',
  'provider-setup.hint_ollama_detected': 'detected on this machine!',
  'provider-setup.hint_ollama_install': 'install from ollama.com, then `ollama pull <model>`',
  'provider-setup.opt_self_hosted': 'Self-hosted / your own model',
  'provider-setup.hint_self_hosted':
    'vLLM · TGI · an internal Qwen/Llama gateway — your endpoint, key optional',
  'provider-setup.opt_mock': 'Mock',
  'provider-setup.hint_mock': 'offline / tests only — NOT a real model',
  'provider-setup.opt_later': 'Configure later',
  'provider-setup.select_provider':
    'Which model provider? (Excalibur is free — use your subscription or API key, or run a local/own model)',
  'provider-setup.ask_ollama_model': 'Ollama model name [llama3]:',
  'provider-setup.saved_ollama':
    'Saved. Excalibur will use your local Ollama at http://localhost:11434 (no key, no cost). Make sure Ollama is running and the model is pulled (`ollama pull <model>`). Ghost-text needs a fast second model, so it stays off in single-model mode.',
  'provider-setup.ask_endpoint_url': 'Your endpoint base URL [http://localhost:8000/v1]:',
  'provider-setup.ask_endpoint_model':
    'Model name served by your endpoint [Qwen/Qwen2.5-Coder-32B-Instruct]:',
  'provider-setup.saved_self_hosted_auth':
    'Saved. Excalibur will call {baseUrl} with the bearer token in {apiKeyEnv}.',
  'provider-setup.saved_self_hosted_keyless':
    'Saved. Excalibur will call {baseUrl} with no auth (keyless self-hosted endpoint).',

  // run-pipeline
  'run-pipeline.discoveryPrompt': 'Run Discovery first?',
  'run-pipeline.continuingWithoutDiscovery': 'Continuing without Discovery.',
  'run-pipeline.unknownWorkflow':
    'Unknown workflow "{workflow}". Run `excalibur workflows list` to see the catalog.',
  'run-pipeline.reason': 'Reason: {reason}',
  'run-pipeline.estimateFiles': '{count} file(s)',
  'run-pipeline.estimateFromRuns': '(from {count} past run(s))',
  'run-pipeline.estimateHeuristic': '(estimate)',
  'run-pipeline.estimateOverBudget':
    'Heads up: the estimate {cost} exceeds your --budget {budget} — the run will stop at the cap.',
  'run-pipeline.runPromptGate': '[Enter] continue  [m] change mode  [c] cancel',
  'run-pipeline.runCancelled': 'Run cancelled.',
  'run-pipeline.executionModePrompt': 'Execution mode:',
  'run-pipeline.modeFastLabel': 'Fast',
  'run-pipeline.modeFastHint': 'small fixes, minimal ceremony',
  'run-pipeline.modeCarefulLabel': 'Careful',
  'run-pipeline.modeCarefulHint': 'Level 4, stronger approvals',
  'run-pipeline.modeStructuredLabel': 'Structured',
  'run-pipeline.modeStructuredHint': 'spec → plan → implement → verify',
  'run-pipeline.modeExploreLabel': 'Explore',
  'run-pipeline.modeExploreHint': 'compare engineering alternatives',
  'run-pipeline.modeTeamDefaultLabel': 'Team default',
  'run-pipeline.runDir': 'Run {id} → {dir}',
  'run-pipeline.runCompleted': 'Run {id} completed.',
  'run-pipeline.runFinishedStatus': 'Run {id} finished with status: {status}',
  'run-pipeline.artifacts': 'Artifacts: {dir}',
  'run-pipeline.inspectWith': 'Inspect with: excalibur logs {id}',

  // turn-receipt
  'turn-receipt.narrative-action': 'Changes applied.',
  'turn-receipt.narrative-failed': 'The turn ended with an error.',
  'turn-receipt.narrative-partial': 'The turn stopped before finishing.',
  'turn-receipt.narrative-answer': 'Done.',
  'turn-receipt.file': 'file',
  'turn-receipt.files': 'files',
  'turn-receipt.declined': '{count} declined',
  'turn-receipt.just-now': 'just now',
  'turn-receipt.seconds-ago': '{seconds}s ago',
  'turn-receipt.minutes-ago': '{minutes}m ago',
  'turn-receipt.hours-ago': '{hours}h ago',
  'turn-receipt.hint-apply': 'review, then  excalibur apply {runId}',
  'turn-receipt.hint-fix-failures': 'address the failing checks above',
  'turn-receipt.hint-branch': 'changes are on branch {branch}',
  'turn-receipt.hint-resolve-block': 'resolve the block to continue',
  'turn-receipt.and-more': '…and {extra} more · /changes',

  // agent-turn
  'agent-turn.tool_needs_approval': '  ⚠ {tool} needs approval: {reason}{detail}',
  'agent-turn.allow_action':
    '  Allow this action?  (y = yes · n = no · a = Auto mode, stop asking)',
  'agent-turn.agent_header': '→ agent · {mode} · L{level}',
  'agent-turn.mode_answer': 'answer (read-only)',
  'agent-turn.mode_act': 'act',
  'agent-turn.run_dir': 'Run {id} → {dir}',
  'agent-turn.plan_header': '→ plan · planner (read-only) · L{level}',
  'agent-turn.plan_heading': 'Plan',
  'agent-turn.plan_non_interactive':
    'Plan ready. Re-run with approval to execute (non-interactive: not executing).',
  'agent-turn.plan_gate_prompt': '[approve / edit / cancel]',
  'agent-turn.plan_edit': 'Edit the task and re-plan.',
  'agent-turn.plan_cancelled': 'Plan cancelled. Nothing was changed.',
  'agent-turn.plan_saved': 'Plan saved to .excalibur/plans/{file} and recorded in memory.',
  'agent-turn.execute_header': '→ execute · implementer · L{level}',
  'agent-turn.fork_redacted':
    'The reconstructed base contains [REDACTED] where a secret was scrubbed at capture — fill those in before relying on the forked worktree.',
  'agent-turn.fork_header': '⑂ fork of {runId} @ step {step}/{total}',
  'agent-turn.fork_reused':
    'Reused {tokens} cached tokens ({cost}) — only the new instruction runs live.',
  'agent-turn.fork_worktree': 'Worktree {worktree} · branch {branch}',
  'agent-turn.undo_no_changes': 'Run {runId} recorded no file changes — nothing to undo.',
  'agent-turn.undo_cannot_reverse':
    "Cannot undo: the run's changes do not reverse-apply cleanly to your working tree ({reason}). The tree has changed since the run; resolve it first.",
  'agent-turn.undo_warn':
    "This reverts your working tree to run {runId}'s state at step {step}/{total}.",
  'agent-turn.undo_proceed': 'Proceed?',
  'agent-turn.undo_cancelled': 'Undo cancelled. Nothing was changed.',
  'agent-turn.undo_reverted_full': "✓ Working tree reverted — the run's changes were undone.",
  'agent-turn.undo_cannot_reapply':
    'Could not reconstruct step {step} ({reason}). Your working tree was left UNCHANGED.',
  'agent-turn.undo_reverted_step': '✓ Working tree reverted to step {step}.',

  // extensions
  'extensions.list_extensions_heading': 'Extensions:',
  'extensions.list_contributions_heading': 'Contributions:',
  'extensions.validate_ok': '{count} file(s) validated — everything looks good.',
  'extensions.validate_invalid': 'extensions validate found {count} invalid file(s).',
  'extensions.doctor_missing_entrypoint': 'missing entrypoint declaration',
  'extensions.doctor_entrypoint_not_built':
    'entrypoint {entrypoint} not built yet — run its build first',
  'extensions.doctor_issue': '{id}: {issue}',
  'extensions.doctor_loaded_cleanly': '{id} ({source}) loaded cleanly',
  'extensions.doctor_all_healthy': 'All extensions are healthy.',
  'extensions.enabled': 'Extension "{id}" enabled in {dir}/extensions.yaml.',
  'extensions.disabled': 'Extension "{id}" disabled in {dir}/extensions.yaml.',
  'extensions.install_not_local_dir':
    '"{path}" is not a local directory. Installing extensions from npm arrives in M8 — until then, pass a local folder containing excalibur.extension.yaml.',
  'extensions.install_no_manifest': '{path} has no excalibur.extension.yaml manifest.',
  'extensions.install_already_installed':
    'Extension "{id}" is already installed at {target}. Remove it first to reinstall.',
  'extensions.install_confirm': 'Install extension "{id}" ({kind}) into {dir}/extensions/?',
  'extensions.install_cancelled': 'Install cancelled.',
  'extensions.install_done': 'Installed "{id}" → {target}',
  'extensions.install_validate_hint': 'Run `excalibur extensions validate` to verify it.',
  'extensions.create_scaffolded': 'Scaffolded {kind} extension "{name}" → {dir}',
  'extensions.create_programmatic_hint':
    'Programmatic extensions load their COMPILED entrypoint: run `npm install && npm run build` inside the folder first.',
  'extensions.create_validate_hint': 'Validate with: excalibur extensions validate',

  // init
  'init.teamFullConflict': 'Use either --team or --full, not both.',
  'init.versionInGit': 'Version Excalibur config in Git?',
  'init.addedToGitignore': 'Added {dir}/ to .gitignore.',

  // instructions
  'instructions.scanProjectHeading': 'Project instructions (used automatically):',
  'instructions.scanSkillsHeading': 'Detected skills (review before enabling):',
  'instructions.scanGlobalHeading':
    'Personal/global instructions (referenced locally only, never copied):',
  'instructions.scanContextHeading': 'Project documentation (context):',
  'instructions.noneDetected': 'No instruction sources detected.',
  'instructions.scanManageHint':
    'Manage them with: excalibur instructions list|enable|disable|import',
  'instructions.inspectPath': 'Path: {path}',
  'instructions.inspectFormat': 'Format: {format} · Kind: {kind} · Scope: {scope}',
  'instructions.inspectTrust': 'Trust: {trust} · Enabled: {enabled}',
  'instructions.inspectContentHash': 'Content hash: {hash}',
  'instructions.truncated': '… (truncated)',
  'instructions.enabled': 'Instruction source "{id}" enabled in {dir}/config.yaml.',
  'instructions.disabled': 'Instruction source "{id}" disabled in {dir}/config.yaml.',
  'instructions.importGlobalBlocked':
    '"{id}" is a personal user-global source ({path}). Importing it copies personal context into the repository — re-run with --include-global if you really want that.',
  'instructions.importConfirm': 'Copy {path} into {dir}/instructions/?',
  'instructions.importCancelled': 'Import cancelled.',
  'instructions.sourceMissing': 'Source file is missing on disk: {path}',
  'instructions.importRedacted': 'Secrets found in the source were redacted in the imported copy.',
  'instructions.imported': 'Imported {path} → {target}',
  'instructions.doctorMissing': 'MISSING  {path}',
  'instructions.doctorChanged': 'CHANGED  {path} (content hash differs from the last scan)',
  'instructions.doctorOk': 'OK       {path}',
  'instructions.doctorMissingRecorded':
    'MISSING  {path} (recorded in the last scan, no longer detected)',
  'instructions.doctorAllReachable': 'All instruction sources are reachable.',

  // repl
  'repl.resume-wrong-repo':
    'Session {id} belongs to {repoRoot}, not this repository. Start a new session here, or resume it from its own repo.',
  'repl.cancelled-back-to-prompt': 'Cancelled. Back to the prompt.',
  'repl.ctrl-c-again': 'Press Ctrl-C again to exit.',
  'repl.goal-offer':
    "That reads as a goal to complete. Pursue it across turns until an evaluator says it's done (max {max})?",
  'repl.remember-usage': 'Usage: /remember <a decision, rejection, risk or convention to remember>',
  'repl.remember-saved':
    'Remembered ({detail}). Future runs touching these paths will be primed with it.',
  'repl.remember-reinforced':
    'Reinforced an existing memory ({detail}) — evidence ×{count}. It compounds: the more it recurs, the more confident Excalibur is.',
  'repl.remember-failed': 'Could not save memory: {reason}',
  'repl.compact-nothing': 'Nothing to compact yet — the recent context already fits.',
  'repl.compacted-manual':
    'Compacted {n} earlier turn(s) → summary · {before}→{after} tokens. Full detail stays in the run history.',
  'repl.compacted-auto':
    'Auto-compacted {n} earlier turn(s) → summary · {before}→{after} tokens. Full detail stays in the run history.',
  'repl.compaction-failed': 'Compaction failed: {reason}',
  'repl.plan-usage': 'Usage: /plan <task>. Describe what you want planned.',
  'repl.goal-done-gate': '  goal · done-gate: `{test}` must pass',
  'repl.goal-iteration': '  goal · iteration {n}/{max}: {status} — {reason}',
  'repl.goal-done': 'DONE',
  'repl.goal-continue': 'continue',
  'repl.goal-achieved': 'Goal achieved in {iterations} iteration(s).',
  'repl.goal-max-iterations':
    'Stopped at the {iterations}-iteration cap{reason}. Refine the goal, or run /goal again to continue.',
  'repl.goal-cancelled': 'Goal loop cancelled after {iterations} iteration(s).',
  'repl.goal-evaluator-unavailable':
    'Goal loop stopped (evaluator unavailable) after {iterations} iteration(s).',
  'repl.goal-usage':
    'Usage: /goal <objective> — Excalibur works toward it across turns until an evaluator says it is done.',
  'repl.loop-usage':
    'Usage: /loop [--every <sec>] [--times <n>] <prompt> — re-runs it periodically until ESC.',
  'repl.swarm-usage':
    'Usage: /swarm <task> — fans the task out to real parallel agents (independent subtasks, live lanes).',
  'repl.route-bg-offer':
    'This looks long-running — run it in the background (/bg) so you can keep working?',
  'repl.route-swarm-offer':
    'This looks parallelizable — fan it out to a swarm of real agents (/swarm)?',
  'repl.route-research-offer':
    'This looks like a research question — run deep web research with cited sources?',
  // deep research (F7)
  'research.network-off':
    'Network is disabled (permissions.network.mode = off). Enable it to research the web.',
  'research.starting': 'Researching: {question}',
  'research.stage': '• {stage} {detail}',
  'research.summary': 'Researched {sources} source(s) · {verified}/{claims} claims verified.',
  'repl.bg-usage':
    'Usage: /bg <task> — runs the task in the background (its own recorded run) while you keep working.',
  'repl.bg-started': '▸ background: {title} — running (use /threads to check on it)',
  'repl.bg-done': '✓ background done: {title}',
  'repl.bg-failed': '✗ background failed: {title} — {error}',
  'repl.bg-active': '{n} bg',
  'repl.threads-none': 'No background threads this session. Start one with /bg <task>.',
  'repl.threads-header': 'Background threads — {running} running · {done} done · {failed} failed',
  'repl.loop-start':
    'Looping every {every}s, up to {times}× — press ESC to stop. (recurrence, not completion)',
  'repl.loop-iteration': '  loop · iteration {iteration}/{times}',
  'repl.loop-completed': 'Loop completed {iterations} iteration(s).',
  'repl.loop-cancelled': 'Loop cancelled after {iterations} iteration(s).',
  'repl.shell-empty': 'Empty shell command.',
  'repl.shell-failed': 'Command failed (exit {code}).',
  'repl.help-title': 'Excalibur interactive session — commands',
  'repl.help-help': '  /help          show this help',
  'repl.help-plan': '  /plan <task>   plan first (read-only) → approve → execute',
  'repl.help-goal': '  /goal <objective>  work toward it across turns until an evaluator says done',
  'repl.help-loop': '  /loop [--every s] [--times n] <prompt>  re-run periodically until ESC',
  'repl.help-swarm':
    '  /swarm <task>  fan out to real parallel agents (independent subtasks, live lanes)',
  'repl.help-bg': '  /bg <task>     run a task in the background while you keep working',
  'repl.help-threads': '  /threads       list the background threads (running + finished)',
  'repl.help-discovery': '  /discovery <idea>  clarify an ambiguous idea before building',
  'repl.help-rewind':
    '  /rewind [id]   rewind a run step-by-step (time-machine; defaults to latest) · Esc-Esc',
  'repl.help-changes':
    '  /changes [id]  show the full changed-file list for a run (defaults to latest)',
  'repl.help-fork':
    '  /fork <instr>  fork the latest run (reuse its cached context) and run <instr> live',
  'repl.help-undo': '  /undo          revert the working tree by undoing the latest run (gated)',
  'repl.help-compact': '  /compact       condense older turns into a summary (frees context)',
  'repl.help-remember':
    '  /remember <x>  save a decision/risk/convention; future runs touching those paths are primed',
  'repl.help-model': '  /model         show the active provider/model',
  'repl.help-clear': '  /clear         clear the screen (keeps the session)',
  'repl.help-exit': '  /exit, /quit   close the session and leave',
  'repl.help-freeform-1': 'Type anything else in plain words (any language) — the model decides',
  'repl.help-freeform-2': 'whether to answer (read-only) or edit/run, governed by your autonomy',
  'repl.help-freeform-3':
    'level. Tool actions ask for inline approval. `!cmd` runs a shell command.',
  'repl.model-provider': 'Provider: {provider}',
  'repl.model-config': 'Config: {path}',
  'repl.model-mock':
    'Using the built-in mock provider (no providers.yaml — the zero-config default).',
  'repl.unknown-command': 'Unknown command: /{name}. Try /help.',
  'repl.discovery-usage': 'Usage: /discovery <idea>. Describe the idea to clarify before building.',
  'repl.changes-heading': 'Changes · {runId}',
  'repl.changes-none': '  No file changes recorded for this run.',
  'repl.changes-metrics-one': '  {files} file · +{insertions} −{deletions}',
  'repl.changes-metrics-many': '  {files} files · +{insertions} −{deletions}',
  'repl.changes-footer': '  Full diff: excalibur changes --diff   ·   rewind: /rewind',
  'repl.fork-usage':
    'Usage: /fork <instruction> — continue the latest run with a new instruction (reusing its cached context).',
  'repl.resuming': 'Resuming session {id} ({turns} message turns).',
  'repl.closed': 'Session {id} closed (just now · {timestamp}).',
  'repl.goodbye': 'Goodbye.',
  'repl.welcome-tip-diff': 'You have uncommitted changes — try “review the working diff”.',
  'repl.welcome-tip-default':
    'Describe what you want in plain words — the model decides how to act (ask, edit, run).',
  'repl.welcome-whats-new': 'Model-first agent loop in the shell, inline approvals, plan-mode.',

  // replay-scrubber
  'replay-scrubber.noLocalRuns': 'No local runs yet. Start one with: excalibur run "<task>"',
  'replay-scrubber.header': '⏮  Rewind {id} — {title}',
  'replay-scrubber.headerMeta': '{workflow} · L{level} · {status} · {count} steps · total {cost}',
  'replay-scrubber.phaseNamed': 'phase {name}',
  'replay-scrubber.noPhase': 'no phase',
  'replay-scrubber.stepPosition': 'step {current}/{total}',
  'replay-scrubber.noEvents': 'No events recorded for this run.',
  'replay-scrubber.totalCost': 'Total cost: {cost}',
  'replay-scrubber.costSoFar': '  cost so far: {cost}',
  'replay-scrubber.recent': '  recent:',
  'replay-scrubber.diffHeader': '--- accumulated diff at cursor ---',
  'replay-scrubber.noDiffAtPoint': '(no diff reconstructable at this point)',
  'replay-scrubber.controlsLead':
    'controls: n/p step · ⏎ next phase · e edit · t test · c command · x failure · a approval · g <n> goto · 0/$ first/last · d diff · ? explain · pin <note> · ',
  'replay-scrubber.controlFork': 'f fork',
  'replay-scrubber.controlUndo': 'u undo',
  'replay-scrubber.controlsTail': ' · q quit',
  'replay-scrubber.forkPrompt': 'fork instruction › ',
  'replay-scrubber.forkCancelled': 'Fork cancelled — no instruction given.',
  'replay-scrubber.forkCreated': 'Fork {id} created — replay it: excalibur replay {id}',
  'replay-scrubber.whyStep': 'Why step {step}? {summary}',
  'replay-scrubber.noDiffInRun': '(no diff reconstructable at this point in the run)',
  'replay-scrubber.noFurtherKind': 'No further {kind} step after here.',
  'replay-scrubber.noFurtherPhase': 'No further phase boundary after here.',
  'replay-scrubber.noEventsNothing': 'No events recorded for this run — nothing to replay.',
  'replay-scrubber.replayPrompt': 'replay › ',
  'replay-scrubber.gotoUsage': 'Usage: g <n> (1..{max}).',
  'replay-scrubber.pinUsage': 'Usage: pin <note> — annotate the current step.',
  'replay-scrubber.pinned': 'Pinned a note to step {step}.',
  'replay-scrubber.unknownControl':
    "Unknown control: {command}. Type 'h' for controls, 'q' to quit.",

  // context (deps-threaded)
  'context.noProvider':
    'No LLM provider is configured — Excalibur needs a real model. Run `excalibur models setup` to connect one (OpenAI, Anthropic, Groq, Ollama, …). (A mock provider exists only for offline/tests, via an explicit `type: mock` in providers.yaml.)',
  'context.safetyLine': 'Safety: {preset} — {description}',
  'context.safetyOk': 'No files will be modified without approval.',
  'context.safetyUnknown': 'Unknown preset — falling back to {preset} rules.',
  'context.providerUnusable':
    'Provider "{provider}" is not usable: {error}. Run `excalibur models setup` to configure a working LLM provider.',

  // wave5 deps-threaded (event stream, gate, gerunds)
  'run-pipeline.gate': '[Enter] run · [m] mode · [c] cancel',
  'agent-turn.gerund-planner': 'Planning…',
  'agent-turn.gerund-architect': 'Designing…',
  'agent-turn.gerund-reviewer': 'Reviewing…',
  'agent-turn.gerund-tester': 'Writing tests…',
  'agent-turn.gerund-default': 'Working…',
  // Arthurian flavor variants (opt-in via ui.flavor: arthurian).
  'agent-turn.gerund-planner-arthurian': 'Consulting the wise…',
  'agent-turn.gerund-architect-arthurian': 'Drawing the battle plans…',
  'agent-turn.gerund-reviewer-arthurian': 'Trial by combat…',
  'agent-turn.gerund-tester-arthurian': 'Proving the blade…',
  'agent-turn.gerund-default-arthurian': 'At the forge…',
  'event.run-started': '▶ run started',
  'event.workflow': '  workflow: {workflow}',
  'event.methodology': '  methodology: {methodology}',
  'event.phase-started': '▶ {name}',
  'event.phase-completed': '✓ {name} completed',
  'event.assistant-message': '  assistant message',
  'event.model-call': '  model call ({model})',
  'event.tool-call': '  tool: {tool}',
  'event.file-read': '  read {path}',
  'event.file-write': '  write {path}{sim}',
  'event.command-started': '  $ {command}{sim}',
  'event.exit-ok': '  ⎿ exit 0{sim}',
  'event.exit-fail': '  ⎿ exit {exit}{sim}',
  'event.test-result': '  tests: {status}{sim}',
  'event.patch-generated': '  ± patch generated',
  'event.patch-applied': '  ± patch applied{sim}',
  'event.branch-created': '  branch: {branch}',
  'event.approval-requested': '  approval requested',
  'event.approval-approved': '  approval granted',
  'event.approval-rejected': '  approval rejected',
  'event.artifact-created': '  artifact: {name}',
  'event.error': '  error: {message}',
  'event.verification-passed': '  ⚖ verification: {summary}',
  'event.verification-blocked': '  ⚖ verification BLOCKED: {summary}',
  'event.claim': '  ⊨ claim: {statement} — {status}',
  'event.policy-decision': '  ⛨ policy: {decision}{message}',
  'event.task-update': '  ☑ tasks: {done}/{total}',
  'event.compaction': '  ⊟ context compacted: {before}→{after} tokens',
  'event.diagnostics': '  ⚠ diagnostics {file}: {errors} error(s), {warnings} warning(s)',
  'event.run-completed': '■ run completed ({status})',
  'event.unknown': '  {type}',
  'event.simulated': ' (simulated)',

  // rail (tui labels, i18n)
  'rail.push': 'push',
  'rail.noPush': 'no push',
  'rail.swarm': 'Swarm',
  'rail.lanes': 'lanes',
  'rail.merge': 'merge',
  'rail.applied': 'applied',
  'rail.conflict': 'conflict',
  'rail.tasks': 'Tasks',

  // auto-accept (approval UX)
  'agent-turn.auto_enabled':
    'Auto mode ON — Excalibur will edit and run without asking (saved). Toggle with /auto.',
  'repl.context-last': '↳ Last: {what}',
  'repl.context-plan': '↳ Active plan: {task}',
  'repl.context-memory': '↳ Remembering {count} decision(s) about this repo.',
  'repl.resume-offer': 'Resume your last session ({turns} turn(s))?',
  'repl.auto-setup-prompt':
    'Allow Excalibur to edit files and run commands automatically (no approval prompts)?',
  'repl.auto-enabled':
    'Auto-accept ON — Excalibur will edit and run without asking (saved). Toggle with /auto.',
  'repl.auto-disabled':
    "Auto-accept OFF — Excalibur asks before edits (answer 'a' = Auto mode to stop asking, or /auto).",
  'repl.auto-on': 'Auto-accept ON — editing without prompts (saved).',
  'repl.auto-off': 'Auto-accept OFF — will ask before edits (saved).',
};
