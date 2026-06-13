import { scanInstructionSources, skillsFromSources } from '@excalibur/context-engine';
import type { DetectedSkill, InstructionSource } from '@excalibur/shared';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';
import { configuredEnabled } from './config-file';

/**
 * Instruction/Skill Discovery helpers shared by the `instructions` and
 * `skills` command groups (ISD spec §7): scan results merged with the
 * enablement state persisted in `.excalibur/config.yaml`.
 */

export async function scanSources(deps: CliDeps, repoRoot: string): Promise<InstructionSource[]> {
  const sources = await scanInstructionSources({
    repoRoot,
    homeDir: deps.homeDir(),
    includeUserGlobal: deps.includeUserGlobal,
  });
  return sources.map((source) => {
    const configured = configuredEnabled(repoRoot, 'instructions', source.path);
    return configured === undefined ? source : { ...source, enabled: configured };
  });
}

export async function scanSkills(deps: CliDeps, repoRoot: string): Promise<DetectedSkill[]> {
  const sources = await scanInstructionSources({
    repoRoot,
    homeDir: deps.homeDir(),
    includeUserGlobal: deps.includeUserGlobal,
  });
  const skills = await skillsFromSources(sources);
  return skills.map((skill) => {
    const configured = configuredEnabled(repoRoot, 'skills', skill.path);
    return configured === undefined ? skill : { ...skill, enabled: configured };
  });
}

export function findSourceById(sources: InstructionSource[], id: string): InstructionSource {
  const found = sources.find((source) => source.id === id);
  if (found === undefined) {
    const known = sources.map((source) => source.id).join(', ') || '(none detected)';
    throw new CliUsageError(
      `Unknown instruction source "${id}". Detected sources: ${known}. Run \`excalibur instructions scan\` to list them.`,
      { id },
    );
  }
  return found;
}

export function findSkillById(skills: DetectedSkill[], id: string): DetectedSkill {
  const found = skills.find((skill) => skill.id === id);
  if (found === undefined) {
    const known = skills.map((skill) => skill.id).join(', ') || '(none detected)';
    throw new CliUsageError(
      `Unknown skill "${id}". Detected skills: ${known}. Run \`excalibur skills list\` to list them.`,
      { id },
    );
  }
  return found;
}

/** ISD spec §7: user-global trust renders as `trusted-local` in tables. */
export function displayTrust(source: Pick<InstructionSource, 'scope' | 'trustLevel'>): string {
  if (source.scope === 'user_global' && source.trustLevel === 'trusted') {
    return 'trusted-local';
  }
  return source.trustLevel;
}
