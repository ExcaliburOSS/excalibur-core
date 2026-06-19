import { describe, expect, it } from 'vitest';
import { buildDockerArgs } from './docker-sandbox';

describe('buildDockerArgs', () => {
  it('isolates by default: ephemeral, no network, caps, repo mounted, no host env', () => {
    const args = buildDockerArgs('/repo', 'echo hi', 'c1', { memoryMb: 512, cpus: 1 });
    const s = args.join(' ');
    expect(args[0]).toBe('run');
    expect(args).toContain('--rm');
    // No network unless explicitly allowed.
    expect(s).toContain('--network none');
    // Real memory cap (no swap escape).
    expect(s).toContain('--memory 512m');
    expect(s).toContain('--memory-swap 512m');
    expect(s).toContain('--cpus 1');
    // Only the repo is mounted, at /work.
    expect(s).toContain('-v /repo:/work');
    expect(s).toContain('-w /work');
    // The command runs via the `sh` entrypoint with `-c <command>` as the tail.
    expect(args).toContain('--entrypoint');
    expect(args[args.indexOf('--entrypoint') + 1]).toBe('sh');
    expect(args.slice(-2)).toEqual(['-c', 'echo hi']);
    // The host environment is NEVER forwarded (no -e flags).
    expect(args).not.toContain('-e');
    // No host-path mounts other than the repo.
    expect(args.filter((a) => a === '-v')).toHaveLength(1);
  });

  it('opts into a bridge network only when explicitly allowed', () => {
    expect(buildDockerArgs('/repo', 'x', 'c', { allowNetwork: true }).join(' ')).toContain(
      '--network bridge',
    );
  });

  it('uses the given image (default Alpine otherwise)', () => {
    expect(buildDockerArgs('/repo', 'x', 'c', { image: 'node:24-alpine' })).toContain(
      'node:24-alpine',
    );
    expect(buildDockerArgs('/repo', 'x', 'c')).toContain('alpine:3');
  });
});
