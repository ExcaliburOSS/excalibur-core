import { describe, expect, it } from 'vitest';
import type { ExtensionManifest } from './manifest';
import { validatePermissions, enforcePermissions, checkVersionLock } from './permissions';

function programmaticManifest(overrides: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return {
    id: 'test-ext',
    name: 'Test extension',
    version: '0.1.0',
    kind: 'programmatic',
    entrypoint: 'dist/index.js',
    ...overrides,
  };
}

describe('validatePermissions', () => {
  it('returns no warnings for the well-formed Linear example from the spec', () => {
    const warnings = validatePermissions(
      programmaticManifest({
        id: 'linear',
        capabilities: ['work_items.read', 'work_items.comment'],
        permissions: { network: { allowedHosts: ['api.linear.app'] } },
      }),
    );
    expect(warnings).toEqual([]);
  });

  it('returns no warnings for a declarative extension without permissions', () => {
    const warnings = validatePermissions({
      id: 'discovery-pack',
      name: 'Discovery Pack',
      version: '0.1.0',
      kind: 'declarative',
    });
    expect(warnings).toEqual([]);
  });

  it('warns when a declarative extension declares permissions', () => {
    const warnings = validatePermissions({
      id: 'pack',
      name: 'Pack',
      version: '0.1.0',
      kind: 'declarative',
      permissions: { network: { allowedHosts: ['example.com'] } },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('declarative');
  });

  it('warns when a programmatic extension declares capabilities but no permissions', () => {
    const warnings = validatePermissions(
      programmaticManifest({ capabilities: ['work_items.read'] }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('no permissions');
  });

  it('does not warn for a programmatic extension with neither capabilities nor permissions', () => {
    expect(validatePermissions(programmaticManifest())).toEqual([]);
  });

  it('warns about wildcard network hosts', () => {
    const warnings = validatePermissions(
      programmaticManifest({ permissions: { network: { allowedHosts: ['*', '*.example.com'] } } }),
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('wildcard network access');
  });

  it('warns about filesystem writes outside .excalibur/, but not inside', () => {
    const warnings = validatePermissions(
      programmaticManifest({
        permissions: {
          filesystem: {
            read: ['src/**'],
            write: ['.excalibur/runs/**', 'src/**', '**'],
          },
        },
      }),
    );
    expect(warnings).toHaveLength(2);
    expect(warnings.join('\n')).toContain("'src/**'");
    expect(warnings.join('\n')).toContain("'**'");
    expect(warnings.join('\n')).not.toContain('.excalibur/runs/**');
  });

  it('warns about secrets.env entries that are not env var names', () => {
    const warnings = validatePermissions(
      programmaticManifest({
        permissions: { secrets: { env: ['LINEAR_API_KEY', 'sk-live-actual-secret'] } },
      }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('sk-live-actual-secret');
  });

  it('warns about unknown permission categories', () => {
    const warnings = validatePermissions(
      programmaticManifest({
        permissions: { telepathy: { read: true } } as ExtensionManifest['permissions'],
      }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("'telepathy'");
  });

  it('warns about wildcard process commands', () => {
    const warnings = validatePermissions(
      programmaticManifest({ permissions: { process: { allowedCommands: ['*'] } } }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('process execution');
  });
});

describe('enforcePermissions (P2.18 hard-block)', () => {
  it('allows a well-scoped manifest', () => {
    expect(
      enforcePermissions(
        programmaticManifest({
          capabilities: ['work_items.read'],
          permissions: { network: { allowedHosts: ['api.linear.app'] } },
        }),
        { enforce: true },
      ),
    ).toEqual([]);
  });

  it('blocks a denied capability and one not on the allowlist', () => {
    const denied = enforcePermissions(programmaticManifest({ capabilities: ['secrets.read'] }), {
      enforce: true,
      deniedCapabilities: ['secrets.read'],
    });
    expect(denied.some((v) => v.includes('denied'))).toBe(true);

    const notAllowed = enforcePermissions(
      programmaticManifest({ capabilities: ['work_items.read'] }),
      { enforce: true, allowedCapabilities: ['process.run'] },
    );
    expect(notAllowed.some((v) => v.includes('not in the project'))).toBe(true);
  });

  it('blocks wildcard network, write-outside-.excalibur and wildcard exec', () => {
    const v = enforcePermissions(
      programmaticManifest({
        permissions: {
          network: { allowedHosts: ['*'] },
          filesystem: { write: ['/etc/passwd'] },
          process: { allowedCommands: ['*'] },
        },
      }),
      { enforce: true },
    );
    expect(v).toHaveLength(3);
  });
});

describe('checkVersionLock', () => {
  it('flags a version drift and passes a matching/absent lock', () => {
    const m = programmaticManifest({ id: 'pinme', version: '1.2.0' });
    expect(checkVersionLock(m, { pinme: '1.1.0' })).toMatch(/does not match/);
    expect(checkVersionLock(m, { pinme: '1.2.0' })).toBeNull();
    expect(checkVersionLock(m, undefined)).toBeNull();
    expect(checkVersionLock(m, { other: '9.9.9' })).toBeNull();
  });
});
