/**
 * LSP (Language Server Protocol) client — feeds real per-edit compiler
 * diagnostics to the agent loop (P1.10 / M3). Mirrors the MCP client's
 * JSON-RPC-over-stdio shape with Content-Length framing + inbound dispatch.
 */
export { encodeMessage, MessageBuffer, LspFramingError } from './lsp-framing';
export { LspStdioTransport, type LspIncomingMessage, type LspStdioTransportOptions } from './lsp-transport';
export { LspClient, type LspClientStartOptions, type DiagnosticsWaitOptions } from './lsp-client';
export {
  languageForFile,
  resolveServerFor,
  binaryOnPath,
  resolveBinary,
  type LspServerCommand,
} from './lsp-servers';
export {
  createLspSession,
  type LspSession,
  type CreateLspSessionOptions,
} from './lsp-session';
export type {
  LspDiagnostic,
  DiagnosticSeverity,
  PublishDiagnosticsParams,
} from './lsp-protocol';
