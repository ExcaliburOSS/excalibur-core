# declarative-fast-fix-workflow (example)

The smallest useful declarative extension: **one manifest, one workflow**.

| File                               | Contribution | Id                  |
| ---------------------------------- | ------------ | ------------------- |
| `workflows/fast-fix-verified.yaml` | `workflow`   | `fast-fix-verified` |

`fast-fix-verified` reorders the built-in `fast-fix` flow so that
verification happens _before_ the patch can be applied, makes the verify
phase required (`onFailure: abort` — the run stops when the configured
commands fail) and keeps `requiresHumanConfirmation: true` on the
`apply_patch` phase. The built-in `fast-fix` keeps its id and stays
available unchanged.

## What it demonstrates

- The minimal pack layout: `excalibur.extension.yaml` + one contributed file.
- Phase ordering as policy: moving `command_group` before `apply_patch`
  changes when a human gets asked, with no code involved.
- `commandsFromConfig: true`: the verify phase resolves the `test`, `lint`,
  `typecheck` and `build` commands detected in `.excalibur/config.yaml`.
  (In M1 command execution inside runs is simulated and events carry
  `simulated: true`.)

## Try it

```bash
excalibur extensions install examples/extensions/declarative-fast-fix-workflow
excalibur extensions validate
excalibur workflows explain fast-fix-verified

excalibur run "Fix the webhook retry off-by-one" --workflow fast-fix-verified
```

Or skip the pack entirely and copy `workflows/fast-fix-verified.yaml` into
`.excalibur/workflows/` — loose files in that directory load the same way.

See `docs/extensions/creating-a-workflow.md` for the phase-type reference.
