# Enterprise sync

> **Experimental in M1.** The Excalibur Enterprise control plane is not public yet. Everything in Excalibur Core works locally without an account, forever.

Excalibur Core and Excalibur Enterprise share the same schemas: autonomy levels, workflow/methodology definitions, the 23-type event format, run artifacts and configuration conventions. That makes local work portable — a local run can later be ingested by Enterprise without translation.

## Commands

```bash
excalibur login        # store credentials (~/.config/excalibur/credentials.json, mode 0600)
excalibur connect      # show the connection status
excalibur sync         # push the latest local run + its events
excalibur run "Fix bug" --sync   # push automatically after a run
```

Environment variables `EXCALIBUR_BASE_URL` and `EXCALIBUR_API_KEY` take precedence over the credentials file — useful for CI.

## What sync does (and does not)

- **Without login, nothing leaves your machine.** Sync is optional and transparent.
- `sync` POSTs the run record and its events to the Enterprise API (`/api/sync/runs`, `/api/sync/events`).
- Enterprise can in turn provide allowed models, policies, team defaults, workflows and sensitive-path rules (`pullConfig`), which the CLI will consume in a later milestone.

## What Enterprise adds

Web workbench, organizations and teams, SSO/RBAC, centralized policies and approvals, audit logs, cost dashboards, model governance, GitHub/GitLab Apps, hybrid/self-hosted runners, compliance and collaboration — built on the same open foundations as this repository.

## Credential safety

- Stored at `~/.config/excalibur/credentials.json` with file mode `0600` (directory `0700`).
- The CLI never echoes the API key back.
- `excalibur doctor` reports the connection status as optional information — absence is never an error.
