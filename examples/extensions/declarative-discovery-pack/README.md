# declarative-discovery-pack (example)

A declarative extension pack — pure YAML/Markdown, no code — that customizes
the Excalibur Discovery flow for a product team. It contributes:

| File                                    | Contribution        | Id                   |
| --------------------------------------- | ------------------- | -------------------- |
| `question-packs/product-discovery.yaml` | `question_pack`     | `product-discovery`  |
| `question-packs/agent-readiness.yaml`   | `question_pack`     | `agent-readiness`    |
| `roles/product-strategist.yaml`         | `role_definition`   | `product-strategist` |
| `roles/scope-guardian.yaml`             | `role_definition`   | `scope-guardian`     |
| `artifacts/refined-ticket.md`           | `artifact_template` | `refined-ticket`     |
| `prompts/discovery-kickoff.md`          | `prompt_template`   | `discovery-kickoff`  |

## What it demonstrates

- **A pack manifest** (`excalibur.extension.yaml`, `kind: declarative`) whose
  `contributes` keys list files relative to the extension directory.
- **Adding new contributions**: the question packs, roles and the kickoff
  prompt use ids that do not exist in the built-in catalogs, so they appear
  _alongside_ the built-ins.
- **Overriding a built-in**: `artifacts/refined-ticket.md` deliberately keeps
  the id `refined-ticket` (derived from the file name), which matches the
  built-in template contributed by the `discovery-pack` built-in extension.
  Because contributions from later sources win over earlier ones
  (`built_in` < `project` < `local`), installing this pack replaces the
  built-in refined-ticket template — with zero special-casing.
- **Markdown declarative files**: the artifact and prompt templates are
  Markdown with YAML front matter. The id comes from the file name, the type
  from the directory (`artifacts/` → `artifact_template`, `prompts/` →
  `prompt_template`), and `{{variable}}` placeholders are auto-extracted.

## Try it

```bash
# Copy the pack into your repository's local extensions:
excalibur extensions install examples/extensions/declarative-discovery-pack

# Validate everything that is now reachable from the repo:
excalibur extensions validate

# See the pack and its contributions, with their source column:
excalibur extensions list
```

The question ids in the packs matter: the built-in Discovery scoring inspects
the well-known ids (`problem`, `user`, `current_workaround`, `urgency`,
`mvp`, `out_of_scope`, `success`, `evidence`, `risks`, `readiness`) to
compute readiness scores. Extra ids (like `kill_criteria`) are kept in the
transcript and synthesis but do not feed the scores.

See `docs/extensions/creating-a-question-pack.md` and
`docs/extensions/declarative-extensions.md` for the full reference.
