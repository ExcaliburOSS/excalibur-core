import { globFiles } from './internal/fs-utils';
import { detectStack } from './stack';
import type { RepoPatterns } from './types';

const TEST_DIR_NAMES: ReadonlySet<string> = new Set(['test', 'tests', '__tests__', 'spec']);
const API_DIR_NAMES: ReadonlySet<string> = new Set(['api', 'routes', 'controllers']);
const SENSITIVE_DIR_NAMES: ReadonlySet<string> = new Set([
  'auth',
  'authentication',
  'billing',
  'payments',
  'payment',
  'secrets',
  'security',
  'credentials',
]);

/** `src/` children that are infrastructure rather than domain modules. */
const NON_DOMAIN_DIR_NAMES: ReadonlySet<string> = new Set([
  ...TEST_DIR_NAMES,
  ...API_DIR_NAMES,
  'components',
  'pages',
  'views',
  'assets',
  'styles',
  'public',
  'utils',
  'util',
  'helpers',
  'lib',
  'libs',
  'common',
  'shared',
  'core',
  'config',
  'constants',
  'middleware',
  'middlewares',
  'interceptors',
  'guards',
  'decorators',
  'filters',
  'pipes',
  'dto',
  'dtos',
  'types',
  'interfaces',
  'migrations',
]);

const BACKEND_FRAMEWORKS: ReadonlySet<string> = new Set([
  'nestjs',
  'express',
  'fastify',
  'prisma',
]);
const FRONTEND_FRAMEWORKS: ReadonlySet<string> = new Set([
  'react',
  'vue',
  'next',
  'nuxt',
  'svelte',
  'angular',
]);

function baseName(dirPath: string): string {
  return dirPath.split('/').pop() ?? dirPath;
}

/**
 * Detects structural patterns: backend/frontend split, test directories,
 * database migrations, API layer, domain modules and security-sensitive
 * paths (auth/billing/payments/secrets directories plus `.env*` files).
 */
export async function detectPatterns(dir: string): Promise<RepoPatterns> {
  const [allDirs, envFiles, stack] = await Promise.all([
    globFiles(dir, ['**'], { onlyDirectories: true, deep: 3 }),
    globFiles(dir, ['.env*', '*/.env*'], { deep: 2 }),
    detectStack(dir),
  ]);

  const testDirs = allDirs.filter((d) => TEST_DIR_NAMES.has(baseName(d)));
  const migrationDirs = allDirs.filter((d) => baseName(d) === 'migrations');
  const apiDirs = allDirs.filter((d) => API_DIR_NAMES.has(baseName(d)));
  const sensitiveDirs = allDirs.filter((d) => SENSITIVE_DIR_NAMES.has(baseName(d)));
  const domainDirs = allDirs.filter((d) => {
    const segments = d.split('/');
    return (
      segments.length === 2 &&
      segments[0] === 'src' &&
      !NON_DOMAIN_DIR_NAMES.has(segments[1] ?? '')
    );
  });

  const hasBackend =
    stack.frameworks.some((f) => BACKEND_FRAMEWORKS.has(f)) ||
    apiDirs.length > 0 ||
    migrationDirs.length > 0;
  const hasFrontend =
    stack.frameworks.some((f) => FRONTEND_FRAMEWORKS.has(f)) ||
    allDirs.some((d) => ['components', 'pages', 'views'].includes(baseName(d)));

  return {
    hasBackend,
    hasFrontend,
    testDirs,
    migrationDirs,
    apiDirs,
    domainDirs,
    sensitivePaths: [...sensitiveDirs, ...envFiles].sort(),
  };
}
