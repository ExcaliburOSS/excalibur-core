import { describe, expect, it } from 'vitest';
import { DEFAULT_ALLOWED_COMMANDS, DEFAULT_BLOCKED_PATHS } from '@excalibur/shared';
import { PermissionEngine, type PermissionDecision } from './permission-engine';

function expectAllowed(decision: PermissionDecision): void {
  expect(decision.allowed).toBe(true);
  expect(decision.requiresConfirmation).toBe(false);
  expect(decision.reason.length).toBeGreaterThan(0);
}

function expectAsk(decision: PermissionDecision): void {
  expect(decision.allowed).toBe(true);
  expect(decision.requiresConfirmation).toBe(true);
  expect(decision.reason.length).toBeGreaterThan(0);
}

function expectDenied(decision: PermissionDecision): void {
  expect(decision.allowed).toBe(false);
  expect(decision.requiresConfirmation).toBe(false);
  expect(decision.reason.length).toBeGreaterThan(0);
}

describe('PermissionEngine.checkPath', () => {
  it('blocks every DEFAULT_BLOCKED_PATHS pattern with dot:true matching', () => {
    const engine = new PermissionEngine();
    const blockedSamples = [
      '.env',
      '.env.production',
      'certs/server.pem',
      'config/signing.key',
      'src/secrets/token.ts',
      'home/.ssh/id_rsa',
      'node_modules/zod/index.js',
      'dist/index.js',
      'build/main.js',
    ];
    for (const sample of blockedSamples) {
      expectDenied(engine.checkPath(sample, 'read'));
      expectDenied(engine.checkPath(sample, 'write'));
    }
  });

  it('includes the matching blocked pattern in the reason', () => {
    const engine = new PermissionEngine();
    const decision = engine.checkPath('src/secrets/token.ts', 'read');
    expect(decision.reason).toContain('**/secrets/**');
    expect(decision.reason).toContain('src/secrets/token.ts');
  });

  it('allows reads and asks for writes by default on regular source files', () => {
    const engine = new PermissionEngine();
    expectAllowed(engine.checkPath('src/escrow/escrow.service.ts', 'read'));
    expectAsk(engine.checkPath('src/escrow/escrow.service.ts', 'write'));
  });

  it('matches dotfiles outside the blocklist as regular paths (dot:true does not over-block)', () => {
    const engine = new PermissionEngine();
    expectAllowed(engine.checkPath('.github/workflows/ci.yml', 'read'));
    expectAllowed(engine.checkPath('.eslintrc.json', 'read'));
  });

  it('normalizes leading ./ and windows separators before matching', () => {
    const engine = new PermissionEngine();
    expectDenied(engine.checkPath('./.env', 'read'));
    expectDenied(engine.checkPath('src\\secrets\\token.ts', 'read'));
    expectAllowed(engine.checkPath('./src/app.ts', 'read'));
  });

  it('denies the empty path', () => {
    expectDenied(new PermissionEngine().checkPath('', 'read'));
  });

  it('honors explicit tool flags: true allows, ask confirms, false denies', () => {
    const writeAllowed = new PermissionEngine({ tools: { write_file: true } });
    expectAllowed(writeAllowed.checkPath('src/app.ts', 'write'));

    const readAsk = new PermissionEngine({ tools: { read_file: 'ask' } });
    expectAsk(readAsk.checkPath('src/app.ts', 'read'));

    const readDenied = new PermissionEngine({ tools: { read_file: false } });
    expectDenied(readDenied.checkPath('src/app.ts', 'read'));

    const writeDenied = new PermissionEngine({ tools: { write_file: false } });
    expectDenied(writeDenied.checkPath('src/app.ts', 'write'));
  });

  it('blocked paths win over permissive tool flags', () => {
    const engine = new PermissionEngine({ tools: { read_file: true, write_file: true } });
    expectDenied(engine.checkPath('.env', 'read'));
    expectDenied(engine.checkPath('.env', 'write'));
  });

  it('an explicit blockedPaths list replaces the defaults', () => {
    const engine = new PermissionEngine({ blockedPaths: ['docs/**'] });
    expectDenied(engine.checkPath('docs/internal.md', 'read'));
    // `.env` is no longer blocked once the caller supplies its own list.
    expectAllowed(engine.checkPath('.env', 'read'));
  });

  it('merges partial tool overrides over the safe defaults', () => {
    const engine = new PermissionEngine({ tools: { write_file: true } });
    // read_file keeps its default (allowed) even though only write_file was set.
    expectAllowed(engine.checkPath('src/app.ts', 'read'));
    expectAllowed(engine.checkPath('src/app.ts', 'write'));
  });
});

describe('PermissionEngine.checkCommand', () => {
  it('asks for allowlisted commands by default (run_command defaults to "ask")', () => {
    const engine = new PermissionEngine();
    for (const command of DEFAULT_ALLOWED_COMMANDS) {
      expectAsk(engine.checkCommand(command));
    }
  });

  it('allows allowlisted commands without confirmation when run_command is true', () => {
    const engine = new PermissionEngine({ tools: { run_command: true } });
    expectAllowed(engine.checkCommand('npm test'));
    expectAllowed(engine.checkCommand('pnpm lint'));
  });

  it('asks for commands outside the allowlist even when run_command is true', () => {
    const engine = new PermissionEngine({ tools: { run_command: true } });
    const decision = engine.checkCommand('rm -rf /tmp/cache');
    expectAsk(decision);
    expect(decision.reason).toContain('allowlist');
  });

  it('denies every command when run_command is false', () => {
    const engine = new PermissionEngine({ tools: { run_command: false } });
    expectDenied(engine.checkCommand('npm test'));
    expectDenied(engine.checkCommand('echo hello'));
  });

  it('supports glob patterns in allowedCommands (minimatch)', () => {
    const engine = new PermissionEngine({
      tools: { run_command: true },
      allowedCommands: ['pnpm *'],
    });
    expectAllowed(engine.checkCommand('pnpm lint'));
    expectAllowed(engine.checkCommand('pnpm test'));
    expectAsk(engine.checkCommand('npm test'));
  });

  it('an explicit allowedCommands list replaces the defaults', () => {
    const engine = new PermissionEngine({
      tools: { run_command: true },
      allowedCommands: ['make check'],
    });
    expectAllowed(engine.checkCommand('make check'));
    expectAsk(engine.checkCommand('npm test'));
  });

  it('normalizes whitespace before matching the allowlist', () => {
    const engine = new PermissionEngine({ tools: { run_command: true } });
    expectAllowed(engine.checkCommand('  npm   test  '));
  });

  it('denies the empty command', () => {
    expectDenied(new PermissionEngine().checkCommand('   '));
  });
});

describe('PermissionEngine.checkTool', () => {
  it('applies the default safe flags from the shared config', () => {
    const engine = new PermissionEngine();
    expectAllowed(engine.checkTool('read_file'));
    expectAllowed(engine.checkTool('list_files'));
    expectAllowed(engine.checkTool('search_code'));
    expectAllowed(engine.checkTool('git_diff'));
    expectAsk(engine.checkTool('write_file'));
    expectAsk(engine.checkTool('apply_patch'));
    expectAsk(engine.checkTool('run_command'));
    expectAsk(engine.checkTool('create_branch'));
    expectAsk(engine.checkTool('run_tests'));
    expectDenied(engine.checkTool('network'));
  });

  it('defaults unknown tools to "ask"', () => {
    expectAsk(new PermissionEngine().checkTool('teleport'));
  });

  it('honors explicit overrides for any tool', () => {
    const engine = new PermissionEngine({ tools: { network: true, git_diff: false } });
    expectAllowed(engine.checkTool('network'));
    expectDenied(engine.checkTool('git_diff'));
  });
});

describe('PermissionEngine defaults wiring', () => {
  it('uses the shared DEFAULT_BLOCKED_PATHS when no permissions are given', () => {
    const engine = new PermissionEngine(undefined);
    // Spot-check one representative path per default pattern.
    expect(DEFAULT_BLOCKED_PATHS.length).toBeGreaterThan(0);
    expectDenied(engine.checkPath('.env', 'read'));
    expectDenied(engine.checkPath('nested/dir/secrets/value.json', 'read'));
  });
});
