#!/usr/bin/env node
// UI Annotate collector + dashboard — zero-dependency supervised view server.
//
// Env:  PORT                 port to bind (set by the board)
//       UI_ANNOTATE_REPO     leading repo path (keys the store; optional)
//       UI_ANNOTATE_PROJECT  project display name (cosmetic)
//
// Endpoints (CORS open — the overlay runs on arbitrary origins; the server binds 127.0.0.1 only):
//   GET  /overlay.js                      the injectable overlay script
//   GET  /api/annotations?session=&status=         list
//   POST /api/annotations                 create (overlay)
//   PATCH /api/annotations/:id            {comment?, status?: open|resolved, reply?}
//   DELETE /api/annotations/:id
//   GET  /api/poll?since=<seq>&timeout=<s>&session=   LONG-POLL: returns changes after `since`
//   GET  /api/export?format=md|json&session=&all=1    ticket-ready markdown (or raw JSON)
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, storePath, endpointPath, exportMarkdown } from './lib/store.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 0);
const PROJECT = process.env.UI_ANNOTATE_PROJECT || '';
const store = createStore(storePath());
const MAX_BODY = 64 * 1024;
const MAX_POLL_S = 55;

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, {
    'content-type': type,
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
const json = (res, code, obj) => send(res, code, obj);

function readBody(req) {
  return new Promise((res, rej) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { rej(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { res(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { rej(Object.assign(new Error('invalid JSON body'), { status: 400 })); }
    });
    req.on('error', rej);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  const q = url.searchParams;
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (path === '/health') return json(res, 200, { ok: true });
    if (path === '/' || path === '/index.html') {
      return send(res, 200, pageHtml(req.headers.host || `127.0.0.1:${PORT}`, q.get('theme') || ''), 'text/html; charset=utf-8');
    }
    if (path === '/overlay.js') {
      return send(res, 200, readFileSync(join(here, 'overlay.js'), 'utf8'), 'application/javascript; charset=utf-8');
    }
    if (path === '/api/annotations' && req.method === 'GET') {
      const filter = { session: q.get('session') || undefined, status: q.get('status') || undefined };
      return json(res, 200, { seq: store.seq, annotations: store.list(filter) });
    }
    if (path === '/api/annotations' && req.method === 'POST') {
      const body = await readBody(req);
      if (typeof body.comment !== 'string' || !body.comment.trim()) return json(res, 400, { error: '"comment" is required' });
      return json(res, 201, { annotation: store.add(body) });
    }
    const m = path.match(/^\/api\/annotations\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      if (req.method === 'PATCH') {
        const a = store.update(id, await readBody(req));
        return a ? json(res, 200, { annotation: a }) : json(res, 404, { error: `no annotation #${id}` });
      }
      if (req.method === 'DELETE') {
        return store.remove(id) ? json(res, 200, { ok: true }) : json(res, 404, { error: `no annotation #${id}` });
      }
    }
    if (path === '/api/poll' && req.method === 'GET') {
      const since = Number(q.get('since') || 0);
      const timeoutS = Math.min(Math.max(Number(q.get('timeout') || 25), 0), MAX_POLL_S);
      const filter = { session: q.get('session') || undefined };
      const aborted = new Promise((r) => res.on('close', () => r(null)));
      const changed = await Promise.race([store.wait(since, timeoutS * 1000, filter), aborted]);
      if (changed === null) return; // client went away
      return json(res, 200, { seq: store.seq, annotations: changed });
    }
    if (path === '/api/export' && req.method === 'GET') {
      const all = q.get('all') === '1';
      const list = store.list({ session: q.get('session') || undefined });
      if (q.get('format') === 'json') return json(res, 200, { annotations: all ? list : list.filter((a) => a.status === 'open') });
      return send(res, 200, exportMarkdown(list, { includeResolved: all, title: PROJECT ? `UI feedback — ${PROJECT}` : 'UI feedback' }), 'text/markdown; charset=utf-8');
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const port = server.address().port;
  // Lets export.mjs / poll.mjs (and agents running them) find this collector without being told the port.
  try { writeFileSync(endpointPath(), JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid, startedAt: new Date().toISOString() })); } catch { /* best effort */ }
  console.error(`[ui-annotate] collector on http://127.0.0.1:${port}`);
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));

// ---------- ui ----------
function pageHtml(host, theme) {
  const base = `http://${host}`;
  const tag = `<script src="${base}/overlay.js"></script>`;
  const bookmarklet = `javascript:(function(){var s=document.createElement('script');s.src='${base}/overlay.js?t='+Date.now();document.body.appendChild(s)})()`;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return `<!doctype html><html${theme ? ` data-theme="${theme.replace(/[^a-z]/g, '')}"` : ''}><head><meta charset="utf-8"><title>UI Annotate</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1c2330;--muted:#68707f;--border:#dde1e8;--accent:#2563eb;--ok:#16a34a}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#11151d;--card:#1a2030;--fg:#e6eaf2;--muted:#8b94a7;--border:#2a3245}}
:root[data-theme="dark"]{--bg:#11151d;--card:#1a2030;--fg:#e6eaf2;--muted:#8b94a7;--border:#2a3245}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 system-ui,sans-serif;padding:14px;max-width:900px}
h1{font-size:15px;margin:0 0 10px}h2{font-size:13px;margin:16px 0 6px}
.card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px}
code,pre{font:12px ui-monospace,Consolas,monospace}pre{margin:4px 0;padding:6px;border:1px solid var(--border);border-radius:6px;overflow:auto;white-space:pre-wrap;word-break:break-all}
button,a.btn{font:inherit;border:1px solid var(--border);background:transparent;color:var(--fg);border-radius:6px;padding:2px 9px;cursor:pointer;text-decoration:none}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.muted{color:var(--muted)}.row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.grow{flex:1}
.resolved{opacity:.55}.id{font-weight:600}
</style></head><body>
<h1>UI Annotate${PROJECT ? ` <span class="muted">· ${esc(PROJECT)}</span>` : ''}</h1>
<div class="card"><b>Connect a web app</b>
 <div class="muted">Add this to the page you want to annotate (any origin), or drag the bookmarklet to your bookmarks bar and click it on the page.</div>
 <pre>${esc(tag)}</pre>
 <div class="row"><a class="btn" href="${esc(bookmarklet)}" title="Drag me to the bookmarks bar">Annotate this page ⟡</a>
 <button id="copyTag">Copy script tag</button></div></div>
<div class="card"><b>Agents</b>
 <div class="muted">Long-poll for new feedback from any terminal (returns on change or after the timeout):</div>
 <pre>curl "${base}/api/poll?since=0&amp;timeout=25"</pre>
 <div class="muted">Or from the plugin tools: <code>node tools/poll.mjs</code> / <code>node tools/export.mjs</code></div></div>
<div class="row"><h2 class="grow">Annotations <span id="count" class="muted"></span></h2>
 <label class="muted"><input type="checkbox" id="showResolved"> show resolved</label>
 <button id="copyMd" class="primary">Copy as ticket markdown</button></div>
<div id="list"></div>
<script>
const BASE=${JSON.stringify(base)};
const $=(s)=>document.querySelector(s);
const esc=(s)=>String(s).replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function call(m,p,b){const r=await fetch(BASE+p,{method:m,headers:b?{'content-type':'application/json'}:undefined,body:b?JSON.stringify(b):undefined});return r.json();}
async function load(){
  const {annotations}=await call('GET','/api/annotations');
  const shown=annotations.filter(a=>$('#showResolved').checked||a.status==='open');
  $('#count').textContent='('+annotations.filter(a=>a.status==='open').length+' open)';
  $('#list').innerHTML=shown.length?shown.map(a=>'<div class="card '+a.status+'"><div class="row"><span class="id">#'+a.id+'</span><span class="grow">'+esc(a.comment)+'</span>'+
    '<button data-act="'+(a.status==='open'?'resolve':'reopen')+'" data-id="'+a.id+'">'+(a.status==='open'?'Resolve':'Reopen')+'</button>'+
    '<button data-act="delete" data-id="'+a.id+'">Delete</button></div>'+
    '<div class="muted"><code>'+esc(a.selector)+'</code> · '+esc(a.url)+'</div>'+(a.reply?'<div>↳ '+esc(a.reply)+'</div>':'')+'</div>').join(''):'<div class="muted">Nothing yet — open a page with the overlay and click Annotate.</div>';
}
$('#list').addEventListener('click',async(e)=>{const b=e.target.closest('button');if(!b)return;const id=b.dataset.id;
  if(b.dataset.act==='delete')await call('DELETE','/api/annotations/'+id);else await call('PATCH','/api/annotations/'+id,{status:b.dataset.act==='resolve'?'resolved':'open'});load();});
$('#showResolved').onchange=load;
$('#copyTag').onclick=()=>navigator.clipboard.writeText(${JSON.stringify(tag)});
$('#copyMd').onclick=async()=>{const t=await (await fetch(BASE+'/api/export')).text();await navigator.clipboard.writeText(t);$('#copyMd').textContent='Copied';setTimeout(()=>$('#copyMd').textContent='Copy as ticket markdown',1500);};
let seq=0;async function loop(){for(;;){try{const r=await call('GET','/api/poll?since='+seq+'&timeout=25');if(r.seq!==seq){seq=r.seq;load();}}catch{await new Promise(s=>setTimeout(s,3000));}}}
load();loop();
</script></body></html>`;
}
