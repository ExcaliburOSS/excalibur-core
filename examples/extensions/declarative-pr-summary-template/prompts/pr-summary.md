---
name: Pull Request Summary (team format)
description: >
  Team-specific PR description format. The id `pr-summary` (derived from the
  file name) matches the built-in prompt from the core-prompts extension, so
  this file overrides it.
---

Summarize the change below as a pull request description in our team format.

Task: {{task}}

## Diff

{{diff}}

## Test results

{{testResults}}

Write markdown with exactly these sections:

- **What & why** — two sentences max: the user-visible change and the reason.
- **How** — bullet list of the implementation decisions a reviewer must know.
- **Risk & rollback** — what could break, which feature flag or revert undoes it.
- **Testing** — what was run and what the results were. Never claim tests
  passed unless the test results above say so.
- **Reviewer checklist** — 2–4 checkboxes pointing at the files to read first.

Keep the whole description under 300 words. No marketing language.
