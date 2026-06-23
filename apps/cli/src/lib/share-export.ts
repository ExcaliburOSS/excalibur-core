import type { RunRecord } from '@excalibur/shared';
import type { RailModel } from '@excalibur/tui';

/**
 * Static, self-contained share export (P2.19, OSS slice). Renders one run's
 * record + reduced rail into a SINGLE HTML file with the data embedded and a
 * tiny inline renderer — no server, no API, no Excalibur hosting. The user can
 * open it offline or drop it on any static host (GitHub Pages, S3, …).
 *
 * SECURITY: the run data (titles, phase/agent text) is UNTRUSTED, so it is
 * embedded as JSON (with `<` escaped to prevent a `</script>` breakout) and the
 * renderer builds the DOM with `textContent` only — never `innerHTML` — so a
 * crafted title/message can never execute. A strict CSP is set as defense in depth.
 */

/** Escapes a JSON string for safe inlining inside a `<script>` element. */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function buildRunShareHtml(record: RunRecord, rail: RailModel): string {
  const data = embedJson({ record, rail });
  // The renderer is intentionally tiny + dependency-free; all text goes through
  // textContent so no untrusted value is ever parsed as HTML.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;" />
<title>Excalibur run — shared</title>
<style>
  :root{--bg:#0b0e14;--panel:#11151f;--line:#232b3a;--text:#e6ebf5;--muted:#8a96ab;--accent:#5b9dff;--ok:#4ec9a8;--bad:#e5687a;--warn:#e2b341}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,sans-serif}
  .wrap{max-width:900px;margin:0 auto;padding:24px}
  h1{font-size:22px;margin:0 0 4px}.id{font-family:ui-monospace,monospace;color:var(--muted);font-size:12px}
  .badges{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}
  .b{font-size:11px;padding:2px 8px;border-radius:999px;background:var(--panel);border:1px solid var(--line)}
  .st-completed{color:var(--ok)}.st-failed{color:var(--bad)}.st-running{color:var(--accent)}
  h2{font-size:14px;margin:24px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--line)}
  .phase{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-bottom:8px}
  .pname{font-weight:600}.pmeta{color:var(--muted);font-size:12px}
  ul{margin:6px 0 0;padding-left:18px}li{margin:2px 0}
  .todo-completed{color:var(--muted);text-decoration:line-through}.todo-in_progress{color:var(--warn)}
  footer{margin-top:32px;color:var(--muted);font-size:12px}
</style>
</head>
<body>
<div class="wrap" id="app"></div>
<script id="excalibur-run" type="application/json">${data}</script>
<script>
(function(){
  var el=function(t,c,txt){var e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e;};
  var data;try{data=JSON.parse(document.getElementById('excalibur-run').textContent);}catch(_){return;}
  var rec=data.record||{},rail=data.rail||{};
  var app=document.getElementById('app');
  app.appendChild(el('h1',null,rec.title||rail.title||rec.id||'Run'));
  app.appendChild(el('div','id',rec.id||''));
  var badges=el('div','badges');
  var status=rec.status||(rail.status&&rail.status.status)||'';
  badges.appendChild(el('span','b st-'+status,status||'unknown'));
  if(rec.workflow)badges.appendChild(el('span','b',rec.workflow));
  if(rec.model)badges.appendChild(el('span','b',rec.model));
  var s=rail.status||{};
  if(typeof s.costCents==='number')badges.appendChild(el('span','b','$'+(s.costCents/100).toFixed(2)));
  if(typeof s.inputTokens==='number'||typeof s.outputTokens==='number')
    badges.appendChild(el('span','b',((s.inputTokens||0)+(s.outputTokens||0))+' tokens'));
  app.appendChild(badges);
  var todos=rail.todos||[];
  if(todos.length){app.appendChild(el('h2',null,'Checklist'));var ul=el('ul');todos.forEach(function(t){ul.appendChild(el('li','todo-'+(t.status||''),t.text||''));});app.appendChild(ul);}
  var phases=rail.phases||[];
  if(phases.length){
    app.appendChild(el('h2',null,'Phases'));
    phases.forEach(function(p){
      var d=el('div','phase');d.appendChild(el('div','pname',p.name||p.id||'phase'));
      var items=p.items||p.events||[];
      if(items.length)d.appendChild(el('div','pmeta',items.length+' steps'));
      app.appendChild(d);
    });
  }
  var f=el('footer',null,'Shared, read-only snapshot exported by Excalibur — '+(rec.startedAt||''));
  app.appendChild(f);
})();
</script>
</body>
</html>
`;
}
