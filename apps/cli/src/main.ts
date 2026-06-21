#!/usr/bin/env node
import { CommanderError } from 'commander';
import { isExcaliburError } from '@excalibur/shared';
import { loadExcaliburConfig } from '@excalibur/core';
import { createUi } from './ui';
import { defaultDeps } from './deps';
import { buildProgram } from './program';
import { parseInteractiveArgs, runInteractiveSession } from './session/repl';
import { EXIT_SUCCESS, describeError, exitCodeForError } from './errors';
import { loadSecretsIntoEnv } from './lib/secrets-store';
import { installNetworkProxy } from './lib/network-proxy';

/**
 * Installs the corporate proxy + custom-CA global dispatcher (P0.2) so every
 * outbound fetch (web/model/MCP/sync) honors `HTTP(S)_PROXY`/`NO_PROXY`/
 * `NODE_EXTRA_CA_CERTS` and `config.network`. Best-effort: no repo / invalid
 * config falls back to env-only. Runs before any network call.
 */
function setupNetwork(): void {
  let network;
  try {
    network = loadExcaliburConfig(process.cwd()).config.network;
  } catch {
    network = undefined;
  }
  const result = installNetworkProxy(network);
  if (result.insecure) {
    process.stderr.write(
      '⚠ TLS certificate verification is DISABLED (network.tls.rejectUnauthorized=false) — insecure.\n',
    );
  }
}

function stdinIsTty(): boolean {
  return process.stdin.isTTY === true;
}

/**
 * Excalibur CLI entry point. CommonJS-compatible (no top-level await):
 * `main()` is invoked and its rejection mapped onto the contract exit codes
 * (0 success · 1 runtime error · 2 usage/validation).
 */
function main(): void {
  // Hydrate API keys pasted during onboarding (stored in
  // ~/.config/excalibur/secrets.env, 0600) into the environment BEFORE deps
  // capture `process.env` — the real environment always wins (gaps only). This
  // is why a pasted key "just works" without the user exporting anything.
  loadSecretsIntoEnv();

  // Corporate proxy + custom CA: install the global dispatcher BEFORE any fetch.
  setupNetwork();

  const ui = createUi();

  // No-subcommand + TTY → the interactive conversational session. Without a
  // TTY (piped/CI) we keep the existing Commander no-arg help behavior.
  const interactiveOptions = parseInteractiveArgs(process.argv);
  if (interactiveOptions !== null && stdinIsTty()) {
    const deps = defaultDeps({ ui });
    runInteractiveSession(deps, interactiveOptions)
      .then((code) => {
        process.exitCode = code;
      })
      .catch((error: unknown) => {
        ui.error(describeError(error));
        if (isExcaliburError(error)) {
          ui.info(`(${error.code})`);
        }
        process.exitCode = exitCodeForError(error);
      });
    return;
  }

  const program = buildProgram({ ui });

  program
    .parseAsync(process.argv)
    .then(() => {
      process.exitCode = process.exitCode ?? EXIT_SUCCESS;
    })
    .catch((error: unknown) => {
      const exitCode = exitCodeForError(error);
      if (error instanceof CommanderError) {
        // Commander already printed help/usage through configureOutput.
        process.exitCode = exitCode;
        return;
      }
      ui.error(describeError(error));
      if (isExcaliburError(error)) {
        ui.info(`(${error.code})`);
      }
      ui.info('Run `excalibur doctor` to diagnose your setup.');
      process.exitCode = exitCode;
    });
}

main();
