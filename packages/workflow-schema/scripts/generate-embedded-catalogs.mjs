#!/usr/bin/env node
/**
 * Regenerates `src/default-workflows.ts` and `src/default-methodologies.ts`
 * from the YAML sources in `default-workflows/` and `default-methodologies/`.
 *
 * The YAML files at the package root are the single source of truth; the
 * generated TS modules embed them verbatim as string constants so the built
 * package needs no file resolution at runtime. A test asserts the embedded
 * strings match the files — rerun this script after editing any YAML.
 *
 * Usage: node scripts/generate-embedded-catalogs.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Canonical catalog order (Build Contract §4.2). */
const WORKFLOW_IDS = [
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
];

const METHODOLOGY_IDS = [
  'lightweight',
  'review-first',
  'patch-proposal',
  'fast-fix',
  'plan-then-execute',
  'spec-driven',
  'tdd-agentic',
  'safe-refactor',
  'security-first',
  'migration',
  'explore-then-choose',
  'human-gated',
  'discovery',
  'agentic-agile-light',
];

function constantName(id, suffix) {
  return `${id.toUpperCase().replace(/-/g, '_')}_${suffix}_YAML`;
}

function escapeTemplateLiteral(text) {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

function generateModule({
  ids,
  dir,
  suffix,
  header,
  typeName,
  parserName,
  arrayName,
  getterName,
  mapName,
}) {
  const lines = [header, ''];
  for (const id of ids) {
    const yamlText = readFileSync(join(packageRoot, dir, `${id}.yaml`), 'utf8');
    lines.push(
      `/** YAML source of the built-in \`${id}\` ${suffix.toLowerCase()} (mirrored at \`${dir}/${id}.yaml\`). */`,
      `export const ${constantName(id, suffix)} = \`${escapeTemplateLiteral(yamlText)}\`;`,
      '',
    );
  }
  lines.push(
    `export const ${arrayName}: ReadonlyArray<{`,
    '  id: string;',
    '  yaml: string;',
    `  definition: ${typeName};`,
    '}> = [',
    ...ids.map((id) => {
      const constant = constantName(id, suffix);
      return `  { id: '${id}', yaml: ${constant}, definition: ${parserName}(${constant}) },`;
    }),
    '];',
    '',
    `const ${mapName} = new Map(${arrayName}.map((entry) => [entry.id, entry.definition]));`,
    '',
    `/** Look up a built-in ${suffix.toLowerCase()} definition by id. */`,
    `export function ${getterName}(id: string): ${typeName} | undefined {`,
    `  return ${mapName}.get(id);`,
    '}',
    '',
  );
  return lines.join('\n');
}

const generatedNote = `// GENERATED FILE — do not edit the YAML constants by hand.
// Source of truth: the YAML files at the package root. Regenerate with:
//   node scripts/generate-embedded-catalogs.mjs`;

const workflowsModule = generateModule({
  ids: WORKFLOW_IDS,
  dir: 'default-workflows',
  suffix: 'WORKFLOW',
  typeName: 'WorkflowDefinition',
  parserName: 'parseWorkflowYaml',
  arrayName: 'DEFAULT_WORKFLOWS',
  getterName: 'getDefaultWorkflow',
  mapName: 'workflowsById',
  header: `/**
 * Built-in workflow catalog: the 14 default workflows (Build Contract §4.2).
 *
 * \`fast-fix\`, \`structured-feature\` and \`explore-alternatives\` are
 * verbatim-normative from the OSS spec §9, \`discovery\` from the Discovery
 * spec §5 and \`ask-repo\` follows the Onboarding spec §6.
 */
${generatedNote}
import { parseWorkflowYaml } from './parse';
import type { WorkflowDefinition } from './schema';`,
});

const methodologiesModule = generateModule({
  ids: METHODOLOGY_IDS,
  dir: 'default-methodologies',
  suffix: 'METHODOLOGY',
  typeName: 'Methodology',
  parserName: 'parseMethodologyYaml',
  arrayName: 'DEFAULT_METHODOLOGIES',
  getterName: 'getDefaultMethodology',
  mapName: 'methodologiesById',
  header: `/**
 * Built-in methodology catalog: the 14 default methodologies — the 12 of the
 * OSS spec §7 plus \`discovery\` (Discovery spec §4, verbatim-normative) and
 * \`agentic-agile-light\` (Onboarding spec §6). \`spec-driven\` is
 * verbatim-normative from the OSS spec §8.
 */
${generatedNote}
import { parseMethodologyYaml } from './parse';
import type { Methodology } from './schema';`,
});

writeFileSync(join(packageRoot, 'src', 'default-workflows.ts'), workflowsModule);
writeFileSync(join(packageRoot, 'src', 'default-methodologies.ts'), methodologiesModule);

process.stdout.write(
  `Generated src/default-workflows.ts (${WORKFLOW_IDS.length} workflows) and ` +
    `src/default-methodologies.ts (${METHODOLOGY_IDS.length} methodologies)\n`,
);
