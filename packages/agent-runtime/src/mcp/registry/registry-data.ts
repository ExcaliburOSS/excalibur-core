// AUTO-GENERATED (F6) — the curated, Ed25519-SIGNED MCP server registry snapshot.
// The private key is NOT in this repo (held by the maintainer); only the signed
// snapshot + the public key ship. Integrity: the public key fingerprint is PINNED
// in registry.ts, and the signature is verified over the snapshot at load time.
export const SIGNED_REGISTRY = {
  snapshot: {
    version: 1,
    signedAt: '2026-06-21T00:00:00.000Z',
    servers: [
      {
        name: 'filesystem',
        description: 'Local filesystem access (read/write within allowed dirs).',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem'],
        homepage: 'https://github.com/modelcontextprotocol/servers',
        trust: 'official',
        trustScore: 95,
      },
      {
        name: 'git',
        description: 'Git repository inspection and operations.',
        transport: 'stdio',
        command: 'uvx',
        args: ['mcp-server-git'],
        homepage: 'https://github.com/modelcontextprotocol/servers',
        trust: 'official',
        trustScore: 92,
      },
      {
        name: 'fetch',
        description: 'Fetch a URL and return its content as markdown.',
        transport: 'stdio',
        command: 'uvx',
        args: ['mcp-server-fetch'],
        homepage: 'https://github.com/modelcontextprotocol/servers',
        trust: 'official',
        trustScore: 90,
      },
      {
        name: 'playwright',
        description: 'Drive a real browser (navigate, click, extract).',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
        homepage: 'https://github.com/microsoft/playwright-mcp',
        trust: 'official',
        trustScore: 93,
      },
      {
        name: 'github',
        description: 'GitHub repos, issues and PRs (remote, OAuth).',
        transport: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        homepage: 'https://github.com/github/github-mcp-server',
        trust: 'official',
        trustScore: 94,
      },
    ],
  },
  signature:
    'JYyEzp455Up3gF9Vm7WesJDJ3TiZdWNVBI/Z7aV1WGWrRgL4wb4Kfvc3JhUzFhbahi5/j+GtINsl7bwJtkVTCw==',
  publicKeyPem:
    '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAQE/k4e6mE/8Pjn1Oc3sZjAYGMf+Cuw0oEFA9/ySULWA=\n-----END PUBLIC KEY-----\n',
} as const;
export const REGISTRY_PUBKEY_FINGERPRINT =
  '2daad70967061d6144953d4548c3facc40dfd1f8b8df795814e359c448d9ecb8';
