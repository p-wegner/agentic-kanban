#!/usr/bin/env node
// App Runner dashboard — zero-dependency supervised view server for the agentic-kanban board.
//
// Env:  PORT               port to bind (set by the board)
//       APP_RUNNER_REPO    absolute path of the project's leading repo
//       APP_RUNNER_PROJECT project display name (optional, cosmetic)
//
// Reads <repo>/.app-runner/apps.json FRESH per request. Config schema (version 1):
//   { "version": 1, "apps": [ {
//       "id": "backend",              // required, [a-z0-9-]+, unique
//       "name": "Helpdesk backend",   // required
//       "cwd": ".",                   // repo-relative working dir (default ".")
//       "start": "cmd or script",     // required — run via the platform shell, must stay in
//                                     // the FOREGROUND and keep the app in its process tree
//       "build": "cmd",               // optional one-shot build, run via Build button
//       "port": 8080,                 // fixed port the app binds, OR:
//       "portEnv": "PORT",            // env var the app reads — dashboard allocates a free port
//       "healthPath": "/health",      // probed on the app port (default "/")
//       "openPath": "/",              // path for the preview iframe / open link (default "/")
//       "env": { "K": "V" },          // extra env for start
//       "startTimeoutSec": 60,        // how long until a non-healthy start counts as failed
//       "notes": "free text shown on the card"
//   } ] }
//
// Process state lives in memory + a pid registry in the OS tmpdir (NEVER in the repo — a dirty
// main checkout blocks the board's auto-merge). If the dashboard restarts while apps run, the
// registry lets it adopt them: health + stop still work, logs are gone.

import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';

const PORT = Number(process.env.PORT || 0);
const REPO = process.env.APP_RUNNER_REPO || '';
const PROJECT = process.env.APP_RUNNER_PROJECT || '';
const IS_WIN = process.platform === 'win32';
const LOG_LINES = 400;

const registryPath = () => {
  const dir = join(os.tmpdir(), 'app-runner');
  mkdirSync(dir, { recursive: true });
  const hash = crypto.createHash('sha1').update(REPO.toLowerCase()).digest('hex').slice(0, 12);
  return join(dir, `${hash}.json`);
};

// ---------- config ----------
function loadConfig() {
  if (!REPO) return { error: 'APP_RUNNER_REPO is not set' };
  if (!existsSync(REPO)) return { error: `repo path does not exist: ${REPO}` };
  const file = join(REPO, '.app-runner', 'apps.json');
  if (!existsSync(file)) return { missing: true, file };
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { return { error: `.app-runner/apps.json is not valid JSON: ${e.message}`, file }; }
  const problems = [];
  const apps = Array.isArray(raw.apps) ? raw.apps : [];
  if (!Array.isArray(raw.apps)) problems.push('"apps" must be an array');
  const seen = new Set();
  for (const a of apps) {
    if (!a || typeof a !== 'object') { problems.push('an apps[] entry is not an object'); continue; }
    if (!a.id || !/^[a-z0-9-]+$/.test(a.id)) problems.push(`app id ${JSON.stringify(a.id)} must match [a-z0-9-]+`);
    else if (seen.has(a.id)) problems.push(`duplicate app id "${a.id}"`);
    else seen.add(a.id);
    if (!a.name) problems.push(`app "${a.id}": "name" is required`);
    if (!a.start || typeof a.start !== 'string') problems.push(`app "${a.id}": "start" (string) is required`);
    if (!a.port && !a.portEnv) problems.push(`app "${a.id}": one of "port" (fixed) or "portEnv" is required`);
    if (a.cwd && (isAbsolute(a.cwd) || a.cwd.includes('..'))) problems.push(`app "${a.id}": "cwd" must be repo-relative without ..`);
  }
  return { apps, problems, file };
}

// ---------- process supervision ----------
/** id -> { proc, pid, port, startedAt, status, exitCode, logs: string[], adopted, lastError } */
const runtime = new Map();

function persistRegistry() {
  const entries = [];
  for (const [id, r] of runtime) {
    if ((r.status === 'running' || r.status === 'starting') && r.pid) {
      entries.push({ id, pid: r.pid, port: r.port, startedAt: r.startedAt });
    }
  }
  try { writeFileSync(registryPath(), JSON.stringify({ repo: REPO, entries }, null, 2)); } catch { /* best effort */ }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function adoptFromRegistry() {
  try {
    const reg = JSON.parse(readFileSync(registryPath(), 'utf8'));
    for (const e of reg.entries || []) {
      if (e.pid && pidAlive(e.pid)) {
        runtime.set(e.id, {
          proc: null, pid: e.pid, port: e.port, startedAt: e.startedAt,
          status: 'running', exitCode: null, adopted: true,
          logs: ['[app-runner] adopted a process started by a previous dashboard instance — logs unavailable'],
        });
      }
    }
  } catch { /* no registry yet */ }
  persistRegistry();
}

function pushLog(r, chunk) {
  const lines = String(chunk).split(/\r?\n/).filter((l) => l.length);
  r.logs.push(...lines);
  if (r.logs.length > LOG_LINES) r.logs.splice(0, r.logs.length - LOG_LINES);
}

function freePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => res(p));
    });
    srv.on('error', rej);
  });
}

function probe(port, path, timeoutMs = 1500) {
  return new Promise((res) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (r) => {
      r.resume();
      res(r.statusCode < 500);
    });
    req.on('timeout', () => { req.destroy(); res(false); });
    req.on('error', () => res(false));
  });
}

async function startApp(app) {
  const existing = runtime.get(app.id);
  if (existing && (existing.status === 'running' || existing.status === 'starting')) {
    return { error: `app "${app.id}" is already ${existing.status}` };
  }
  const port = app.port || await freePort();
  const cwd = resolve(REPO, app.cwd || '.');
  if (!existsSync(cwd)) return { error: `cwd does not exist: ${cwd}` };
  if (app.port && await probe(port, app.healthPath || '/', 700)) {
    return { error: `port ${port} already answers — something else (or an orphan) is running there` };
  }
  const env = { ...process.env, ...(app.env || {}) };
  if (app.portEnv) env[app.portEnv] = String(port);
  const r = {
    proc: null, pid: null, port, startedAt: new Date().toISOString(),
    status: 'starting', exitCode: null, adopted: false, logs: [], lastError: null,
  };
  runtime.set(app.id, r);
  let proc;
  try {
    proc = spawn(app.start, { cwd, env, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    r.status = 'failed'; r.lastError = e.message;
    return { error: e.message };
  }
  r.proc = proc; r.pid = proc.pid;
  pushLog(r, `[app-runner] started: ${app.start} (pid ${proc.pid}, port ${port}, cwd ${cwd})`);
  proc.stdout.on('data', (d) => pushLog(r, d));
  proc.stderr.on('data', (d) => pushLog(r, d));
  proc.on('error', (e) => { r.status = 'failed'; r.lastError = e.message; pushLog(r, `[app-runner] spawn error: ${e.message}`); persistRegistry(); });
  proc.on('exit', (code) => {
    r.exitCode = code;
    if (r.status !== 'stopping') r.status = code === 0 ? 'exited' : 'failed';
    else r.status = 'stopped';
    r.proc = null;
    pushLog(r, `[app-runner] process exited with code ${code}`);
    persistRegistry();
  });
  persistRegistry();

  // background readiness watcher: flips starting -> running on first healthy probe
  const deadline = Date.now() + (app.startTimeoutSec || 60) * 1000;
  const path = app.healthPath || '/';
  (async () => {
    while (r.status === 'starting' && Date.now() < deadline) {
      if (await probe(port, path)) { r.status = 'running'; pushLog(r, `[app-runner] healthy on :${port}${path}`); persistRegistry(); return; }
      await new Promise((s) => setTimeout(s, 1000));
    }
    if (r.status === 'starting') {
      r.lastError = `not healthy within ${app.startTimeoutSec || 60}s (probing :${port}${path})`;
      pushLog(r, `[app-runner] ${r.lastError} — process left running; check logs or Stop it`);
      r.status = 'unhealthy';
    }
  })();
  return { ok: true, pid: proc.pid, port };
}

function killTree(pid) {
  return new Promise((res) => {
    if (IS_WIN) {
      const k = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      k.on('exit', () => res());
      k.on('error', () => res());
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
      res();
    }
  });
}

async function stopApp(id) {
  const r = runtime.get(id);
  if (!r || !r.pid || (r.status !== 'running' && r.status !== 'starting' && r.status !== 'unhealthy')) {
    return { error: `app "${id}" is not running` };
  }
  r.status = 'stopping';
  await killTree(r.pid);
  // adopted processes have no exit event — poll the pid
  if (r.adopted || !r.proc) {
    for (let i = 0; i < 20 && pidAlive(r.pid); i++) await new Promise((s) => setTimeout(s, 250));
    r.status = pidAlive(r.pid) ? 'running' : 'stopped';
    if (r.status === 'stopped') r.proc = null;
  }
  persistRegistry();
  return { ok: true };
}

const builds = new Map(); // id -> { status, logs, startedAt, exitCode }
function runBuild(app) {
  const existing = builds.get(app.id);
  if (existing && existing.status === 'running') return { error: 'build already running' };
  const b = { status: 'running', logs: [], startedAt: new Date().toISOString(), exitCode: null };
  builds.set(app.id, b);
  const cwd = resolve(REPO, app.cwd || '.');
  const proc = spawn(app.build, { cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const push = (d) => { b.logs.push(...String(d).split(/\r?\n/).filter(Boolean)); if (b.logs.length > LOG_LINES) b.logs.splice(0, b.logs.length - LOG_LINES); };
  push(`[app-runner] build: ${app.build}`);
  proc.stdout.on('data', push);
  proc.stderr.on('data', push);
  proc.on('error', (e) => { b.status = 'failed'; push(`[app-runner] ${e.message}`); });
  proc.on('exit', (code) => { b.exitCode = code; b.status = code === 0 ? 'ok' : 'failed'; push(`[app-runner] build exited ${code}`); });
  return { ok: true };
}

// ---------- state assembly ----------
async function stateFor(cfg) {
  const apps = [];
  for (const a of cfg.apps || []) {
    const r = runtime.get(a.id);
    const b = builds.get(a.id);
    let healthy = false;
    if (r && (r.status === 'running' || r.status === 'starting' || r.status === 'unhealthy')) {
      healthy = await probe(r.port, a.healthPath || '/', 1200);
      if (healthy && r.status !== 'running') { r.status = 'running'; persistRegistry(); }
      if (!healthy && r.status === 'running' && r.adopted && !pidAlive(r.pid)) { r.status = 'stopped'; persistRegistry(); }
    }
    apps.push({
      id: a.id, name: a.name, notes: a.notes || '', cwd: a.cwd || '.',
      start: a.start, build: a.build || null,
      fixedPort: a.port || null, portEnv: a.portEnv || null,
      healthPath: a.healthPath || '/', openPath: a.openPath || '/',
      status: r ? r.status : 'stopped',
      pid: r?.pid || null, port: r?.port || null, startedAt: r?.startedAt || null,
      adopted: r?.adopted || false, exitCode: r?.exitCode ?? null, lastError: r?.lastError || null,
      healthy,
      url: r?.port ? `http://127.0.0.1:${r.port}${a.openPath || '/'}` : null,
      build_status: b?.status || null,
    });
  }
  return { project: PROJECT, repo: REPO, configFile: cfg.file || null, missing: !!cfg.missing, error: cfg.error || null, problems: cfg.problems || [], apps };
}

// ---------- http ----------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  try {
    if (path === '/health') return json(res, 200, { ok: true });
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(pageHtml(url.searchParams.get('theme') || ''));
    }
    if (path === '/api/state') return json(res, 200, await stateFor(loadConfig()));
    const m = path.match(/^\/api\/apps\/([a-z0-9-]+)\/(start|stop|build|logs)$/);
    if (m) {
      const [, id, action] = m;
      const cfg = loadConfig();
      const app = (cfg.apps || []).find((a) => a.id === id);
      if (action === 'logs') {
        const r = runtime.get(id); const b = builds.get(id);
        return json(res, 200, { logs: r?.logs || [], build: b?.logs || [] });
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
      if (!app) return json(res, 404, { error: `no app "${id}" in .app-runner/apps.json` });
      if (action === 'start') return json(res, 200, await startApp(app));
      if (action === 'stop') return json(res, 200, await stopApp(id));
      if (action === 'build') {
        if (!app.build) return json(res, 400, { error: 'app declares no build command' });
        return json(res, 200, runBuild(app));
      }
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.error(`[app-runner] dashboard on http://127.0.0.1:${server.address().port} (repo: ${REPO})`);
  adoptFromRegistry();
});

async function shutdown() {
  // stop children we own so the board stopping the view doesn't orphan app processes
  const owned = [...runtime.entries()].filter(([, r]) => !r.adopted && r.pid && (r.status === 'running' || r.status === 'starting' || r.status === 'unhealthy'));
  await Promise.all(owned.map(([, r]) => killTree(r.pid)));
  for (const [, r] of owned) r.status = 'stopped';
  persistRegistry();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ---------- ui ----------
// ---------- ui ----------
// App-UI-first layout: a slim toolbar carries the controls; once an app is healthy its UI
// fills the whole panel as an iframe. Logs are a bottom drawer; stopped apps get a start card.
function pageHtml(theme) {
  return `<!doctype html><html${theme ? ` data-theme="${theme.replace(/[^a-z]/g, '')}"` : ''}><head><meta charset="utf-8">
<title>App Runner</title>
<style>
:root { --bg:#f6f7f9; --card:#fff; --fg:#1c2330; --muted:#68707f; --border:#dde1e8; --accent:#2563eb;
  --ok:#16a34a; --warn:#d97706; --err:#dc2626; --log-bg:#11151d; --log-fg:#cdd6e4; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg:#11151d; --card:#1a2030; --fg:#e6eaf2; --muted:#8b94a7; --border:#2a3245; --log-bg:#0b0e14; --log-fg:#b9c3d6; } }
:root[data-theme="dark"] { --bg:#11151d; --card:#1a2030; --fg:#e6eaf2; --muted:#8b94a7; --border:#2a3245; --log-bg:#0b0e14; --log-fg:#b9c3d6; }
* { box-sizing:border-box; }
html,body { height:100%; }
body { margin:0; background:var(--bg); color:var(--fg); font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;
  display:flex; flex-direction:column; }
.toolbar { flex:none; display:flex; align-items:center; gap:8px; padding:7px 10px; background:var(--card);
  border-bottom:1px solid var(--border); flex-wrap:wrap; }
.brand { font-weight:600; font-size:13px; white-space:nowrap; }
.tabs { display:flex; gap:4px; }
.tab { border:1px solid var(--border); background:transparent; color:var(--fg); border-radius:7px; padding:3px 10px;
  font:inherit; cursor:pointer; display:flex; align-items:center; gap:6px; }
.tab.active { border-color:var(--accent); color:var(--accent); font-weight:600; }
.dot { width:8px; height:8px; border-radius:50%; background:var(--muted); flex:none; }
.dot.running { background:var(--ok); } .dot.starting,.dot.unhealthy,.dot.stopping { background:var(--warn); } .dot.failed { background:var(--err); }
.badge { font-size:11px; border:1px solid var(--border); border-radius:99px; padding:0 8px; color:var(--muted); white-space:nowrap; }
.spacer { flex:1; }
button.act { background:var(--accent); color:#fff; border:0; border-radius:7px; padding:4px 12px; font:inherit; cursor:pointer; }
button.sec { background:transparent; color:var(--fg); border:1px solid var(--border); border-radius:7px; padding:4px 10px; font:inherit; cursor:pointer; }
button:disabled { opacity:.45; cursor:default; }
a.applink { color:var(--accent); font-size:12px; text-decoration:none; white-space:nowrap; }
.main { flex:1; min-height:0; position:relative; display:flex; }
iframe.appframe { flex:1; border:0; background:#fff; }
.center { flex:1; display:flex; align-items:center; justify-content:center; padding:24px; overflow:auto; }
.card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:22px 26px; max-width:640px; }
.card h2 { margin:0 0 6px; font-size:15px; }
.card .meta { color:var(--muted); font-size:12px; margin:4px 0; overflow-wrap:anywhere; }
.card code { background:var(--bg); border:1px solid var(--border); border-radius:5px; padding:1px 6px; }
.card .err { color:var(--err); font-size:12px; margin-top:8px; white-space:pre-wrap; }
.card .row { display:flex; gap:8px; margin-top:14px; flex-wrap:wrap; }
.problems { color:var(--err); white-space:pre-wrap; }
.drawer { flex:none; height:0; overflow:hidden; transition:height .15s; background:var(--log-bg); border-top:1px solid var(--border); }
.drawer.open { height:220px; }
.drawer pre { margin:0; height:100%; overflow:auto; padding:10px 12px; color:var(--log-fg);
  font:11.5px/1.45 ui-monospace,Consolas,monospace; white-space:pre-wrap; }
</style></head><body>
<div class="toolbar" id="toolbar"><span class="brand">App Runner${PROJECT ? ' · ' + esc(PROJECT) : ''}</span><span class="badge">loading…</span></div>
<div class="main" id="main"><div class="center"><div class="card"><h2>Loading…</h2></div></div></div>
<div class="drawer" id="drawer"><pre id="logpre">(no output yet)</pre></div>
<script>
const $ = (id) => document.getElementById(id);
function h(s){ return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
let sel = null, logsOpen = false, lastToolbar = '', lastMain = '', busy = false;
function goFull(){ (document.documentElement.requestFullscreen ? document.documentElement.requestFullscreen() : Promise.reject()).catch(()=>{}); }
async function act(id, action){ if (busy) return; busy = true; try {
    const r = await fetch('/api/apps/'+id+'/'+action, {method:'POST'}); const j = await r.json();
    if (j.error) alert(j.error);
  } finally { busy = false; lastToolbar = lastMain = ''; refresh(); } }
function pick(id){ sel = id; lastToolbar = lastMain = ''; refresh(); }
function toggleLogs(){ logsOpen = !logsOpen; $('drawer').classList.toggle('open', logsOpen); }
async function refresh(){
  let s; try { s = await (await fetch('/api/state')).json(); } catch { return; }
  const apps = s.apps || [];
  if (!apps.find(a => a.id === sel)) sel = apps.length ? apps[0].id : null;
  const a = apps.find(x => x.id === sel) || null;

  let tb = '<span class="brand">App Runner${PROJECT ? ' · ' + esc(PROJECT).replace(/'/g, "\\'") : ''}</span>';
  if (apps.length > 1) {
    tb += '<span class="tabs">' + apps.map(x =>
      '<button class="tab'+(x.id===sel?' active':'')+'" onclick="pick(\\''+x.id+'\\')"><span class="dot '+h(x.status)+'"></span>'+h(x.name)+'</button>').join('') + '</span>';
  } else if (a) {
    tb += '<span class="tab active" style="cursor:default"><span class="dot '+h(a.status)+'"></span>'+h(a.name)+'</span>';
  }
  if (a) {
    const running = a.status === 'running' || a.status === 'starting' || a.status === 'unhealthy';
    tb += '<span class="badge">'+h(a.status)+(a.adopted?' · adopted':'')+'</span>'
      + (a.port ? '<span class="badge">:'+a.port+'</span>' : '')
      + (a.build_status ? '<span class="badge">build '+h(a.build_status)+'</span>' : '')
      + '<span class="spacer"></span>'
      + (running ? '<button class="act" onclick="act(\\''+a.id+'\\',\\'stop\\')">Stop</button>'
                 : '<button class="act" onclick="act(\\''+a.id+'\\',\\'start\\')">Start</button>')
      + (a.build ? '<button class="sec" onclick="act(\\''+a.id+'\\',\\'build\\')"'+(a.build_status==='running'?' disabled':'')+'>Build</button>' : '')
      + '<button class="sec" onclick="toggleLogs()">Logs</button>'
      + (a.healthy && a.url ? '<a class="applink" href="'+h(a.url)+'" target="_blank" rel="noopener">open ↗</a>' : '')
      + '<button class="sec" onclick="goFull()">⛶</button>';
  } else { tb += '<span class="spacer"></span>'; }
  if (tb !== lastToolbar) { $('toolbar').innerHTML = tb; lastToolbar = tb; }

  let main;
  if (s.error) main = '<div class="center"><div class="card problems">'+h(s.error)+'</div></div>';
  else if (s.missing) main = '<div class="center"><div class="card"><h2>No run profile yet</h2>'
    + '<div class="meta">This repo has no <code>.app-runner/apps.json</code>.</div>'
    + '<div class="meta">Run the <b>app-runner-discover</b> skill from this plugin\\'s panel — it inspects the project, verifies a real start, and writes the run profile this dashboard uses.</div></div></div>';
  else if (s.problems && s.problems.length) main = '<div class="center"><div class="card problems">Config problems:\\n- '+s.problems.map(h).join('\\n- ')+'</div></div>';
  else if (!a) main = '<div class="center"><div class="card"><h2>No apps declared</h2><div class="meta"><code>.app-runner/apps.json</code> has an empty <code>apps</code> list.</div></div></div>';
  else if (a.healthy && a.url) main = '<iframe class="appframe" src="'+h(a.url)+'"></iframe>';
  else {
    const running = a.status === 'starting' || a.status === 'unhealthy';
    main = '<div class="center"><div class="card"><h2><span class="dot '+h(a.status)+'" style="display:inline-block;margin-right:6px"></span>'+h(a.name)+' — '+h(a.status)+'</h2>'
      + (a.notes ? '<div class="meta">'+h(a.notes)+'</div>' : '')
      + '<div class="meta">start: <code>'+h(a.start)+'</code>'+(a.build ? ' · build: <code>'+h(a.build)+'</code>' : '')+'</div>'
      + (running ? '<div class="meta">waiting for '+h(a.healthPath)+' on :'+a.port+' …</div>' : '')
      + (a.lastError ? '<div class="err">'+h(a.lastError)+'</div>' : '')
      + (a.exitCode !== null && a.status === 'failed' ? '<div class="err">exited with code '+a.exitCode+' — see Logs</div>' : '')
      + '<div class="row">'
      + (running ? '<button class="act" onclick="act(\\''+a.id+'\\',\\'stop\\')">Stop</button>'
                 : '<button class="act" onclick="act(\\''+a.id+'\\',\\'start\\')">Start '+h(a.name)+'</button>')
      + (a.build ? '<button class="sec" onclick="act(\\''+a.id+'\\',\\'build\\')"'+(a.build_status==='running'?' disabled':'')+'>Build</button>' : '')
      + '<button class="sec" onclick="toggleLogs()">Logs</button>'
      + '</div></div></div>';
  }
  if (main !== lastMain) { $('main').innerHTML = main; lastMain = main; }

  if (logsOpen && a) {
    fetch('/api/apps/'+a.id+'/logs').then(r=>r.json()).then(j=>{
      const all = (j.build && j.build.length ? j.build.concat(['']) : []).concat(j.logs||[]);
      const pre = $('logpre'); const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
      pre.textContent = all.slice(-250).join('\\n') || '(no output yet)';
      if (stick) pre.scrollTop = pre.scrollHeight;
    }).catch(()=>{});
  }
}
refresh(); setInterval(refresh, 2500);
</script></body></html>`;
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
