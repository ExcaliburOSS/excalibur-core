# Instruction and Skill Discovery (ISD) — Excalibur Core scope

Excalibur detects and uses the AI instruction files, agent manifests and skill definitions teams already maintain — it never forces rewriting them into `.excalibur/`, never overwrites or blindly merges them, and never auto-executes skills.

> Excalibur should start with the instructions your team already has, then help you organize and govern them safely.

First-run feeling: "Excalibur found your existing AI/project instructions and will use them safely."

## 1. What to detect

**Claude Code** (project: `./CLAUDE.md`, `./.claude/CLAUDE.md`, `./.claude/**`; user-global: `~/.claude/CLAUDE.md`, `~/.claude/**` — global = personal context, NEVER copied into the repo without explicit confirmation).
**Skills**: `./skills/**/SKILL.md`, `./.skills/**/SKILL.md`, `./.claude/skills/**/SKILL.md`, `~/.claude/skills/**/SKILL.md` — a SKILL.md is a capability definition, not a normal instruction; detected and listed but never auto-enabled when untrusted.
**Other formats**: `AGENTS.md`, `GEMINI.md`, `.cursor/rules/**`, `.cursor/rules.md`, `.github/copilot-instructions.md`, `.codex/**`, `.openai/**`, `.windsurf/**`, `.continue/**`, `.aider.conf.yml`, `.aiderignore`.
**Project docs** (classified as context, not strict instructions): `README.md`, `CONTRIBUTING.md`, `docs/**/*.md`, `adr/**`, `adrs/**`, `decisions/**`.

## 2. Shared types (exact names; live in `@excalibur/shared` `instructions.ts`)

```ts
export type InstructionSourceScope = 'project' | 'workspace' | 'user_global' | 'enterprise';
export type InstructionSourceFormat =
  | 'claude_md'
  | 'skill_md'
  | 'agents_md'
  | 'cursor_rules'
  | 'copilot_instructions'
  | 'gemini_md'
  | 'codex'
  | 'aider'
  | 'docs'
  | 'adr'
  | 'custom';
export type InstructionSourceKind =
  | 'instruction'
  | 'skill'
  | 'context'
  | 'policy_hint'
  | 'workflow_hint';
export type TrustLevel = 'trusted' | 'review_required' | 'untrusted';

export type InstructionSource = {
  id: string;
  scope: InstructionSourceScope;
  format: InstructionSourceFormat;
  kind: InstructionSourceKind;
  path: string;
  title: string | null;
  contentHash: string;
  trustLevel: TrustLevel;
  enabled: boolean;
  importedAs: 'instruction' | 'skill' | 'context' | 'policy_hint' | 'workflow_hint';
  metadata: Record<string, unknown>;
};

export type DetectedSkill = {
  id: string;
  name: string;
  path: string;
  scope: 'project' | 'user_global';
  description: string | null;
  triggers: string[];
  dependencies: string[];
  toolsRequired: string[];
  trustLevel: 'trusted' | 'review_required' | 'untrusted';
  enabled: boolean;
  source: InstructionSource;
};
```

SKILL.md parsing extracts: name, description, when-to-use (→ triggers), instructions, dependencies, required tools — null/empty when unparseable, but the skill is still detected.

## 3. Trust defaults and safety rules

Defaults: project CLAUDE.md/AGENTS.md/Cursor/Copilot → `trusted`; project docs → `trusted` (kind context); user-global CLAUDE.md → `trusted` for local user context only; project SKILL.md → `review_required`; user-global SKILL.md → `review_required`; unknown third-party skill → `untrusted`/`review_required`.

Safety (hard rules): never auto-execute skills; never auto-install skill dependencies; skills never override enterprise/repository policies; user-global never weakens repo/enterprise safety rules; never copy user-global files into the project without explicit confirmation; never import secrets from instruction files — redact them (reuse `redactSecrets` from `@excalibur/model-gateway`).

## 4. Precedence (effective context, highest first)

1. Enterprise policies/security rules · 2. Repository `.excalibur` config · 3. Repository instructions (AGENTS.md, CLAUDE.md, copilot-instructions, .cursor/rules) · 4. Workflow-specific instructions · 5. User-global instructions (~/.claude/CLAUDE.md) · 6. Project documentation (README, docs, ADRs) · 7. Enabled skills only.

## 5. `excalibur init` integration

Scan during init; print a grouped detection report (project instructions ✓, detected skills ⚠ review, personal/global ⚠ local-only) with "Recommended setup" lines. Defaults: index project instructions; reference user-global locally only; detect skills without auto-enabling unreviewed ones; write instruction references into `.excalibur/config.yaml`; never copy global files into the repo.

## 6. `.excalibur/config.yaml` additions (extends the shared config schema)

```yaml
instructions:
  sources:
    - path: './CLAUDE.md'
      format: claude_md
      scope: project
      enabled: true
    - path: '~/.claude/CLAUDE.md'
      format: claude_md
      scope: user_global
      enabled: true
      localOnly: true
skills:
  sources:
    - path: './.claude/skills/testing/SKILL.md'
      scope: project
      enabled: false
      trustLevel: review_required
```

## 7. CLI commands (ISD-3)

`excalibur instructions scan|list|inspect <id>|enable <id>|disable <id>|import <id>|doctor` and `excalibur skills list|inspect <id>|enable <id>|disable <id>`.

`instructions list` table columns: ID, TYPE, SCOPE, TRUST, ENABLED, PATH (user-global trust shown as `trusted-local`). `skills inspect` shows name/description/path/scope/triggers/dependencies/tools/trust/enabled. `instructions import <id>` copies a source into `.excalibur/instructions/` — for `user_global` sources it requires explicit interactive confirmation (never with bare `--yes` alone; require `--include-global`). enable/disable persist into config.yaml.

## 8. EffectiveInstructionBuilder (ISD-4)

```ts
class EffectiveInstructionBuilder {
  build(input: {
    repositoryPath: string;
    workflowId?: string;
    autonomyLevel?: number;
    includeUserGlobal?: boolean;
    enabledSkills?: string[];
  }): Promise<{ instructionsMarkdown: string; sources: InstructionSource[]; warnings: string[] }>;
}
```

Behavior: load enabled sources → apply precedence → dedupe overlapping files → include source headers (`[Source: CLAUDE.md]`, `[Source: ~/.claude/CLAUDE.md, local user preference]`) → redact secrets → exclude disabled/untrusted skills → record conflict warnings → cap context (truncate large docs with a `…summarized` marker; per-source cap ~4000 chars, total cap ~24000 chars in M1).

Conflicts are never silently resolved — record a warning naming both sources and which one wins by precedence (e.g., CLAUDE.md says npm, config.yaml says pnpm → config wins, warning stored).

## 9. Prompt integration (ISD-5)

`ask`, `review`, `patch`, `run`, `discovery` build the effective context first and prepend a compact source-aware section ("Effective project instructions:" + per-source blocks) to the model prompt. Disabled skills never appear. The run's events include a `log` event listing source paths used and warnings.

## 10. Out of scope in M1 (Enterprise, roadmap)

Admin controls (disable user-global per org, restrict formats, central skill approval), enterprise precedence enforcement and audit of sources per run live in Excalibur Enterprise (M5); Enterprise M1 only adds the `instructionContext` Json metadata column on AgentRun/AssistantInteraction.
