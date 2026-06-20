import { createHash, createPublicKey, verify } from 'node:crypto';
import { REGISTRY_PUBKEY_FINGERPRINT, SIGNED_REGISTRY } from './registry-data';

/**
 * The curated, SIGNED MCP server registry (F6) — beats a plain directory by
 * carrying a cryptographic trust chain. A bundled snapshot of vetted servers is
 * Ed25519-SIGNED by the maintainer key; at load time we (1) confirm the snapshot's
 * embedded public key matches a fingerprint PINNED in this file (so the key can't
 * be swapped), then (2) verify the signature over the snapshot. A tampered
 * snapshot or a swapped key fails closed → no servers. `mcp add <name>` only ever
 * installs from the verified registry, with a trust score shown.
 */

export interface RegistryServer {
  name: string;
  description: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: ReadonlyArray<string>;
  url?: string;
  homepage?: string;
  /** `official` (vendor/maintainer-vetted) vs `community`. */
  trust: 'official' | 'community';
  /** 0–100 reputation score (curation signal). */
  trustScore: number;
}

export interface RegistryLoadResult {
  ok: boolean;
  servers: RegistryServer[];
  /** Why the registry failed to verify (empty when ok). */
  reason: string;
}

/**
 * Verifies + loads the bundled signed registry. Fails CLOSED (no servers) when
 * the pinned fingerprint or the signature does not check out.
 */
export function loadRegistry(): RegistryLoadResult {
  try {
    const { snapshot, signature, publicKeyPem } = SIGNED_REGISTRY;
    // 1. The embedded public key must match the fingerprint pinned in code.
    const fingerprint = createHash('sha256').update(publicKeyPem).digest('hex');
    if (fingerprint !== REGISTRY_PUBKEY_FINGERPRINT) {
      return { ok: false, servers: [], reason: 'registry public key fingerprint mismatch' };
    }
    // 2. The signature must verify over the exact snapshot (Ed25519).
    const key = createPublicKey(publicKeyPem);
    const canonical = JSON.stringify(snapshot);
    const valid = verify(
      null,
      Buffer.from(canonical, 'utf8'),
      key,
      Buffer.from(signature, 'base64'),
    );
    if (!valid) {
      return { ok: false, servers: [], reason: 'registry signature verification failed' };
    }
    return { ok: true, servers: snapshot.servers as unknown as RegistryServer[], reason: '' };
  } catch (error) {
    return {
      ok: false,
      servers: [],
      reason: `registry load error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Looks up a server by exact name in the verified registry (null if unverified/absent). */
export function lookupServer(name: string): RegistryServer | undefined {
  const reg = loadRegistry();
  if (!reg.ok) return undefined;
  return reg.servers.find((s) => s.name === name);
}

/** Searches the verified registry by name/description substring, ranked by trustScore. */
export function searchRegistry(query: string): RegistryServer[] {
  const reg = loadRegistry();
  if (!reg.ok) return [];
  const q = query.trim().toLowerCase();
  const matches =
    q.length === 0
      ? [...reg.servers]
      : reg.servers.filter(
          (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
        );
  return matches.sort((a, b) => b.trustScore - a.trustScore);
}

/**
 * Verifies an arbitrary signed snapshot (exported for tests + future re-signing).
 * Pure: confirms the signature over `JSON.stringify(snapshot)` with `publicKeyPem`.
 */
export function verifySignedSnapshot(
  snapshot: unknown,
  signatureB64: string,
  publicKeyPem: string,
): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    return verify(
      null,
      Buffer.from(JSON.stringify(snapshot), 'utf8'),
      key,
      Buffer.from(signatureB64, 'base64'),
    );
  } catch {
    return false;
  }
}

/** Converts a registry entry into an `mcp.servers.<name>` config block. */
export function registryServerToConfig(server: RegistryServer): Record<string, unknown> {
  if (server.transport === 'http') {
    return { url: server.url, trust: server.trust === 'official' ? 'prompt' : 'prompt' };
  }
  return {
    command: server.command,
    ...(server.args !== undefined ? { args: [...server.args] } : {}),
    trust: 'prompt',
  };
}
