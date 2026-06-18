import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { ProviderError } from '@excalibur/shared';
import { encodeMessage, LspFramingError, MessageBuffer } from './lsp-framing';
import type { OutgoingMessage } from './lsp-protocol';

/**
 * LSP stdio transport: spawns a language-server subprocess and frames JSON-RPC
 * messages with `Content-Length` headers over its stdio.
 *
 * Mirrors the MCP {@link StdioTransport} lifecycle (spawn / attach / send /
 * close, SIGTERM on close, process `error`/`exit` surfaced as a close reason)
 * with ONE deliberate difference: it consumes RAW Buffers (never
 * `setEncoding('utf8')`), because LSP's byte-count framing breaks the moment a
 * multi-byte character straddles a chunk boundary on a decoded string stream.
 */

/** A parsed inbound JSON-RPC message (response, server request, or notification). */
export type LspIncomingMessage = Record<string, unknown>;

export interface LspStdioTransportOptions {
  command: string;
  args?: ReadonlyArray<string>;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LspStdioTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private onMessage: (message: LspIncomingMessage) => void = () => {};
  private onClose: (reason: Error) => void = () => {};
  private readonly inbound = new MessageBuffer();
  private closed = false;

  constructor(options: LspStdioTransportOptions) {
    if (options.command.trim().length === 0) {
      throw new ProviderError('LSP server command must not be empty.', { code: 'lsp_invalid_command' });
    }
    try {
      this.child = spawn(options.command, [...(options.args ?? [])], {
        cwd: options.cwd ?? process.cwd(),
        // Pin a minimal env (PATH+HOME) like the command runner, so the server
        // can't read arbitrary host secrets; callers may widen it explicitly.
        env: options.env ?? { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      throw new ProviderError(`Could not start LSP server "${options.command}": ${describe(error)}.`, {
        code: 'lsp_spawn_failed',
        details: { command: options.command },
      });
    }
  }

  attach(onMessage: (m: LspIncomingMessage) => void, onClose: (r: Error) => void): void {
    this.onMessage = onMessage;
    this.onClose = onClose;
    // RAW Buffers — NOT setEncoding('utf8') — so Content-Length byte counts hold.
    this.child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    // Drain (but don't parse) stderr so a chatty server can't block on a full pipe.
    this.child.stderr.on('data', () => {});
    this.child.on('error', (error: Error) => {
      this.onClose(new ProviderError(`LSP server process error: ${error.message}.`, { code: 'lsp_process_error' }));
    });
    this.child.on('exit', (code, signal) => {
      if (this.closed) return;
      this.onClose(
        new ProviderError(
          `LSP server exited unexpectedly (code ${code ?? 'null'}, signal ${signal ?? 'null'}).`,
          { code: 'lsp_process_exited', details: { exitCode: code, signal } },
        ),
      );
    });
  }

  send(message: OutgoingMessage): void {
    const ok = this.child.stdin.write(encodeMessage(message));
    if (!ok && this.child.stdin.destroyed) {
      throw new ProviderError('LSP server stdin is no longer writable.', { code: 'lsp_write_failed' });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.stdout.removeAllListeners('data');
    this.child.stderr.removeAllListeners('data');
    this.child.removeAllListeners('error');
    this.child.removeAllListeners('exit');
    try {
      this.child.stdin.end();
    } catch {
      /* already closed */
    }
    if (this.child.exitCode === null && this.child.signalCode === null) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        /* already exited */
      }
    }
  }

  private onStdout(chunk: Buffer): void {
    this.inbound.append(chunk);
    try {
      for (const message of this.inbound.drain()) {
        this.onMessage(message as LspIncomingMessage);
      }
    } catch (error) {
      // A corrupt frame is unrecoverable — tear down with a terminal close.
      if (this.closed) return;
      const reason =
        error instanceof LspFramingError
          ? new ProviderError(`LSP stream framing error: ${error.message}.`, { code: 'lsp_process_error' })
          : new ProviderError(`LSP stream error: ${describe(error)}.`, { code: 'lsp_process_error' });
      this.onClose(reason);
    }
  }
}
