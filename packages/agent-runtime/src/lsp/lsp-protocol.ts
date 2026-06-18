/**
 * Minimal LSP / JSON-RPC 2.0 wire types shared by the transport, client and
 * session. We model only what a diagnostics-focused client needs — not the full
 * protocol. Mirrors the JSON-RPC envelope shapes used by the MCP client.
 */

export type JsonRpcId = string | number;

/** A request (expects a response). */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

/** A notification (no response). */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

/** A response — exactly one of `result`/`error`. */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Any outbound frame the transport may send. */
export type OutgoingMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** LSP `DiagnosticSeverity` (1=Error … 4=Hint). */
export const LSP_SEVERITY = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint',
} as const;

export type DiagnosticSeverity = (typeof LSP_SEVERITY)[keyof typeof LSP_SEVERITY];

/** A position in a text document (LSP is 0-based line + character). */
export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** An LSP `Diagnostic` (the subset we surface). */
export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  message: string;
  source?: string;
}

/** The payload of a `textDocument/publishDiagnostics` notification. */
export interface PublishDiagnosticsParams {
  uri: string;
  version?: number;
  diagnostics: LspDiagnostic[];
}
