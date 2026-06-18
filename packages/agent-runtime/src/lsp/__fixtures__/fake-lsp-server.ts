/**
 * A configurable fake LSP server (real `Content-Length` byte framing) run via
 * `process.execPath -e FAKE_LSP_SERVER`. Behavior is driven by the `FAKE_MODE`
 * env var and `__ERR__` markers in the document text. Test-only fixture (not
 * exported from the package barrel).
 */
export const FAKE_LSP_SERVER = String.raw`
let buf = Buffer.alloc(0);
const mode = process.env.FAKE_MODE || 'basic';
let configAnswered = false;
const deferred = [];

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  process.stdout.write('Content-Length: ' + body.length + '\r\n\r\n');
  process.stdout.write(body);
}
function diagsFor(text) {
  return text && text.includes('__ERR__')
    ? [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, severity: 1, message: 'Type error', code: 'TS2322' }]
    : [];
}
function publishFor(uri, version, text) {
  if (mode === 'never-publish') return;
  if (mode === 'two-wave') {
    send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, version, diagnostics: [] } });
    setTimeout(() => send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, version, diagnostics: diagsFor(text) } }), 40);
    return;
  }
  if (mode === 'stale-then-fresh') {
    send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, version: version - 1, diagnostics: [] } });
    setTimeout(() => send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, version, diagnostics: diagsFor(text) } }), 40);
    return;
  }
  send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, version, diagnostics: diagsFor(text) } });
}
function handle(msg) {
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } }); return; }
  if (msg.method === 'initialized') {
    if (mode === 'config-gate') send({ jsonrpc: '2.0', id: 'cfg-1', method: 'workspace/configuration', params: { items: [{ section: 'x' }] } });
    return;
  }
  if (msg.id === 'cfg-1' && msg.method === undefined) {
    configAnswered = true;
    for (const d of deferred.splice(0)) publishFor(d.uri, d.version, d.text);
    return;
  }
  if (msg.method === 'textDocument/didOpen') {
    const td = msg.params.textDocument;
    if (mode === 'config-gate' && !configAnswered) { deferred.push({ uri: td.uri, version: td.version, text: td.text }); return; }
    publishFor(td.uri, td.version, td.text);
    return;
  }
  if (msg.method === 'textDocument/didChange') {
    const td = msg.params.textDocument;
    publishFor(td.uri, td.version, msg.params.contentChanges[0].text);
    return;
  }
  if (msg.method === 'exit') process.exit(0);
}
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep === -1) break;
    const m = /content-length:\s*(\d+)/i.exec(buf.slice(0, sep).toString('ascii'));
    const start = sep + 4;
    if (!m) { buf = buf.slice(start); continue; }
    const len = parseInt(m[1], 10);
    if (buf.length < start + len) break;
    const body = buf.slice(start, start + len).toString('utf8');
    buf = buf.slice(start + len);
    try { handle(JSON.parse(body)); } catch (e) { /* ignore */ }
  }
});
`;
