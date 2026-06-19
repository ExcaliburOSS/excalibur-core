import {
  DECLARATIVE_TYPES,
  declarativeSchemasByType,
  isDeclarativeType,
  type DeclarativeType,
} from '@excalibur/declarative-schemas';
import type { Methodology, WorkflowDefinition } from '@excalibur/workflow-schema';

/**
 * Contributions are the unit of extensibility: each loaded extension
 * contributes named definitions (declarative) or runtime values
 * (programmatic) into one shared `ContributionRegistry`.
 */

/** The 10 declarative contribution kinds (extensions spec §4). */
export const DECLARATIVE_CONTRIBUTION_KINDS = DECLARATIVE_TYPES;

/** The 10 programmatic contribution kinds (extensions spec, intro). */
export const PROGRAMMATIC_CONTRIBUTION_KINDS = [
  'work_item_provider',
  'communication_provider',
  'model_provider',
  'agent_adapter',
  'tool',
  'context_source',
  'exporter',
  'policy_evaluator',
  'vcs_provider',
  'enterprise_sync_provider',
] as const;
export type ProgrammaticContributionKind = (typeof PROGRAMMATIC_CONTRIBUTION_KINDS)[number];

/** All 20 contribution kinds. */
export const CONTRIBUTION_KINDS = [
  ...DECLARATIVE_CONTRIBUTION_KINDS,
  ...PROGRAMMATIC_CONTRIBUTION_KINDS,
] as const;
export type ContributionKind = DeclarativeType | ProgrammaticContributionKind;

/** Where a contribution came from, in load order (extensions spec §7). */
export const CONTRIBUTION_SOURCES = ['built_in', 'project', 'local', 'npm', 'enterprise'] as const;
export type ContributionSource = (typeof CONTRIBUTION_SOURCES)[number];

/**
 * Sources loaded later in the pipeline override earlier ones for the same
 * contribution id (spec §7: project-level overrides built-in).
 */
const SOURCE_RANK: Readonly<Record<ContributionSource, number>> = {
  built_in: 0,
  project: 1,
  local: 2,
  npm: 3,
  enterprise: 4,
};

/** One contributed definition or runtime value. */
export type Contribution = {
  kind: ContributionKind;
  id: string;
  extensionId: string;
  source: ContributionSource;
  /** Parsed declarative definition (for the 10 declarative kinds). */
  definition?: unknown;
  /** Runtime value provided by a programmatic extension. */
  value?: unknown;
};

/**
 * Registry of all contributions from all loaded extensions.
 *
 * Conflict rules (extensions spec §7):
 * - duplicate contribution id from the same source → ignored, warning recorded;
 * - same contribution id from a later source overrides an earlier source
 *   (project overrides built_in, local overrides project, …);
 * - an earlier source registered after a later one is ignored with a warning.
 *
 * Declarative definitions are validated against their schema on `register`;
 * invalid definitions are rejected with a recorded warning so that the typed
 * `workflows()` / `methodologies()` accessors are always safe.
 */
export class ContributionRegistry {
  private readonly byKind = new Map<ContributionKind, Map<string, Contribution>>();
  private readonly warningList: string[] = [];

  register(contribution: Contribution): void {
    const normalized = this.normalize(contribution);
    if (normalized === undefined) {
      return;
    }
    const { kind, id } = normalized;
    let forKind = this.byKind.get(kind);
    if (forKind === undefined) {
      forKind = new Map<string, Contribution>();
      this.byKind.set(kind, forKind);
    }
    const existing = forKind.get(id);
    if (existing === undefined) {
      forKind.set(id, normalized);
      return;
    }
    if (existing.source === normalized.source) {
      this.addWarning(
        `Duplicate contribution '${kind}/${id}' from extension '${normalized.extensionId}' ` +
          `(source: ${normalized.source}) ignored — already registered by extension '${existing.extensionId}'.`,
      );
      return;
    }
    if (SOURCE_RANK[normalized.source] > SOURCE_RANK[existing.source]) {
      // Later sources win: e.g. a project-level workflow overrides the built-in one.
      forKind.set(id, normalized);
      return;
    }
    this.addWarning(
      `Contribution '${kind}/${id}' from source '${normalized.source}' ignored — ` +
        `it is overridden by the existing '${existing.source}' registration.`,
    );
  }

  get(kind: ContributionKind, id: string): Contribution | undefined {
    return this.byKind.get(kind)?.get(id);
  }

  list(kind?: ContributionKind): Contribution[] {
    if (kind !== undefined) {
      const forKind = this.byKind.get(kind);
      return forKind === undefined ? [] : Array.from(forKind.values());
    }
    const all: Contribution[] = [];
    for (const forKind of this.byKind.values()) {
      for (const contribution of forKind.values()) {
        all.push(contribution);
      }
    }
    return all;
  }

  /** All registered workflow definitions (project overrides applied). */
  workflows(): WorkflowDefinition[] {
    // Safe: declarative definitions are schema-validated in `register`.
    return this.list('workflow')
      .filter((c) => c.definition !== undefined)
      .map((c) => c.definition as WorkflowDefinition);
  }

  /** All registered methodology definitions (project overrides applied). */
  methodologies(): Methodology[] {
    // Safe: declarative definitions are schema-validated in `register`.
    return this.list('methodology')
      .filter((c) => c.definition !== undefined)
      .map((c) => c.definition as Methodology);
  }

  /** Warnings recorded while registering contributions (conflicts, invalid definitions). */
  warnings(): string[] {
    return [...this.warningList];
  }

  /** Record a registry-level warning (used by the extension loader too). */
  addWarning(message: string): void {
    this.warningList.push(message);
  }

  /**
   * Validate declarative definitions on entry; returns the contribution with
   * the parsed (normalized) definition, or `undefined` when rejected.
   */
  private normalize(contribution: Contribution): Contribution | undefined {
    if (!isDeclarativeType(contribution.kind) || contribution.definition === undefined) {
      return contribution;
    }
    const schema = declarativeSchemasByType[contribution.kind];
    const result = schema.safeParse(contribution.definition);
    if (!result.success) {
      const reasons = result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      this.addWarning(
        `Contribution '${contribution.kind}/${contribution.id}' from extension ` +
          `'${contribution.extensionId}' has an invalid definition and was ignored — ${reasons}`,
      );
      return undefined;
    }
    return { ...contribution, definition: result.data as unknown };
  }
}
