import { minimatch } from 'minimatch';
import { assertResolvesToPublic } from '../permissions/ssrf-guard';
import type { PermissionEngine } from '../permissions/permission-engine';

/**
 * Per-MCP-server network sandbox (F6). A REMOTE server's endpoint must clear the
 * always-on SSRF floor AND the global network policy (via the shared
 * PermissionEngine), AND — when the server declares an `egress` allowlist — match
 * it. The async DNS re-resolution (`assertResolvesToPublic`) defeats DNS
 * rebinding: a host that resolves to a private address is denied even if it is
 * allowlisted (the SSRF floor is never overridable except by an explicit
 * `allowPrivateHosts` entry). Local stdio servers have no interceptable egress —
 * this guards the connect URL of remote (HTTP) servers.
 */

export interface McpServerEgress {
  allowedDomains?: ReadonlyArray<string>;
  allowPrivateHosts?: ReadonlyArray<string>;
}

export interface EgressVerdict {
  allowed: boolean;
  reason: string;
}

function hostOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '');
  } catch {
    return null;
  }
}

/**
 * Synchronously checks a remote MCP URL against the global policy + the server's
 * egress allowlist. (The async SSRF re-resolution is {@link assertServerEgress}.)
 */
export function checkServerEgress(
  url: string,
  engine: PermissionEngine,
  egress: McpServerEgress | undefined,
): EgressVerdict {
  const base = engine.checkUrl(url);
  if (!base.allowed) {
    return { allowed: false, reason: base.reason };
  }
  const host = hostOf(url);
  if (host === null) {
    return { allowed: false, reason: `Invalid MCP server URL: ${url}` };
  }
  // An explicit per-server allowlist further narrows what this server may reach.
  if (egress?.allowedDomains !== undefined && egress.allowedDomains.length > 0) {
    const ok = egress.allowedDomains.some((p) => minimatch(host, p, { dot: true }));
    if (!ok) {
      return { allowed: false, reason: `MCP server host "${host}" not in its egress allowlist.` };
    }
  }
  return { allowed: true, reason: 'Allowed by policy + server egress.' };
}

/**
 * Full egress gate for a remote MCP connect: the sync policy/allowlist check plus
 * the async DNS re-resolution (anti-rebinding). Hosts in `allowPrivateHosts` may
 * resolve privately; everything else must resolve to a public address.
 */
export async function assertServerEgress(
  url: string,
  engine: PermissionEngine,
  egress: McpServerEgress | undefined,
): Promise<EgressVerdict> {
  const sync = checkServerEgress(url, engine, egress);
  if (!sync.allowed) return sync;
  const host = hostOf(url);
  if (host === null) return { allowed: false, reason: `Invalid MCP server URL: ${url}` };
  const allowedPrivate = (egress?.allowPrivateHosts ?? []).some(
    (h) => h.toLowerCase() === host || minimatch(host, h, { dot: true }),
  );
  if (allowedPrivate) {
    return { allowed: true, reason: 'Allowed (explicit private host).' };
  }
  const resolved = await assertResolvesToPublic(host);
  return resolved.allowed
    ? { allowed: true, reason: 'Allowed (resolves public).' }
    : { allowed: false, reason: resolved.reason };
}
