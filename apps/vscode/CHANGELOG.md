# Changelog

## 0.1.0

- Initial release (P1.5). Runs `excalibur acp` and bridges it over the Agent
  Client Protocol (ndjson JSON-RPC over stdio).
- Commands: Run a Task, Ask About Selection, Explain This File, Review
  Selection, Cancel, Open Excalibur Terminal — with keybindings + an editor
  context menu.
- Streams assistant text, tool calls and the live plan into the Excalibur output
  channel; passes the active file + selection (1-based lines) as prompt context.
- Native permission modals for tool actions (`excalibur.autoApprove`: `ask` |
  `allow`).
- Works in VS Code, Cursor and Windsurf (none host external ACP agents natively).
