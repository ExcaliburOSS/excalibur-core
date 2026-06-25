# Security Policy

Excalibur is an autonomous coding agent: it reads, edits, and runs commands in your
repository. We take the security of the tool — and of the machines it runs on —
seriously.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub's
[**Private Vulnerability Reporting**](https://github.com/ExcaliburOSS/excalibur-core/security/advisories/new)
("Report a vulnerability" under the repository's **Security** tab). This creates a
private advisory only you and the maintainers can see.

Please include:

- a description of the issue and its impact,
- the version (`excalibur --version`) and platform,
- steps to reproduce, and a proof of concept if you have one.

We aim to acknowledge a report within **5 business days** and to keep you updated as
we investigate and ship a fix. We will credit you in the advisory unless you ask us
not to.

## Scope

In scope: the published packages (`@excalibur-oss/excalibur`,
`@excalibur-oss/extension-sdk`) and this repository. Especially welcome:

- sandbox / permission-engine escapes (path traversal, the destructive-command
  floor, blocked-path bypass),
- SSRF / network-policy bypass in the web tools,
- secret leakage into events, artifacts, or model prompts,
- prompt-injection paths from fetched web content or MCP servers that lead to
  unintended command execution.

## Safety model (what protects you today)

Excalibur is local-first and asks before mutating, with hard floors that approval
cannot lift:

- **Permission engine** — read-only by default; every mutating tool/command is
  gated (`docs/security.md`).
- **Destructive-command floor** — `rm -rf`, force pushes, `git reset --hard`,
  `sudo`, `mkfs`, … are hard-denied regardless of allowlist or auto-accept.
- **Blocked paths** — `.env`, keys, `.ssh`, `.git`, etc. are never read or written
  by the path tools.
- **SSRF floor** — always-on for the web tools (loopback / RFC1918 / metadata
  endpoints denied).
- **Secret redaction** — applied to tool args, command output, model content, and
  emitted diffs.

See [`docs/security.md`](docs/security.md) for the full model. Running an autonomous
agent on your code carries inherent risk — start from a clean, committed tree so you
can review and revert what it does.
