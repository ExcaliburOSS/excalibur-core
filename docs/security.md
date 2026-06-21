# Security defaults

Excalibur Core is built around one promise:

> **No files will be modified, no patches applied and no unknown commands run without approval.**

## The `standard-safe` preset

Active by default (even without `.excalibur/`), printed at the start of every run:

```text
Safety: standard-safe — No files will be modified without approval.
```

### Blocked paths (never read, never written)

```text
.env  .env.*  **/*.pem  **/*.key  **/*.p12  **/*.pfx
**/secrets/**  **/.ssh/**  node_modules/**  dist/**  build/**  .git/**
```

### Permission rules

| Action                                          | Default                                   |
| ----------------------------------------------- | ----------------------------------------- |
| Read files (except blocked)                     | allowed                                   |
| Write files                                     | **ask**                                   |
| Apply a patch                                   | **ask**                                   |
| Run detected test/lint/typecheck/build commands | **ask** first time                        |
| Run unknown commands                            | **ask always**                            |
| Create a branch                                 | **ask**                                   |
| Push                                            | **disabled**                              |
| Open a PR                                       | **ask**                                   |
| Network egress (web tools + network commands)   | **public-only, SSRF-guarded** (see below) |

Prompt defaults are the safe answers: risky questions render `[y/N]`, safe ones `[Y/n]`. `--yes` skips prompts by taking the **default** — it never force-approves a risky action (for example, `excalibur patch --yes` still leaves the patch unapplied).

### Secret redaction

Prompts, logs and imported instruction files pass through redaction: OpenAI-style `sk-…`, AWS `AKIA…`, GitHub `ghp_/gho_/ghs_…`, Slack `xox…`, private key blocks, `Authorization: Bearer …`, `password=`/`apiKey:` values → `[REDACTED]`.

API keys are referenced by environment variable **name** in configuration and resolved only at call time. Key values are never stored, logged or echoed.

## Network egress (governed)

Real model providers, `web_fetch`, `web_search`, `web_extract`/`web_crawl`, the research pipeline and network-capable shell commands (`curl`/`wget`/…) all go out through one governed layer. `permissions.network.mode` decides what the agent may reach:

| Mode           | Behavior                                                                       |
| -------------- | ------------------------------------------------------------------------------ |
| `on` (default) | Any **public** host (still SSRF-guarded); `approval` adds a soft gate.         |
| `allowlist`    | Only hosts matching `allowedDomains` globs (e.g. `*.github.com`).              |
| `off`          | No agent-initiated egress at all — lockdown (network commands are denied too). |

**The SSRF floor is always on, in every mode**, and it is the hard boundary the agent cannot talk its way around. It never blocks the public web — it blocks targets that reach _internal_ services: loopback, RFC1918, link-local (incl. the `169.254.169.254` cloud-metadata address), CGNAT, unique-local IPv6, IPv4-mapped IPv6, and numeric/obfuscated host encodings (`2130706433`, `0x7f000001`, `0177.0.0.1`). It works in two layers so DNS rebinding can't slip through: a pre-flight scheme/host check, then a re-resolution of every A/AAAA record right before connecting (and after each redirect). Only an explicit `allowPrivateHosts` entry (for a local SearXNG or Ollama) lets a private host through.

```yaml
permissions:
  network:
    mode: allowlist
    allowedDomains: ['*.github.com', 'api.openai.com']
    allowPrivateHosts: ['127.0.0.1'] # e.g. a local SearXNG
    approval: ask
```

## Corporate proxy + custom CA

Every outbound request (web fetch, model gateway, MCP, enterprise-sync) funnels through one process-global dispatcher installed at startup, so a corporate proxy and a custom root CA are honored everywhere at once. The standard env vars are honored across all egress: `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` and `NODE_EXTRA_CA_CERTS`. Loopback is always added to the no-proxy set so local infra (Ollama, a local SearXNG) is never proxied, and proxy credentials are redacted in any output.

**Trust model.** Env vars are operator-set and always trusted (and always win). The repo-committed `.excalibur/config.yaml` `network.*` section is **untrusted by default** — a cloned malicious repo must not be able to redirect all egress (including API-key-bearing model calls) through an attacker proxy, trust an attacker CA, or disable TLS. Repo `network.*` is honored **only** when you opt in with `EXCALIBUR_TRUST_REPO_NETWORK=1`; otherwise it is ignored and noted. Run `excalibur doctor` to see the effective network plan (proxy, CA, insecure flag — credentials redacted).

## Untrusted web/MCP content (anti-injection)

All inbound content the model didn't author — fetched web pages and MCP tool output — is treated as **data, not instructions**. One canonical scanner runs structural heuristics (instruction-override, role/system injection, exfiltration, tool-call bait, hidden zero-width/bidi text, fence breakout) into a 0–100 score → `clean | suspicious | malicious`; hidden characters are stripped so they never reach the model, and malicious content is quarantined out of context. Every external source is recorded as a `provenance` event (source, content hash, fetched-at, verdict, blocked?), giving each run an auditable trail that feeds the Claim Ledger and cited research.

## MCP servers

The MCP client (stdio + Streamable-HTTP) is gated like everything else. Remote (HTTP) servers must clear the SSRF floor **and** the global network policy **and** the server's own per-server `egress` allowlist before connecting (with the same anti-rebinding DNS re-resolution). Read-only roles are enforced. Local stdio servers have no interceptable egress; their tool output still passes the injection scanner.

## Sandbox

Per-session agentic execution can run inside an ephemeral Docker container (defense in depth, on top of the Permission Engine): the repo is mounted read-write at `/work`, **the host filesystem, environment and secrets are never passed in**, network is `--network none` by default, with CPU/memory caps and a hard timeout. Commands are still permission-gated by the agent loop _before_ they reach the sandbox.

## Customizing

```yaml
permissions:
  tools:
    read_file: true
    write_file: ask
    run_command: ask
  network:
    mode: 'on' # quote it — bare `on` is YAML-1.1 boolean true
  blockedPaths:
    - '.env'
    - '**/*.pem'
    - '**/secrets/**'
  allowedCommands:
    - 'pnpm test'
    - 'pnpm typecheck'

approvals:
  requiredFor:
    paths: ['src/billing/**', 'src/auth/**', 'prisma/migrations/**']
    commands: ['npm run migrate']
    phases: ['plan', 'before_pr']
```

Detected sensitive areas (auth, billing, payments, secrets directories, `.env*`) raise the task-intent classifier's caution: tasks touching them are recommended to run with careful workflows and stronger approvals. Restrictive `autonomy.paths` entries have the same effect.

Policy presets are declarative extensions — `excalibur init --team` exports `policies/standard-safe.yaml` and a repository-specific `policies/sensitive-paths.yaml` you can edit and review in Git.

## Skills and instruction files

- Skills (`SKILL.md`) are **never auto-executed** and never auto-enabled when they need review. Enabling a `review_required` skill requires the explicit `--accept-risk` flag.
- User-global files (`~/.claude/**`) are referenced locally only and never copied into the repository without `--include-global`.
- Secrets found in imported instruction files are redacted in the copy.
- User-global instructions can never weaken repository or enterprise safety rules.

## Safety guarantees

Excalibur acts on your tree only through gated, auditable steps:

- Every mutating tool (`write_file`, `run_command`, `apply_patch`) passes the **Permission Engine**: blocked paths (`.env`, secret files, `.git/…`) are **hard-denied**, mutating tools default to _ask_, and commands outside the allowlist need confirmation. This applies to the real native agent loop and to extension-contributed tools alike.
- File writes are confined to the working directory — path traversal (`..`) and symlink escapes are refused.
- Only the **redacted** prompt is ever sent to a model provider (secrets are stripped). The zero-config default is an offline deterministic **mock** provider — nothing leaves the machine until you configure a real provider (`anthropic`, `openai-compatible`/vLLM/OpenRouter, `ollama`).
- Every action is an event in `.excalibur/runs/<id>/events.jsonl` — fully auditable and replayable with `excalibur logs` / `excalibur rewind`.
- Prefer `excalibur branch <patch-id>` to land a patch on a fresh branch when you'd rather not modify the current one.

Verify your setup anytime with `excalibur doctor`.
