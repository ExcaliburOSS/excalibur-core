import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CliUsageError } from '../errors';

/**
 * `excalibur extensions create <type> <name>` scaffolds (extensions spec §9):
 * declarative types → manifest + YAML/Markdown + README; programmatic types →
 * manifest + package.json + tsconfig + src/index.ts (defineExtension) +
 * README. Every generated file passes `excalibur extensions validate`.
 */

export const DECLARATIVE_SCAFFOLD_TYPES = [
  'methodology',
  'workflow',
  'question-pack',
  'prompt-template',
  'artifact-template',
  'policy-preset',
  'model-routing',
  'report-template',
  'role-definition',
  'command-mapping',
] as const;
export type DeclarativeScaffoldType = (typeof DECLARATIVE_SCAFFOLD_TYPES)[number];

export const PROGRAMMATIC_SCAFFOLD_TYPES = [
  'work-item-provider',
  'communication-provider',
  'model-provider',
  'agent-adapter',
  'tool',
] as const;
export type ProgrammaticScaffoldType = (typeof PROGRAMMATIC_SCAFFOLD_TYPES)[number];

export const SCAFFOLD_TYPES = [...DECLARATIVE_SCAFFOLD_TYPES, ...PROGRAMMATIC_SCAFFOLD_TYPES];

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

function titleCase(name: string): string {
  return name
    .split('-')
    .map((word) => (word[0]?.toUpperCase() ?? '') + word.slice(1))
    .join(' ');
}

interface ScaffoldFile {
  relPath: string;
  content: string;
}

// --- declarative bodies -------------------------------------------------------

function declarativeBody(
  type: DeclarativeScaffoldType,
  name: string,
): { dir: string; file: string; content: string } {
  const title = titleCase(name);
  switch (type) {
    case 'methodology':
      return {
        dir: 'methodologies',
        file: `${name}.yaml`,
        content: `id: ${name}
type: methodology
name: ${title}
description: >
  Describe the philosophy of this methodology: what it optimizes for and the
  habits it encourages.
category: delivery
recommendedAutonomyLevels: [2, 3]
useWhen:
  - Replace with situations where this methodology shines
avoidWhen:
  - Replace with situations where it gets in the way
defaultWorkflow: propose-patch
phases:
  - understand
  - implement
  - verify
riskProfile: medium
`,
      };
    case 'workflow':
      return {
        dir: 'workflows',
        file: `${name}.yaml`,
        content: `id: ${name}
type: workflow
name: ${title}
description: Describe when to use this workflow.
mode: standard
supportedAutonomyLevels: [2, 3]
phases:
  - id: analyze
    name: Analyze
    type: assistant_interaction
    role: reviewer
    modifiesFiles: false
  - id: patch
    name: Patch
    type: patch_generation
    role: implementer
    modifiesFiles: false
    output: diff.patch
  - id: verify
    name: Verify
    type: command_group
    optional: true
    commandsFromConfig: true
  - id: summarize
    name: Summarize
    type: agent_output
    output: summary.md
`,
      };
    case 'question-pack':
      return {
        dir: 'question-packs',
        file: `${name}.yaml`,
        content: `id: ${name}
type: question_pack
name: ${title}
questions:
  - id: problem
    text: What problem are we trying to solve?
  - id: success
    text: How will we know it worked?
  - id: risks
    text: What risks or unknowns remain?
`,
      };
    case 'prompt-template':
      return {
        dir: 'prompts',
        file: `${name}.md`,
        content: `---
type: prompt_template
id: ${name}
name: ${title}
---

You are an Excalibur assistant. Replace this template body with the prompt
you want to reuse. Variables use the {{task}} placeholder syntax.
`,
      };
    case 'artifact-template':
      return {
        dir: 'artifacts',
        file: `${name}.md`,
        content: `---
type: artifact_template
id: ${name}
name: ${title}
---

# {{title}}

## Summary

{{summary}}

## Details

{{details}}
`,
      };
    case 'policy-preset':
      return {
        dir: 'policies',
        file: `${name}.yaml`,
        content: `id: ${name}
type: policy_preset
name: ${title}
rules:
  - id: protect-secrets
    when:
      action: write
      filePathMatches:
        - "**/secrets/**"
        - ".env"
        - ".env.*"
    decision: require_approval
`,
      };
    case 'model-routing':
      return {
        dir: 'models',
        file: `${name}.yaml`,
        content: `id: ${name}
type: model_routing
name: ${title}
default: mock
byRole:
  planner: mock
  implementer: mock
  reviewer: mock
`,
      };
    case 'report-template':
      return {
        dir: 'reports',
        file: `${name}.yaml`,
        content: `id: ${name}
type: report_template
name: ${title}
sections:
  - Completed
  - In progress
  - Blocked
  - Next
`,
      };
    case 'role-definition':
      return {
        dir: 'roles',
        file: `${name}.yaml`,
        content: `id: ${name}
type: role_definition
name: ${title}
description: Describe what this agent role is responsible for.
`,
      };
    case 'command-mapping':
      return {
        dir: 'command-mappings',
        file: `${name}.yaml`,
        content: `id: ${name}
type: command_mapping
commands:
  - trigger: "@excalibur ${name}"
    action: interaction
    defaults:
      autonomyLevel: 0
`,
      };
  }
}

const CONTRIBUTES_KEY: Record<DeclarativeScaffoldType, string> = {
  methodology: 'methodologies',
  workflow: 'workflows',
  'question-pack': 'questionPacks',
  'prompt-template': 'promptTemplates',
  'artifact-template': 'artifactTemplates',
  'policy-preset': 'policyPresets',
  'model-routing': 'modelRouting',
  'report-template': 'reportTemplates',
  'role-definition': 'roleDefinitions',
  'command-mapping': 'commandMappings',
};

function declarativeScaffold(type: DeclarativeScaffoldType, name: string): ScaffoldFile[] {
  const body = declarativeBody(type, name);
  const title = titleCase(name);
  const manifest = `id: ${name}
name: ${title}
version: 0.1.0
kind: declarative
description: ${title} — a declarative Excalibur extension (no code).
contributes:
  ${CONTRIBUTES_KEY[type]}:
    - ./${body.dir}/${body.file}
`;
  const readme = `# ${title}

A declarative Excalibur extension contributing one ${type.replace(/-/g, ' ')}.

Declarative extensions are YAML/Markdown only — safe, portable and
Git-versionable. No code runs.

## Try it

\`\`\`bash
excalibur extensions validate
excalibur extensions list
\`\`\`

Edit \`${body.dir}/${body.file}\` and re-run \`excalibur extensions validate\`.
`;
  return [
    { relPath: 'excalibur.extension.yaml', content: manifest },
    { relPath: `${body.dir}/${body.file}`, content: body.content },
    { relPath: 'README.md', content: readme },
  ];
}

// --- programmatic bodies --------------------------------------------------------

interface ProgrammaticTemplate {
  contributesKey: string;
  capabilities: string[];
  indexTs: string;
}

function programmaticTemplate(type: ProgrammaticScaffoldType, name: string): ProgrammaticTemplate {
  const className = titleCase(name).replace(/\s+/g, '');
  switch (type) {
    case 'work-item-provider':
      return {
        contributesKey: 'workItemProviders',
        capabilities: ['work_items.read', 'work_items.comment'],
        indexTs: `import { defineExtension, type WorkItemProvider } from '@excalibur/extension-sdk';

class ${className}Provider implements Partial<WorkItemProvider> {
  readonly type = 'github_issues' as const;
  // Implement getWorkItem/listWorkItems/addComment/updateStatus/
  // linkPullRequest/validateCredentials against your tracker's API.
}

export default defineExtension({
  id: '${name}',
  name: '${titleCase(name)}',
  version: '0.1.0',
  register(ctx) {
    ctx.workItems.registerProvider(new ${className}Provider() as WorkItemProvider);
  },
});
`,
      };
    case 'communication-provider':
      return {
        contributesKey: 'communicationProviders',
        capabilities: ['communication.post'],
        indexTs: `import { defineExtension, type CommunicationProvider } from '@excalibur/extension-sdk';

class ${className}Provider implements Partial<CommunicationProvider> {
  readonly type = '${name}';
  // Implement postMessage/postThreadReply/getThreadReplies/validateCredentials.
}

export default defineExtension({
  id: '${name}',
  name: '${titleCase(name)}',
  version: '0.1.0',
  register(ctx) {
    ctx.communication.registerProvider(new ${className}Provider() as CommunicationProvider);
  },
});
`,
      };
    case 'model-provider':
      return {
        contributesKey: 'modelProviders',
        capabilities: ['models.chat'],
        indexTs: `import { defineExtension, type ModelProviderAdapter } from '@excalibur/extension-sdk';

class ${className}Adapter implements Partial<ModelProviderAdapter> {
  readonly name = '${name}';
  // Implement chat(input) and stream(input) against your model endpoint.
}

export default defineExtension({
  id: '${name}',
  name: '${titleCase(name)}',
  version: '0.1.0',
  register(ctx) {
    ctx.models.registerProvider(new ${className}Adapter() as ModelProviderAdapter);
  },
});
`,
      };
    case 'agent-adapter':
      return {
        contributesKey: 'agentAdapters',
        capabilities: ['tools.execute'],
        indexTs: `import { defineExtension, type AgentAdapter } from '@excalibur/extension-sdk';

class ${className}Adapter implements Partial<AgentAdapter> {
  readonly id = '${name}';
  readonly name = '${titleCase(name)}';
  readonly capabilities: string[] = [];
  // Implement detect() and run(input) to drive your coding agent.
}

export default defineExtension({
  id: '${name}',
  name: '${titleCase(name)}',
  version: '0.1.0',
  register(ctx) {
    ctx.agents.registerAdapter(new ${className}Adapter() as AgentAdapter);
  },
});
`,
      };
    case 'tool':
      return {
        contributesKey: 'tools',
        capabilities: ['tools.execute'],
        indexTs: `import { defineExtension, type AgentTool, type ToolContext, type ToolResult } from '@excalibur/extension-sdk';

const ${className.charAt(0).toLowerCase() + className.slice(1)}Tool: AgentTool = {
  name: '${name}',
  description: 'Describe what this tool does for the agent.',
  inputSchema: { type: 'object', properties: { input: { type: 'string' } } },
  async execute(_input: unknown, _context: ToolContext): Promise<ToolResult> {
    return { success: true, output: 'Implement the tool behavior here.' };
  },
};

export default defineExtension({
  id: '${name}',
  name: '${titleCase(name)}',
  version: '0.1.0',
  register(ctx) {
    ctx.tools.registerTool(${className.charAt(0).toLowerCase() + className.slice(1)}Tool);
  },
});
`,
      };
  }
}

function programmaticScaffold(type: ProgrammaticScaffoldType, name: string): ScaffoldFile[] {
  const title = titleCase(name);
  const template = programmaticTemplate(type, name);
  const manifest = `id: ${name}
name: ${title}
version: 0.1.0
kind: programmatic
description: ${title} — a programmatic Excalibur extension (TypeScript SDK).
entrypoint: dist/index.js
contributes:
  ${template.contributesKey}:
    - ${name}
capabilities:
${template.capabilities.map((capability) => `  - ${capability}`).join('\n')}
permissions:
  network:
    allowedHosts: []
  secrets:
    env: []
`;
  const packageJson = `{
  "name": "${name}",
  "version": "0.1.0",
  "private": true,
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@excalibur/extension-sdk": "^0.1.0"
  },
  "devDependencies": {
    "typescript": "~5.8.0"
  }
}
`;
  const tsconfig = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "strict": true,
    "declaration": false,
    "outDir": "dist",
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
`;
  const readme = `# ${title}

A programmatic Excalibur extension (${type.replace(/-/g, ' ')}) built with the
TypeScript Extension SDK.

Programmatic extensions connect Excalibur to the outside world. They run code
and therefore declare permissions in \`excalibur.extension.yaml\`.

## Build

Excalibur loads the COMPILED entrypoint (\`dist/index.js\`):

\`\`\`bash
npm install
npm run build
excalibur extensions validate
excalibur extensions doctor   # flags the entrypoint until you build
\`\`\`
`;
  return [
    { relPath: 'excalibur.extension.yaml', content: manifest },
    { relPath: 'package.json', content: packageJson },
    { relPath: 'tsconfig.json', content: tsconfig },
    { relPath: 'src/index.ts', content: template.indexTs },
    { relPath: 'README.md', content: readme },
  ];
}

// --- public API -------------------------------------------------------------------

export interface ScaffoldResult {
  dir: string;
  files: string[];
  kind: 'declarative' | 'programmatic';
}

/** Scaffolds an extension under `<targetDir>/<name>/`; throws on conflicts. */
export function scaffoldExtension(targetDir: string, type: string, name: string): ScaffoldResult {
  if (!NAME_PATTERN.test(name)) {
    throw new CliUsageError(
      `Extension names use lowercase letters, digits and dashes and start with a letter (got "${name}").`,
    );
  }
  const declarative = (DECLARATIVE_SCAFFOLD_TYPES as readonly string[]).includes(type);
  const programmatic = (PROGRAMMATIC_SCAFFOLD_TYPES as readonly string[]).includes(type);
  if (!declarative && !programmatic) {
    throw new CliUsageError(
      `Unknown extension type "${type}". Available: ${SCAFFOLD_TYPES.join(', ')}.`,
    );
  }

  const dir = join(targetDir, name);
  if (existsSync(dir)) {
    throw new CliUsageError(`Directory already exists: ${dir}`);
  }

  const files = declarative
    ? declarativeScaffold(type as DeclarativeScaffoldType, name)
    : programmaticScaffold(type as ProgrammaticScaffoldType, name);

  for (const file of files) {
    const filePath = join(dir, file.relPath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, file.content, 'utf8');
  }

  return {
    dir,
    files: files.map((file) => file.relPath),
    kind: declarative ? 'declarative' : 'programmatic',
  };
}
