import type { SessionUpdate } from './acp-client';

/**
 * Webview session view (P1.5b) — a richer surface than the output channel: a
 * styled panel that shows the assistant's streamed message, tool calls and the
 * live plan. This module is PURE (no `vscode` import) so it is unit-testable;
 * `extension.ts` owns the thin webview-panel glue and forwards `toViewMessage`.
 *
 * SECURITY: the webview renders every value with `textContent` (never innerHTML)
 * and runs under a strict nonce'd CSP, so untrusted agent text can't execute.
 */

/** A normalized message the webview knows how to render. */
export type ViewMessage =
  | { kind: 'message'; text: string }
  | { kind: 'tool'; label: string }
  | { kind: 'tool-done'; label: string; ok: boolean }
  | { kind: 'plan'; entries: Array<{ text: string; status: string }> }
  | { kind: 'file'; path: string; diff: string }
  | { kind: 'command'; command: string; exitCode: number | null }
  | { kind: 'diagnostics'; count: number }
  | { kind: 'status'; text: string };

/** Maps an ACP `SessionUpdate` to a {@link ViewMessage}, or null if irrelevant. */
export function toViewMessage(update: SessionUpdate): ViewMessage | null {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = update.content?.text;
      return typeof text === 'string' && text.length > 0 ? { kind: 'message', text } : null;
    }
    case 'tool_call':
      return { kind: 'tool', label: update.title ?? update.toolCallId ?? 'tool' };
    case 'tool_call_update':
      return {
        kind: 'tool-done',
        label: update.toolCallId ?? 'tool',
        ok: update.status !== 'failed',
      };
    case 'plan': {
      const entries = (update.entries ?? []).map((e) => ({ text: e.content, status: e.status }));
      return entries.length > 0 ? { kind: 'plan', entries } : null;
    }
    // P1.5b — the agent's edits, commands and diagnostics.
    case 'excalibur/file': {
      const path = typeof update.path === 'string' ? update.path : '';
      return path.length > 0
        ? { kind: 'file', path, diff: typeof update.diff === 'string' ? update.diff : '' }
        : null;
    }
    case 'excalibur/command': {
      const command = typeof update.command === 'string' ? update.command : '';
      return command.length > 0
        ? {
            kind: 'command',
            command,
            exitCode: typeof update.exitCode === 'number' ? update.exitCode : null,
          }
        : null;
    }
    case 'excalibur/diagnostics':
      return { kind: 'diagnostics', count: typeof update.count === 'number' ? update.count : 0 };
    default:
      return null;
  }
}

/**
 * The webview HTML shell. Static markup + a nonce'd script that appends
 * `ViewMessage`s posted from the extension (`postMessage`) using textContent.
 * `nonce` must be a fresh random per panel (CSP `script-src 'nonce-…'`).
 */
export function sessionViewHtml(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  body{margin:0;padding:12px 16px;font:13px/1.5 var(--vscode-editor-font-family,ui-monospace,monospace);color:var(--vscode-foreground);background:var(--vscode-editor-background)}
  .msg{white-space:pre-wrap;margin:0 0 8px}
  .tool{color:var(--vscode-descriptionForeground);margin:6px 0}
  .tool .ok{color:#4ec9a8}.tool .bad{color:#e5687a}
  .plan{border-left:2px solid var(--vscode-descriptionForeground);padding-left:10px;margin:8px 0}
  .plan h4{margin:0 0 4px;font-size:12px}.plan div{margin:1px 0}
  .status{color:var(--vscode-descriptionForeground);margin-top:10px;font-style:italic}
  .file{margin:6px 0}
  .file summary{cursor:pointer;color:var(--vscode-textLink-foreground)}
  .diff{white-space:pre;overflow-x:auto;margin:4px 0 0;padding:6px 8px;border:1px solid var(--vscode-panel-border,#3334);border-radius:4px;font-size:12px}
  .diff .add{color:#4ec9a8}.diff .del{color:#e5687a}.diff .hd{color:var(--vscode-descriptionForeground)}
  .cmd{margin:6px 0;color:var(--vscode-descriptionForeground)}
  .cmd .ok{color:#4ec9a8}.cmd .bad{color:#e5687a}
  .diag{color:#d7a85f;margin:6px 0}
</style>
</head>
<body>
<div id="log"></div>
<script nonce="${nonce}">
(function(){
  var log=document.getElementById('log');
  var stream=null;
  var el=function(t,c,txt){var e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e;};
  window.addEventListener('message',function(ev){
    var m=ev.data;if(!m||!m.kind)return;
    if(m.kind==='message'){
      if(!stream){stream=el('p','msg');log.appendChild(stream);}
      stream.textContent+=m.text; // stream chunks into the current message
      return;
    }
    stream=null; // any non-message update ends the current streamed paragraph
    if(m.kind==='tool'){log.appendChild(el('div','tool','⚙ '+m.label+' …'));}
    else if(m.kind==='tool-done'){var d=el('div','tool');d.appendChild(el('span',m.ok?'ok':'bad',(m.ok?'✓':'✗')+' '));d.appendChild(document.createTextNode(m.label));log.appendChild(d);}
    else if(m.kind==='plan'){var p=el('div','plan');p.appendChild(el('h4',null,'Plan'));m.entries.forEach(function(e){var mark=e.status==='completed'?'✓':e.status==='in_progress'?'▸':'○';p.appendChild(el('div',null,mark+' '+e.text));});log.appendChild(p);}
    else if(m.kind==='file'){var f=el('details','file');f.appendChild(el('summary',null,'✎ '+m.path));if(m.diff){var pre=el('pre','diff');String(m.diff).split('\\n').forEach(function(ln){var c=ln[0]==='+'&&ln.slice(0,3)!=='+++'?'add':ln[0]==='-'&&ln.slice(0,3)!=='---'?'del':(ln[0]==='@'||ln.slice(0,3)==='+++'||ln.slice(0,3)==='---'||ln.slice(0,4)==='diff')?'hd':'';pre.appendChild(el('span',c,ln+'\\n'));});f.appendChild(pre);}log.appendChild(f);}
    else if(m.kind==='command'){var cd=el('div','cmd');if(m.exitCode==null){cd.textContent='$ '+m.command+' …';}else{cd.appendChild(el('span',m.exitCode===0?'ok':'bad',(m.exitCode===0?'✓':'✗')+' '));cd.appendChild(document.createTextNode('$ '+m.command+(m.exitCode===0?'':' (exit '+m.exitCode+')')));}log.appendChild(cd);}
    else if(m.kind==='diagnostics'){log.appendChild(el('div','diag','⚠ '+m.count+' diagnostic'+(m.count===1?'':'s')));}
    else if(m.kind==='status'){log.appendChild(el('div','status',m.text));}
    window.scrollTo(0,document.body.scrollHeight);
  });
})();
</script>
</body>
</html>
`;
}
