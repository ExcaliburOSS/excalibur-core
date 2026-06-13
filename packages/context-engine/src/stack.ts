import { globFiles } from './internal/fs-utils';
import { readPackageJson, type PackageJsonInfo } from './internal/package-json';
import type { DetectedStack, PackageManager } from './types';

/** Lockfile → package manager, in priority order (oss-spec §5). */
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/** Dependency name → framework label, in stable output order. */
const FRAMEWORK_DEPENDENCIES: ReadonlyArray<readonly [string, string]> = [
  ['@nestjs/core', 'nestjs'],
  ['@nestjs/common', 'nestjs'],
  ['next', 'next'],
  ['nuxt', 'nuxt'],
  ['nuxt3', 'nuxt'],
  ['@angular/core', 'angular'],
  ['vue', 'vue'],
  ['react', 'react'],
  ['svelte', 'svelte'],
  ['express', 'express'],
  ['fastify', 'fastify'],
  ['@prisma/client', 'prisma'],
  ['prisma', 'prisma'],
  ['vite', 'vite'],
];

/** Config-file marker → framework label (onboarding-core.md §1 additions). */
const FRAMEWORK_FILE_MARKERS: ReadonlyArray<readonly [string, string]> = [
  ['nest-cli.json', 'nestjs'],
  ['next.config.{js,mjs,ts}', 'next'],
  ['nuxt.config.{js,mjs,ts}', 'nuxt'],
  ['angular.json', 'angular'],
  ['vite.config.{js,mjs,ts,mts}', 'vite'],
  ['prisma/schema.prisma', 'prisma'],
];

/** Language marker files (oss-spec §5 / contract §4.5 detection sources). */
const LANGUAGE_FILE_MARKERS: ReadonlyArray<readonly [string, string[]]> = [
  ['typescript', ['tsconfig.json', 'tsconfig.base.json']],
  ['python', ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile']],
  ['go', ['go.mod']],
  ['rust', ['Cargo.toml']],
  ['java', ['pom.xml', 'build.gradle', 'build.gradle.kts']],
];

async function rootHas(dir: string, patterns: string[]): Promise<boolean> {
  const matches = await globFiles(dir, patterns, { deep: 2 });
  return matches.length > 0;
}

async function detectPackageManager(
  dir: string,
  pkg: PackageJsonInfo | null,
): Promise<PackageManager | null> {
  for (const [lockfile, manager] of LOCKFILES) {
    if (await rootHas(dir, [lockfile])) {
      return manager;
    }
  }
  if (pkg?.packageManagerField) {
    const name = pkg.packageManagerField.split('@')[0] ?? '';
    if (PACKAGE_MANAGERS.has(name)) {
      return name as PackageManager;
    }
  }
  // A package.json without lockfile or packageManager field still implies a
  // Node project; npm is the only safe assumption.
  return pkg ? 'npm' : null;
}

async function detectLanguages(dir: string, pkg: PackageJsonInfo | null): Promise<string[]> {
  const languages: string[] = [];
  const hasTypescript =
    (await rootHas(dir, ['tsconfig.json', 'tsconfig.base.json'])) ||
    pkg?.dependencies['typescript'] !== undefined;
  if (hasTypescript) {
    languages.push('typescript');
  } else if (pkg) {
    languages.push('javascript');
  }
  for (const [language, markers] of LANGUAGE_FILE_MARKERS) {
    if (language === 'typescript') {
      continue;
    }
    if (await rootHas(dir, markers)) {
      languages.push(language);
    }
  }
  return languages;
}

async function detectFrameworks(dir: string, pkg: PackageJsonInfo | null): Promise<string[]> {
  const frameworks: string[] = [];
  const add = (framework: string): void => {
    if (!frameworks.includes(framework)) {
      frameworks.push(framework);
    }
  };
  if (pkg) {
    for (const [dependency, framework] of FRAMEWORK_DEPENDENCIES) {
      if (pkg.dependencies[dependency] !== undefined) {
        add(framework);
      }
    }
  }
  for (const [marker, framework] of FRAMEWORK_FILE_MARKERS) {
    if (frameworks.includes(framework)) {
      continue;
    }
    if (await rootHas(dir, [marker])) {
      add(framework);
    }
  }
  return frameworks;
}

/**
 * Detects languages, frameworks and the package manager of a repository
 * from file markers, lockfiles and package.json dependencies.
 */
export async function detectStack(dir: string): Promise<DetectedStack> {
  const pkg = await readPackageJson(dir);
  const [languages, frameworks, packageManager] = await Promise.all([
    detectLanguages(dir, pkg),
    detectFrameworks(dir, pkg),
    detectPackageManager(dir, pkg),
  ]);
  return { languages, frameworks, packageManager };
}
