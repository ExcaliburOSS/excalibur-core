import { PERMISSION_CATEGORIES, type ExtensionManifest } from './manifest';

/**
 * Permission validation (extensions spec §8). M1 validates manifests and
 * returns human-readable warnings; strict enforcement arrives with the
 * Enterprise permission engine in M5.
 */

const KNOWN_CATEGORIES = new Set<string>(PERMISSION_CATEGORIES);
const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Validate the permission declarations of a manifest. Returns warnings (never
 * throws): suspicious or overly broad declarations, unknown categories,
 * declarative extensions declaring permissions, and programmatic extensions
 * declaring capabilities without backing permissions.
 */
export function validatePermissions(manifest: ExtensionManifest): string[] {
  const warnings: string[] = [];
  const permissions = manifest.permissions;

  if (manifest.kind === 'declarative' && permissions !== undefined) {
    warnings.push(
      `Extension '${manifest.id}' is declarative but declares permissions — ` +
        'declarative extensions run no code, so permissions have no effect.',
    );
  }

  if (
    manifest.kind !== 'declarative' &&
    permissions === undefined &&
    (manifest.capabilities?.length ?? 0) > 0
  ) {
    warnings.push(
      `Extension '${manifest.id}' declares capabilities (${(manifest.capabilities ?? []).join(', ')}) ` +
        'but no permissions — declare the network/filesystem/secrets access it needs; ' +
        'undeclared access will be denied when enforcement lands (M5).',
    );
  }

  if (permissions === undefined) {
    return warnings;
  }

  for (const category of Object.keys(permissions)) {
    if (!KNOWN_CATEGORIES.has(category)) {
      warnings.push(
        `Extension '${manifest.id}' declares unknown permission category '${category}' — ` +
          `expected one of: ${PERMISSION_CATEGORIES.join(', ')}.`,
      );
    }
  }

  for (const host of permissions.network?.allowedHosts ?? []) {
    if (host === '*' || host.includes('*')) {
      warnings.push(
        `Extension '${manifest.id}' requests wildcard network access ('${host}') — ` +
          'prefer listing explicit hosts.',
      );
    }
  }

  for (const pattern of permissions.filesystem?.write ?? []) {
    if (!isScopedToExcaliburDir(pattern)) {
      warnings.push(
        `Extension '${manifest.id}' requests filesystem write access outside .excalibur/ ` +
          `('${pattern}') — broad write access is high-risk and will require approval (M5).`,
      );
    }
  }

  // READ scopes are validated too: an extension may legitimately read repo
  // files, but absolute paths, home-dir (`~`), parent-escapes (`..`) and
  // root-level wildcards can exfiltrate credentials (e.g. ~/.ssh, ~/.aws,
  // /etc) and must be flagged.
  for (const pattern of permissions.filesystem?.read ?? []) {
    if (isHighRiskReadPattern(pattern)) {
      warnings.push(
        `Extension '${manifest.id}' requests high-risk filesystem read access ('${pattern}') — ` +
          'reads outside the workspace (absolute, ~, .. or root-level wildcards) can exfiltrate ' +
          'credentials and will require approval (M5); scope reads to repo-relative paths.',
      );
    }
  }

  for (const envName of permissions.secrets?.env ?? []) {
    if (!ENV_VAR_NAME_PATTERN.test(envName)) {
      warnings.push(
        `Extension '${manifest.id}' declares secrets.env entry '${envName}' which does not look ` +
          'like an environment variable name (expected UPPER_SNAKE_CASE) — never put secret values in manifests.',
      );
    }
  }

  for (const command of permissions.process?.allowedCommands ?? []) {
    if (command === '*' || command.includes('*')) {
      warnings.push(
        `Extension '${manifest.id}' requests wildcard process execution ('${command}') — ` +
          'prefer listing explicit commands.',
      );
    }
  }

  return warnings;
}

/**
 * Project policy that turns the soft warnings above into HARD blocks (M5
 * enforcement). Sourced from `config.extensions`. Default (no policy / enforce
 * off) preserves the warn-only behavior.
 */
export interface ExtensionPolicy {
  /** When true, a manifest with any violation is REFUSED (code never runs). */
  enforce: boolean;
  /** If set, ONLY these capabilities are allowed (allowlist). */
  allowedCapabilities?: ReadonlyArray<string>;
  /** Capabilities that are always refused (denylist; wins over the allowlist). */
  deniedCapabilities?: ReadonlyArray<string>;
  /** Pin extensions to exact versions by id; a drift is a violation. */
  locks?: Readonly<Record<string, string>>;
}

/**
 * Hard policy violations for a manifest (empty = allowed). These are the
 * security-relevant subset of {@link validatePermissions} promoted to blocking,
 * PLUS the capability allow/deny lists. The loader calls this BEFORE requiring a
 * programmatic extension's entrypoint, so a blocked extension's code never runs.
 */
export function enforcePermissions(manifest: ExtensionManifest, policy: ExtensionPolicy): string[] {
  const violations: string[] = [];
  const capabilities = manifest.capabilities ?? [];

  for (const cap of capabilities) {
    if (policy.deniedCapabilities?.includes(cap)) {
      violations.push(`capability '${cap}' is denied by the project extension policy`);
    } else if (
      policy.allowedCapabilities !== undefined &&
      !policy.allowedCapabilities.includes(cap)
    ) {
      violations.push(`capability '${cap}' is not in the project's allowed-capabilities list`);
    }
  }

  const permissions = manifest.permissions;
  if (permissions !== undefined) {
    for (const host of permissions.network?.allowedHosts ?? []) {
      if (host === '*' || host.includes('*')) {
        violations.push(`wildcard network access ('${host}') is not allowed`);
      }
    }
    for (const pattern of permissions.filesystem?.write ?? []) {
      if (!isScopedToExcaliburDir(pattern)) {
        violations.push(`filesystem write outside .excalibur/ ('${pattern}') is not allowed`);
      }
    }
    for (const pattern of permissions.filesystem?.read ?? []) {
      if (isHighRiskReadPattern(pattern)) {
        violations.push(`high-risk filesystem read ('${pattern}') is not allowed`);
      }
    }
    for (const command of permissions.process?.allowedCommands ?? []) {
      if (command === '*' || command.includes('*')) {
        violations.push(`wildcard process execution ('${command}') is not allowed`);
      }
    }
  }

  return violations;
}

/** Returns a lock-violation reason if the manifest's version drifts from the lock, else null. */
export function checkVersionLock(
  manifest: ExtensionManifest,
  locks: Readonly<Record<string, string>> | undefined,
): string | null {
  const pinned = locks?.[manifest.id];
  if (pinned !== undefined && pinned !== manifest.version) {
    return `version ${manifest.version} does not match the locked version ${pinned}`;
  }
  return null;
}

function isScopedToExcaliburDir(pattern: string): boolean {
  const normalized = pattern.replace(/^\.\//, '');
  return normalized === '.excalibur' || normalized.startsWith('.excalibur/');
}

/**
 * A read pattern is high-risk if it can reach outside the repository working
 * directory: absolute (`/etc/...`), home-relative (`~/.ssh`), a parent escape
 * (`../`), or a root-level wildcard that would match the whole filesystem
 * (`*`, `**`, `/**`).
 */
function isHighRiskReadPattern(pattern: string): boolean {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('~')) {
    return true; // absolute or home-dir
  }
  // A `..` segment anywhere lets the glob climb out of the workspace.
  if (/(^|\/)\.\.(\/|$)/.test(trimmed)) {
    return true;
  }
  // Bare top-level wildcards match everything under the cwd.
  if (trimmed === '*' || trimmed === '**' || trimmed === '**/*') {
    return true;
  }
  return false;
}
