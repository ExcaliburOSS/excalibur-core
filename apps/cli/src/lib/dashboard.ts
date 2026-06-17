/**
 * The minimal OSS web dashboard (plan P1.13) — a single self-contained page
 * served at `/` by `excalibur serve`. Vanilla HTML/CSS/JS (no build step): it
 * reads the token from its own URL and renders the SAME data the TUI rail uses
 * (the server returns `reduceRail(events)`), so the web view is byte-faithful to
 * the terminal. The richer `@excalibur/web-ui` (Monaco diffs, agent DAG) layers
 * on later; this is the always-available local seed.
 */

const STYLE = `
:root{--bg:#0b0e14;--panel:#11161f;--line:#1d2531;--text:#c8d3e0;--muted:#6b7888;
--accent:#5bc8ff;--ok:#4ec9b0;--warn:#e2b341;--bad:#f06c6c}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);
font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header{padding:16px 20px;border-bottom:1px solid var(--line);display:flex;
align-items:baseline;gap:14px}h1{font-size:15px;margin:0;letter-spacing:.5px}
h1 .sw{color:var(--accent)}.sub{color:var(--muted)}
.wrap{display:grid;grid-template-columns:minmax(320px,1fr) 1.4fr;gap:0;min-height:calc(100vh - 54px)}
.col{padding:16px 20px}.col+.col{border-left:1px solid var(--line)}
.cards{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:18px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;
padding:10px 12px;min-width:96px}.card .k{color:var(--muted);font-size:11px}
.card .v{font-size:18px;margin-top:2px}
table{width:100%;border-collapse:collapse}th{text-align:left;color:var(--muted);
font-weight:500;font-size:11px;padding:6px 8px;border-bottom:1px solid var(--line)}
td{padding:7px 8px;border-bottom:1px solid var(--line)}
tr.run{cursor:pointer}tr.run:hover{background:var(--panel)}
tr.run.sel{background:#0f1622;outline:1px solid var(--accent)}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px}
.completed{color:var(--ok)}.failed{color:var(--bad)}.cancelled,.running{color:var(--warn)}
.completed .dot{background:var(--ok)}.failed .dot{background:var(--bad)}
.cancelled .dot,.running .dot{background:var(--warn)}
.phase{padding:5px 0;border-left:2px solid var(--line);padding-left:12px;margin-left:4px}
.phase.completed{border-color:var(--ok)}.phase.failed{border-color:var(--bad)}
.phase.running,.phase.waiting{border-color:var(--accent)}
.phase .nm{font-size:13px}.phase .meta{color:var(--muted);font-size:11px}
.ev{color:var(--muted);font-size:11.5px;padding-left:18px}.empty{color:var(--muted);padding:30px 0}
.title{color:var(--accent);margin:0 0 4px}.err{color:var(--bad);padding:20px}
`;

const SCRIPT = `
const tok=new URLSearchParams(location.search).get('token')||'';
const q=p=>p+(p.includes('?')?'&':'?')+'token='+encodeURIComponent(tok);
// Escape EVERY interpolated value before it reaches innerHTML — run titles and
// agent-emitted event text (file paths, shell commands) are untrusted and
// persist to disk; without this they'd execute in this token-holding origin.
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cents=c=>'$'+((c||0)/100).toFixed(2);
const toks=n=>n<1000?n+'':n<1e6?(n/1e3).toFixed(1)+'k':(n/1e6).toFixed(1)+'M';
async function j(p){const r=await fetch(q(p));if(!r.ok)throw new Error(r.status+' '+p);return r.json()}
function card(k,v){return '<div class=card><div class=k>'+k+'</div><div class=v>'+v+'</div></div>'}
async function load(){
 try{
  const ins=await j('/api/insights');
  document.getElementById('cards').innerHTML=
   card('runs',ins.totalRuns)+card('completed',Math.round(ins.completionRate*100)+'%')+
   card('spend',cents(ins.totalCostCents))+card('tokens',toks(ins.totalInputTokens)+'↑ '+toks(ins.totalOutputTokens)+'↓')+
   card('files',ins.totalFilesChanged)+card('blocked',ins.totalVerificationsBlocked);
  const {runs}=await j('/api/runs');
  if(!runs.length){document.getElementById('runs').innerHTML='<p class=empty>No runs yet. Try: excalibur run "…"</p>';return}
  document.getElementById('runs').innerHTML='<table><thead><tr><th>run</th><th>status</th><th>workflow</th><th>model</th></tr></thead><tbody>'+
   runs.slice().reverse().map(r=>'<tr class=run data-id="'+esc(r.id)+'"><td>'+esc(String(r.id).replace('run_',''))+'</td><td class="'+esc(r.status)+'"><span class=dot></span>'+esc(r.status)+'</td><td>'+esc(r.workflow)+'</td><td>'+esc(r.model||'—')+'</td></tr>').join('')+'</tbody></table>';
  document.querySelectorAll('tr.run').forEach(tr=>tr.onclick=()=>{document.querySelectorAll('tr.run').forEach(x=>x.classList.remove('sel'));tr.classList.add('sel');detail(tr.getAttribute('data-id'))});
  detail(runs[runs.length-1].id);
 }catch(e){document.getElementById('runs').innerHTML='<p class=err>'+e.message+' — is the token right?</p>'}
}
async function detail(id){
 try{
  const {record,rail}=await j('/api/runs/'+encodeURIComponent(id));
  const s=rail.status||{};
  let h='<p class=title>'+esc(record.title)+'</p><p class=sub>'+esc(id)+' · '+cents(s.costCents)+' · '+toks(s.inputTokens||0)+'↑ '+toks(s.outputTokens||0)+'↓ · '+(rail.errored?'<span class=failed>errored</span>':esc(record.status))+'</p>';
  h+=(rail.phases||[]).map(p=>{
   const ms=p.durationMs!=null?' · '+(p.durationMs/1000).toFixed(1)+'s':'';
   const cc=p.costCents!=null?' · '+cents(p.costCents):'';
   const evs=(p.events||[]).map(e=>'<div class=ev>'+esc(e.text||'')+(e.note?' '+esc(e.note):'')+'</div>').join('');
   return '<div class="phase '+esc(p.state)+'"><div class=nm>'+esc(p.name)+'</div><div class=meta>'+esc(p.state)+ms+cc+'</div>'+evs+'</div>';
  }).join('')||'<p class=empty>No phases recorded.</p>';
  document.getElementById('detail').innerHTML=h;
 }catch(e){document.getElementById('detail').innerHTML='<p class=err>'+e.message+'</p>'}
}
load();setInterval(load,4000);
`;

/** The full self-contained dashboard page. */
export function dashboardHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'">
<title>Excalibur</title><style>${STYLE}</style></head>
<body>
<header><h1><span class="sw">▌</span> EXCALIBUR</h1><span class="sub">local run dashboard · read-only</span></header>
<div class="wrap">
  <div class="col"><div id="cards" class="cards"></div><div id="runs"></div></div>
  <div class="col"><div id="detail"><p class="empty">Select a run.</p></div></div>
</div>
<script>${SCRIPT}</script>
</body></html>`;
}
