import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * SSRF guard — the always-on safety floor for agent network egress.
 *
 * It NEVER blocks the public web; it blocks targets that let an agent reach
 * INTERNAL/private services (the classic exfiltration + cloud-metadata vector):
 * loopback, RFC1918, link-local (incl. `169.254.169.254`), unique-local IPv6,
 * IPv4-mapped IPv6, numeric/obfuscated host encodings, and non-http(s) schemes.
 *
 * Two layers, because DNS rebinding can flip a public name to a private IP
 * between check and connect:
 *  1. {@link inspectUrl} + {@link isBlockedHostname}/{@link isBlockedIp} — sync,
 *     pre-DNS (scheme + literal-IP + obvious-private-host). Used by the pure
 *     `PermissionEngine.checkUrl`.
 *  2. {@link assertResolvesToPublic} — async, resolves A/AAAA and re-checks every
 *     address. Run by the fetch executor right before connecting (and after each
 *     redirect).
 */

export type UrlInspection = { url: URL } | { error: string };

/** Parse + scheme check. Only `http:`/`https:` are ever allowed. */
export function inspectUrl(rawUrl: string): UrlInspection {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { error: `Invalid URL: ${rawUrl}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: `Blocked URL scheme "${url.protocol}" (only http/https allowed).` };
  }
  if (url.hostname.length === 0) {
    return { error: 'URL has no host.' };
  }
  return { url };
}

const BLOCKED_HOST_SUFFIXES = ['.local', '.internal', '.localhost'];
const BLOCKED_HOST_EXACT = new Set(['localhost', 'metadata.google.internal', 'metadata']);

/**
 * Blocks hostnames that name an internal target or that use numeric/obfuscated
 * encodings (decimal `2130706433`, hex `0x7f000001`, octal `0177.0.0.1`) — all
 * classic SSRF bypasses for `127.0.0.1` that `new URL()` does NOT normalize.
 */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOST_EXACT.has(host)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) return true;
  // Pure-decimal, hex (0x…) or dotted-octal hosts are obfuscated IPs → block.
  if (/^\d+$/.test(host)) return true;
  if (/^0x[0-9a-f]+$/i.test(host)) return true;
  if (/^0[0-7]+(\.[0-7]+)*$/.test(host)) return true;
  return false;
}

function ipv4Blocked(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // malformed → fail closed
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 (incl unspecified)
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 255 && b === 255) return true; // broadcast-ish
  return false;
}

function ipv6Blocked(ip: string): boolean {
  const addr = ip.toLowerCase().split('%')[0] ?? ip.toLowerCase(); // strip zone id
  if (addr === '::1' || addr === '::') return true; // loopback / unspecified
  if (
    addr.startsWith('fe8') ||
    addr.startsWith('fe9') ||
    addr.startsWith('fea') ||
    addr.startsWith('feb')
  )
    return true; // fe80::/10 link-local
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // fc00::/7 ULA
  // IPv4-mapped (::ffff:a.b.c.d) → unwrap and re-check the v4.
  const mapped = /::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr);
  if (mapped?.[1] !== undefined) return ipv4Blocked(mapped[1]);
  return false;
}

/** True if a literal IP address belongs to a blocked (private/internal) range. */
export function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return ipv4Blocked(ip);
  if (kind === 6) return ipv6Blocked(ip);
  return true; // not a valid IP literal → fail closed
}

export type UrlVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * Async layer: resolve the host's A/AAAA records and fail closed if ANY resolved
 * address is private/internal (defeats DNS rebinding). Run by the fetch executor
 * just before connecting; on each redirect too.
 */
export async function assertResolvesToPublic(rawHostname: string): Promise<UrlVerdict> {
  const hostname = rawHostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  // A literal IP needs no DNS — check it directly.
  if (isIP(hostname) !== 0) {
    return isBlockedIp(hostname)
      ? {
          allowed: false,
          reason: `Host ${hostname} resolves to a blocked (private/internal) address.`,
        }
      : { allowed: true };
  }
  if (isBlockedHostname(hostname)) {
    return { allowed: false, reason: `Host ${hostname} is an internal/obfuscated name.` };
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch (error) {
    return { allowed: false, reason: `DNS resolution failed for ${hostname}: ${String(error)}` };
  }
  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      return {
        allowed: false,
        reason: `Host ${hostname} resolves to a blocked address (${address}).`,
      };
    }
  }
  return { allowed: true };
}
