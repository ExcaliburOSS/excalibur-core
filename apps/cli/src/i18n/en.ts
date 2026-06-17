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

  // branch
  "branch.not-a-repo": "Cannot create branch {branchName}: {repoRoot} is not a git repository. Run `git init` first.",
  "branch.empty-diff": "Patch {patchId} has an empty diff — nothing to apply onto a branch. Regenerate it with `excalibur patch \"<task>\"`.",
  "branch.confirm": "Create git branch {branchName} and apply the patch onto it?",
  "branch.cancelled": "Branch creation cancelled.",
  "branch.applied-failed": "Created branch {branchName}, but the patch did not apply: {reason}. You are on {branchName}; resolve it manually or regenerate the patch.",
  "branch.no-files-detected": "no files detected",
  "branch.applied-success": "Created branch {branchName} and applied the patch ({files}).",

  // login
  "login.experimental-note": "Experimental: the Excalibur Enterprise control plane is not public yet. Everything keeps working locally without an account.",
  "login.not-connected-sync": "Not connected. Run `excalibur login` first (or set {baseUrlEnv} and {apiKeyEnv}).",
  "login.no-local-runs": "No local runs to sync yet. Create one with: excalibur run \"<task>\"",
  "login.synced": "Synced run {runId} to {baseUrl}.",
  "login.ask-base-url": "Enterprise base URL (e.g. https://excalibur.your-company.com):",
  "login.base-url-required": "An Enterprise base URL is required. Pass --base-url <url> or answer the prompt.",
  "login.ask-api-key": "API key (stored locally with file mode 0600):",
  "login.api-key-required": "An API key is required. Pass --api-key <key> or answer the prompt.",
  "login.credentials-saved": "Credentials saved to {filePath} (mode 0600).",
  "login.env-precedence": "Environment variables {baseUrlEnv} / {apiKeyEnv} take precedence when set.",
  "login.not-connected-status": "Not connected. Run `excalibur login`, or set {baseUrlEnv} and {apiKeyEnv}.",
  "login.connected": "Connected to {baseUrl}.",
  "login.credentials-file": "Credentials file: {path}",

  // methodologies
  "methodologies.unknown": "Unknown methodology \"{id}\". Available: {known}",
  "methodologies.heading": "{name} ({id})",
  "methodologies.use-when": "Use when:",
  "methodologies.avoid-when": "Avoid when:",
  "methodologies.default-workflow": "Default workflow: {workflow}",
  "methodologies.phases": "Phases: {phases}",
  "methodologies.risk-profile": "Risk profile: {risk}",

  // models
  "models.test-mock": "Provider \"{provider}\" is the offline mock — nothing to reach over the network. Configure a real provider with `excalibur models setup` to test a live connection.",
  "models.test-sending": "Testing provider \"{provider}\"{modelLabel} — sending a tiny request…",
  "models.test-connected": "Connected — {provider}{modelLabel} responded in {seconds}s · {tokens}{cost}.",
  "models.test-reply": "Reply: \"{reply}\"",
  "models.test-failed": "Could not reach provider \"{provider}\"{modelLabel}: {message} Check the API key env var is exported and the base URL/model are correct (`excalibur models list`).",
  "models.list-none": "No LLM provider configured. Run `excalibur models setup` — the free default is local Ollama; Kimi K2 (Moonshot) is the recommended paid option (bring your own key).",
  "models.status-built-in": "ready (built-in)",
  "models.status-ready-set": "ready · set {apiKeyEnv}",
  "models.status-ready": "ready",
  "models.setup-skipped": "Provider setup skipped. Excalibur needs an LLM — run `excalibur models setup` anytime (free: local Ollama · recommended: Kimi K2 via Moonshot, BYOK).",
  "models.setup-wrote": "Wrote {filePath}",
  "models.setup-keys-note": "API keys are read from environment variables at call time — never stored.",
  "models.setup-test-confirm": "Test the connection now? (sends a tiny request)",

  // skills
  "skills.none-detected": "No skills detected (looked for **/SKILL.md in the repo and ~/.claude/skills).",
  "skills.list-footer": "Skills are never auto-executed; enable them explicitly per repository.",
  "skills.inspect-heading": "{id} — {name}",
  "skills.inspect-description": "Description: {description}",
  "skills.inspect-path": "Path: {path} · Scope: {scope}",
  "skills.inspect-trust": "Trust: {trust} · Enabled: {enabled}",
  "skills.inspect-triggers": "Triggers: {triggers}",
  "skills.inspect-dependencies": "Dependencies: {dependencies}",
  "skills.inspect-tools": "Tools required: {tools}",
  "skills.enable-needs-accept-risk": "Skill \"{id}\" is {trustLevel}. Review {path} first, then re-run with --accept-risk. The --yes flag alone never enables unreviewed skills.",
  "skills.enable-risk-accepted": "Enabling {trustLevel} skill \"{name}\" — you accepted the risk explicitly (--accept-risk).",
  "skills.enabled": "Skill \"{id}\" enabled in {dir}/config.yaml.",
  "skills.enabled-footer": "Skills are never auto-executed — they only join the effective context.",
  "skills.disabled": "Skill \"{id}\" disabled in {dir}/config.yaml.",

  // status
  "status.no-discovery-sessions": "No local discovery sessions. Start one with: excalibur discovery \"<idea>\"",
  "status.no-runs": "No local runs yet. Start one with: excalibur run \"<task>\"",
  "status.rewind-hint": "Rewind any run like a video: excalibur rewind <id>",
  "status.counts": "Patches: {patches} · Interactions: {interactions} · Runs: {runs}",
  "status.next-steps-heading": "Useful next steps:",
  "status.next-step-team": "  - Share team standards: excalibur init --team",
  "status.next-step-instructions": "  - Add custom instructions under .excalibur/instructions/",
  "status.next-step-paths": "  - Tighten rules for sensitive paths in .excalibur/config.yaml (autonomy.paths)",
  "status.next-step-github": "  - Connect GitHub Issues and work items (arrives in M4)",

  // update
  "update.checking": "Checking for updates… (installed {current})",
  "update.check-failed": "Could not check for updates{errSuffix}. You can upgrade anytime with: {cmd}",
  "update.up-to-date": "You're up to date — @excalibur/cli {current} is the latest release.",
  "update.ahead": "Installed @excalibur/cli {current} is newer than the latest published release ({latest}). Nothing to update.",
  "update.available": "Update available: {current} → {latest}",
  "update.upgrade-with": "Upgrade with: {cmd}",
  "update.confirm-run": "Run \"{cmd}\" now?",
  "update.running": "Running: {cmd}",
  "update.upgraded": "Upgraded to @excalibur/cli@latest ({latest}). Restart your shell to use it.",
  "update.upgrade-failed": "Upgrade command failed: {message}. Run it manually: {cmd}",

  // workflows
  "workflows.explain-hint": "Explain one with: excalibur workflows explain <id>",
  "workflows.unknown": "Unknown workflow \"{id}\". Available: {known}",
  "workflows.title": "{name} ({id})",
  "workflows.mode": "Mode: {mode}",
  "workflows.levels": "Supported autonomy levels: {levels}",
  "workflows.phases-heading": "Phases:",
  "workflows.phase-role": "role: {role}",
  "workflows.phase-optional": "(optional)",
  "workflows.phase-approval": "approval: {approval}",
  "workflows.phase-confirmation": "requires confirmation",
  "workflows.artifacts": "Artifacts: {artifacts}",

  // apply
  "apply.confirm": "Apply patch {id} to your working tree?",
  "apply.cancelled": "Apply cancelled.",
  "apply.applied": "Applied patch {id} to your working tree ({files}).",
  "apply.no-files": "no files detected",

  // changes
  "changes.heading": "Changes · {runId}",
  "changes.noFileChanges": "  No file changes recorded for this run.",
  "changes.diffstat": "  {files} file{plural} · +{insertions} −{deletions}",
  "changes.noUnifiedDiff": "  (no unified diff recorded for this run)",

  // cmux
  "cmux.stub": "Honest stub: the CMUX integration activates in milestone OSS-10 — multi-pane sessions (planner / implementer / reviewer / tests / logs) with artifacts kept in .excalibur/runs/.",
  "cmux.detected": "CMUX detected on this machine — you are ready for OSS-10.",
  "cmux.not-installed": "CMUX is not installed. It is optional: every workflow works without it.",
  "cmux.fallback": "Until then: excalibur run \"<task>\" executes the same workflows in one terminal.",

  // discovery
  "discovery.sessionCreated": "Discovery session {id} ({inputType}) → {dir}",
  "discovery.answerPrompt": "Answer the questions below — press Enter to skip any of them.",
  "discovery.doNotBuild": "Recommendation: do not build. The evidence collected does not justify this work — see recommendation.md for the reasons. Nothing further is suggested.",
  "discovery.suggestedNextSteps": "Suggested next steps:",
  "discovery.artifacts": "Artifacts: {dir}",
  "discovery.workItemSourcesM4": "Work-item Discovery sources (Linear, Jira, GitHub Issues) become available in M4. Until then, paste the ticket text: excalibur discovery \"<text>\" --type work_item",
  "discovery.invalidType": "--type must be one of: {types} (got \"{got}\").",
  "discovery.fileNotFound": "File not found: {path}",
  "discovery.provideIdea": "Provide an idea to clarify: excalibur discovery \"Add contract renewal reminders\"",

  // doctor
  "doctor.check.nodeVersion": "node version",
  "doctor.detail.nodeTooOld": " — Excalibur requires Node ≥ 22",
  "doctor.check.gitAvailable": "git available",
  "doctor.detail.gitNotFound": "git not found on PATH",
  "doctor.check.gitRepository": "git repository",
  "doctor.detail.gitBranch": "branch: {branch}",
  "doctor.detail.gitNotRepo": "not a git repository — diffs and branches unavailable",
  "doctor.detail.excaliburNotInit": "not initialized — run `excalibur init` (defaults still work)",
  "doctor.detail.configValid": "valid",
  "doctor.detail.configMissing": "missing — defaults active",
  "doctor.check.safetyPreset": "safety preset",
  "doctor.detail.presetActive": "{presetId} active",
  "doctor.detail.presetUnknown": "unknown preset \"{presetId}\" — falling back to {fallback}",
  "doctor.check.instructionSources": "instruction sources",
  "doctor.detail.sourcesReachable": "{count} configured, all reachable",
  "doctor.detail.sourcesMissing": "missing: {paths}",
  "doctor.check.modelProviders": "model providers",
  "doctor.detail.providersMissing": "no providers.yaml — using the built-in mock (run `excalibur models setup`)",
  "doctor.detail.providersValid": "providers.yaml valid",
  "doctor.check.apiKeyEnv": "api key env ({name})",
  "doctor.detail.keyEnvSet": "{keyEnv} is set",
  "doctor.detail.keyEnvUnset": "{keyEnv} is not set",
  "doctor.check.detectedCommands": "detected commands",
  "doctor.detail.commandsNone": "none detected — agents cannot verify changes",
  "doctor.check.workflowCatalog": "workflow catalog",
  "doctor.detail.workflowCounts": "{workflows} workflows, {methodologies} methodologies",
  "doctor.check.extensions": "extensions",
  "doctor.detail.extensionsLoaded": "{count} loaded",
  "doctor.detail.loadError": "load error",
  "doctor.check.extensionWarnings": "extension warnings",
  "doctor.check.enterpriseCredentials": "enterprise credentials",
  "doctor.detail.credentialsConnected": "connected to {baseUrl}",
  "doctor.detail.credentialsNone": "not configured (optional)",
  "doctor.error.failed": "doctor found {count} failing check(s).",

  // fork
  "fork.noSteps": "Run \"{runId}\" has no recorded steps.",
  "fork.atNotWhole": "--at must be a whole step number between 1 and {total} (got \"{at}\").",
  "fork.atOutOfRange": "--at must be a step between 1 and {total} (got \"{at}\").",
  "fork.created": "Fork {forkRunId} created. Inspect it in its worktree, or replay it: excalibur replay {forkRunId}",

  // logs
  "logs.noRuns": "No local runs yet. Start one with: excalibur run \"<task>\"",
  "logs.heading": "{id} — {title} ({status})",
  "logs.noEvents": "No events recorded.",

  // patch
  "patch.taskEmpty": "The task must not be empty.",
  "patch.applyConfirm": "Apply patch to your working tree?",
  "patch.applied": "Applied patch {id} to your working tree ({files}).",
  "patch.noFilesDetected": "no files detected",
  "patch.next": "Next: excalibur apply {id} · excalibur branch {id} · excalibur reject {id}",

  // pr
  "pr.noRuns": "No local runs yet. Start one with: excalibur run \"<task>\"",
  "pr.saved": "Saved to {path}",
  "pr.stub": "Honest stub: `pr-create` activates in milestone OSS-9 (M2), opening pull requests through the GitHub CLI.",
  "pr.ghDetected": "GitHub CLI (gh) detected — you are ready for M2.",
  "pr.ghMissing": "GitHub CLI (gh) not found on PATH. Install it from https://cli.github.com to be ready.",
  "pr.untilThen": "Until then: excalibur pr-summary prints a summary you can paste into a PR.",

  // replay
  "replay.at-must-be-positive": "--at must be a positive step number (got \"{at}\").",

  // review
  "review.cleanTree": "Working tree is clean — nothing to review.",
  "review.noTypecheck": "No typecheck command configured — skipping diagnostics.",
  "review.runningDiagnostics": "Running diagnostics: {typecheck}…",
  "review.typecheckErrors": "Typecheck reported {count} error(s) — anchoring the review on them.",
  "review.typecheckClean": "Typecheck is clean.",

  // run
  "run.task_empty": "The task must not be empty.",

  // swarm
  "swarm.taskEmpty": "The task must not be empty.",
  "swarm.needsGitRepo": "Swarm needs a git repository — each agent runs in an isolated worktree.",
  "swarm.decomposing": "Decomposing the task into independent subtasks…",
  "swarm.heading": "Swarm: {reason}",
  "swarm.singleUnit": "Only one independent unit — this runs as a single agent (no real fan-out).",
  "swarm.confirmRun": "Run {count} agent(s) in parallel?",
  "swarm.cancelled": "Swarm cancelled.",
  "swarm.running": "Running… each agent works in its own isolated worktree.",
  "swarm.noChanges": "No changes were produced.",
  "swarm.confirmApply": "Apply the merged changes to your working tree?",
  "swarm.leftUnapplied": "Left unapplied. The merged diff is shown above.",
  "swarm.applied": "Applied the merged swarm changes to your working tree.",
  "swarm.applyFailed": "Could not apply the merged diff: {error}",

  // weekly-plan
  "weekly-plan.saved": "Saved to {path}",
};
