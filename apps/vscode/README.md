# Excalibur for VS Code (and Cursor / Windsurf)

Run the [Excalibur](https://github.com/ExcaliburOSS/excalibur-core) local-first AI
coding agent inside your editor. The extension spawns the Excalibur CLI in
**ACP** mode (`excalibur acp`) and bridges it over the
[Agent Client Protocol](https://agentclientprotocol.com) — JSON-RPC over stdio —
so you keep one agent, one config and one set of guardrails across the terminal
and the editor.

> Why an extension? VS Code, Cursor and Windsurf do **not** host external ACP
> agents natively (unlike Zed, JetBrains, Neovim and Emacs, where `excalibur acp`
> works out of the box). This extension is the integration path for all three.

## Prerequisites

Install the CLI and make sure it's on your `PATH`:

```sh
npm i -g @excalibur-oss/excalibur
excalibur --version
```

(Or point the `excalibur.command` setting at an absolute path.)

## Commands

| Command | Default keybinding | What it does |
| --- | --- | --- |
| **Excalibur: Run a Task** | `Ctrl/Cmd+Shift+A` | Ask for a task and run it in the workspace root. |
| **Excalibur: Ask About Selection** | `Ctrl/Cmd+Shift+E` | Ask a question about the selected code (right-click too). |
| **Excalibur: Explain This File** | — | Explain the active file. |
| **Excalibur: Review Selection** | — | Adversarial review of the selected code. |
| **Excalibur: Cancel the Running Agent** | `Esc` (while running) | Cancel the in-flight run. |
| **Excalibur: Open Excalibur Terminal** | — | Drop into the interactive shell in a terminal. |

The agent streams its work — assistant text, tool calls and the live plan — into
the **Excalibur** output channel. The current file and selection (with 1-based
line numbers) are passed into the prompt as context.

## Permissions

When the agent wants to run a tool action that needs approval, you get a native
modal. Set **`excalibur.autoApprove`** to `allow` to auto-approve in trusted
repos (default is `ask`). Approvals are per-action; blocked paths and the safety
floor are still enforced by the CLI.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `excalibur.command` | `excalibur` | Path to the CLI binary. |
| `excalibur.args` | `["acp"]` | Arguments to launch ACP mode. |
| `excalibur.autoApprove` | `ask` | `ask` (prompt per action) or `allow` (auto-approve). |

## Editor compatibility

- **VS Code** — install from the `.vsix` (or the Marketplace once published).
- **Cursor / Windsurf** — VS Code forks; install the `.vsix` ("Extensions:
  Install from VSIX…") or from Open VSX. They consume the same extension API.
- **Zed / JetBrains / Neovim / Emacs** — you don't need this extension; just run
  `excalibur acp` (those hosts are ACP clients already).

## Develop

```sh
pnpm --filter excalibur-vscode build      # bundle to dist/extension.js (tsup, CJS, vscode externalized)
pnpm --filter excalibur-vscode typecheck  # tsc --noEmit
pnpm --filter excalibur-vscode test       # vitest (ACP client + prompt builder)
pnpm --filter excalibur-vscode package    # build + vsce package → .vsix
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host.

## License

Apache-2.0
