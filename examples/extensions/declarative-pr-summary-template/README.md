# declarative-pr-summary-template (example)

A one-file declarative extension that **overrides a built-in prompt
template**:

| File                    | Contribution      | Id           |
| ----------------------- | ----------------- | ------------ |
| `prompts/pr-summary.md` | `prompt_template` | `pr-summary` |

The built-in `core-prompts` extension contributes a `pr-summary` prompt that
the `pull_request` phase uses to draft `pr-summary.md`. This example keeps
the same contribution id (derived from the file name `pr-summary.md`) and the
same `{{task}}` / `{{diff}}` / `{{testResults}}` variables, but swaps the
output format for a team-specific one. Because project- and local-source
contributions override built-ins with the same id, installing this extension
replaces the built-in prompt — nothing else changes.

## What it demonstrates

- **Override by id**: same contribution id + later source = replacement.
  `excalibur extensions list` shows which source won.
- **Markdown prompt files**: the file lives under `prompts/`, so it parses as
  a `prompt_template`; the YAML front matter sets the display name and
  description while the body below the front matter is the template itself.
- **Variable compatibility**: when overriding a built-in template, keep its
  variables (`{{task}}`, `{{diff}}`, `{{testResults}}`) so the phase that
  renders it keeps working.

## Try it

```bash
excalibur extensions install examples/extensions/declarative-pr-summary-template
excalibur extensions validate

# Any run that reaches a pull_request phase now drafts pr-summary.md
# in your format:
excalibur run "Tighten webhook retry backoff" --workflow standard-feature
excalibur pr-summary
```

To stop overriding, disable the extension
(`excalibur extensions disable declarative-pr-summary-template`) or delete
the installed folder — the built-in prompt takes over again.

See `docs/extensions/declarative-extensions.md` for the Markdown file rules.
