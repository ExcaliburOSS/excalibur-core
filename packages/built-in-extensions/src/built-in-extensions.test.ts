import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  DEFAULT_METHODOLOGIES,
  DEFAULT_WORKFLOWS,
  DISCOVERY_QUESTION_PACKS,
} from '@excalibur/workflow-schema';
import {
  artifactTemplateSchema,
  commandMappingSchema,
  methodologySchema,
  modelRoutingSchema,
  policyPresetSchema,
  promptTemplateSchema,
  questionPackSchema,
  reportTemplateSchema,
  roleDefinitionSchema,
  workflowDefinitionSchema,
} from '@excalibur/declarative-schemas';
import {
  ContributionRegistry,
  extensionManifestSchema,
  type Contribution,
} from '@excalibur/extension-runtime';
import {
  BUILT_IN_EXTENSIONS,
  CORE_COMMAND_MAPPINGS_PACK,
  CORE_METHODOLOGIES_PACK,
  CORE_POLICIES_PACK,
  CORE_PROMPTS_PACK,
  CORE_PROVIDERS_PACK,
  CORE_REPORTS_PACK,
  CORE_WORKFLOWS_PACK,
  DISCOVERY_PACK,
  coreProviderFactories,
  getBuiltInExtension,
} from './index';

/** kind → declarative schema used to validate each contribution definition. */
const SCHEMAS_BY_KIND: Record<string, z.ZodTypeAny> = {
  methodology: methodologySchema,
  workflow: workflowDefinitionSchema,
  question_pack: questionPackSchema,
  prompt_template: promptTemplateSchema,
  artifact_template: artifactTemplateSchema,
  policy_preset: policyPresetSchema,
  model_routing: modelRoutingSchema,
  report_template: reportTemplateSchema,
  role_definition: roleDefinitionSchema,
  command_mapping: commandMappingSchema,
};

function contributionsOf(packId: string, kind?: string): Contribution[] {
  const pack = getBuiltInExtension(packId);
  expect(pack, `pack ${packId} must exist`).toBeDefined();
  const contributions = pack?.contributions ?? [];
  return kind ? contributions.filter((c) => c.kind === kind) : contributions;
}

describe('BUILT_IN_EXTENSIONS catalog', () => {
  it('exposes exactly the contracted packs, in registration order', () => {
    expect(BUILT_IN_EXTENSIONS.map((pack) => pack.manifest.id)).toEqual([
      'core-methodologies',
      'core-workflows',
      'discovery-pack',
      'core-prompts',
      'core-policies',
      'core-reports',
      'core-command-mappings',
      'core-providers',
    ]);
  });

  it('validates every pack manifest against extensionManifestSchema', () => {
    for (const pack of BUILT_IN_EXTENSIONS) {
      const result = extensionManifestSchema.safeParse(pack.manifest);
      expect(
        result.success,
        `manifest ${pack.manifest.id}: ${result.success ? '' : JSON.stringify(result.error.issues)}`,
      ).toBe(true);
    }
  });

  it('declares every pack as a declarative built-in without entrypoint', () => {
    for (const pack of BUILT_IN_EXTENSIONS) {
      expect(pack.manifest.kind).toBe('declarative');
      expect(pack.manifest.entrypoint).toBeUndefined();
      expect(pack.manifest.version).toBe('0.1.0');
    }
  });

  it('validates every contribution: declarative kinds against their schema, programmatic kinds carry a runtime value', () => {
    for (const pack of BUILT_IN_EXTENSIONS) {
      expect(pack.contributions.length).toBeGreaterThan(0);
      for (const contribution of pack.contributions) {
        const schema = SCHEMAS_BY_KIND[contribution.kind];
        if (schema === undefined) {
          // Programmatic contribution (e.g. model_provider): no declarative
          // schema — it carries a runtime `value`, not a parsed `definition`.
          expect(
            contribution.value !== undefined,
            `${pack.manifest.id}/${contribution.kind}/${contribution.id}: programmatic contribution must carry a value`,
          ).toBe(true);
          continue;
        }
        const result = schema.safeParse(contribution.definition);
        expect(
          result.success,
          `${pack.manifest.id}/${contribution.kind}/${contribution.id}: ${
            result.success ? '' : JSON.stringify(result.error.issues)
          }`,
        ).toBe(true);
      }
    }
  });

  it('stamps every contribution with source built_in and its pack id', () => {
    for (const pack of BUILT_IN_EXTENSIONS) {
      for (const contribution of pack.contributions) {
        expect(contribution.source).toBe('built_in');
        expect(contribution.extensionId).toBe(pack.manifest.id);
        expect(contribution.id.length).toBeGreaterThan(0);
      }
    }
  });

  it('keeps contribution ids unique per kind across all packs', () => {
    const seen = new Set<string>();
    for (const pack of BUILT_IN_EXTENSIONS) {
      for (const contribution of pack.contributions) {
        const key = `${contribution.kind}:${contribution.id}`;
        expect(seen.has(key), `duplicate contribution ${key}`).toBe(false);
        seen.add(key);
      }
    }
  });

  it('lists every contribution id in its manifest contributes block', () => {
    for (const pack of BUILT_IN_EXTENSIONS) {
      const declared = Object.values(pack.manifest.contributes ?? {})
        .flat()
        .map(String)
        .sort();
      const actual = pack.contributions.map((c) => c.id).sort();
      expect(declared).toEqual(actual);
    }
  });

  it('looks packs up by id and returns undefined for unknown ids', () => {
    expect(getBuiltInExtension('core-workflows')).toBe(CORE_WORKFLOWS_PACK);
    expect(getBuiltInExtension('nope')).toBeUndefined();
  });
});

describe('core-methodologies', () => {
  it('wraps the 14 DEFAULT_METHODOLOGIES by reference — never duplicates', () => {
    const contributions = contributionsOf('core-methodologies');
    expect(contributions).toHaveLength(14);
    expect(DEFAULT_METHODOLOGIES).toHaveLength(14);
    expect(contributions.map((c) => c.kind)).toEqual(Array(14).fill('methodology'));
    expect(contributions.map((c) => c.id)).toEqual(DEFAULT_METHODOLOGIES.map((m) => m.id));
    contributions.forEach((contribution, index) => {
      expect(contribution.definition).toBe(DEFAULT_METHODOLOGIES[index]?.definition);
    });
  });
});

describe('core-workflows', () => {
  it('wraps the 14 DEFAULT_WORKFLOWS by reference — never duplicates', () => {
    const contributions = contributionsOf('core-workflows');
    expect(contributions).toHaveLength(14);
    expect(DEFAULT_WORKFLOWS).toHaveLength(14);
    expect(contributions.map((c) => c.kind)).toEqual(Array(14).fill('workflow'));
    expect(contributions.map((c) => c.id)).toEqual(DEFAULT_WORKFLOWS.map((w) => w.id));
    contributions.forEach((contribution, index) => {
      expect(contribution.definition).toBe(DEFAULT_WORKFLOWS[index]?.definition);
    });
  });

  it('covers the contracted workflow catalog ids', () => {
    const ids = contributionsOf('core-workflows').map((c) => c.id);
    for (const id of [
      'ask-repo',
      'review-only',
      'assist',
      'propose-patch',
      'fast-fix',
      'standard-feature',
      'structured-feature',
      'safe-refactor',
      'pr-review',
      'security-review',
      'migration',
      'explore-alternatives',
      'human-gated',
      'discovery',
    ]) {
      expect(ids).toContain(id);
    }
  });
});

describe('CORE pack constants', () => {
  it('are the same objects as the catalog entries', () => {
    expect(BUILT_IN_EXTENSIONS).toContain(CORE_METHODOLOGIES_PACK);
    expect(BUILT_IN_EXTENSIONS).toContain(CORE_WORKFLOWS_PACK);
    expect(BUILT_IN_EXTENSIONS).toContain(DISCOVERY_PACK);
    expect(BUILT_IN_EXTENSIONS).toContain(CORE_PROMPTS_PACK);
    expect(BUILT_IN_EXTENSIONS).toContain(CORE_POLICIES_PACK);
    expect(BUILT_IN_EXTENSIONS).toContain(CORE_REPORTS_PACK);
    expect(BUILT_IN_EXTENSIONS).toContain(CORE_COMMAND_MAPPINGS_PACK);
    expect(BUILT_IN_EXTENSIONS).toContain(CORE_PROVIDERS_PACK);
  });
});

describe('core-providers (EXT-6 model providers)', () => {
  it('contributes a model_provider for each provider type, carrying the factory as its value', () => {
    const contributions = contributionsOf('core-providers');
    expect(contributions.length).toBeGreaterThan(0);
    for (const contribution of contributions) {
      expect(contribution.kind).toBe('model_provider');
      expect(typeof contribution.value).toBe('function'); // the runtime factory
      expect(contribution.definition).toBeUndefined();
    }
    // Covers the real provider types the gateway can construct.
    const ids = contributions.map((c) => c.id);
    for (const type of ['openai-compatible', 'anthropic', 'ollama']) {
      expect(ids).toContain(type);
    }
  });

  it('coreProviderFactories() rebuilds the gateway factory map from those contributions', () => {
    const factories = coreProviderFactories();
    const ids = contributionsOf('core-providers').map((c) => c.id);
    expect(Object.keys(factories).sort()).toEqual([...ids].sort());
    for (const type of Object.keys(factories)) {
      expect(typeof factories[type as keyof typeof factories]).toBe('function');
    }
  });
});

describe('integration with the extension-runtime ContributionRegistry', () => {
  it('registers every built-in contribution without warnings or rejections', () => {
    const registry = new ContributionRegistry();
    for (const pack of BUILT_IN_EXTENSIONS) {
      for (const contribution of pack.contributions) {
        registry.register(contribution);
      }
    }
    expect(registry.warnings()).toEqual([]);
    const total = BUILT_IN_EXTENSIONS.reduce((sum, pack) => sum + pack.contributions.length, 0);
    expect(registry.list()).toHaveLength(total);
    expect(registry.workflows()).toHaveLength(14);
    expect(registry.methodologies()).toHaveLength(14);
  });
});

describe('discovery question packs vs DISCOVERY_QUESTION_PACKS', () => {
  it('exposes one question pack per DiscoveryInputType with identical questions', () => {
    const packs = contributionsOf('discovery-pack', 'question_pack');
    const inputTypes = Object.keys(DISCOVERY_QUESTION_PACKS) as Array<
      keyof typeof DISCOVERY_QUESTION_PACKS
    >;
    expect(packs).toHaveLength(inputTypes.length);
    for (const inputType of inputTypes) {
      const expected = DISCOVERY_QUESTION_PACKS[inputType];
      const pack = packs.find((c) => c.id === `discovery-${inputType.replace(/_/g, '-')}`);
      expect(pack, `question pack for ${inputType}`).toBeDefined();
      const definition = questionPackSchema.parse(pack?.definition);
      expect(definition.questions).toEqual(expected);
    }
  });
});
