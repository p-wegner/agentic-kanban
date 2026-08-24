#!/usr/bin/env node
// Offline self-test: no board, no agents. Boots the dashboard against a temp fixture repo
// holding a tiny Node HTTP app, drives it through the dashboard API, checks the empty case.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}`); if (!cond) failures++; };

const get = (port, path, method = 'GET') => new Promise((res, rej) => {
  const req = http.request({ host: '127.0.0.1', port, path, method, timeout: 5000 }, (r) => {
    let body = '';
    r.on('data', (d) => (body += d));
    r.on('end', () => res({ code: r.statusCode, body }));
  });
  req.on('error', rej); req.on('timeout', () => { req.destroy(); rej(new Error('timeout')); });
  req.end();
});
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
const until = async (fn, timeoutMs, label) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await sleep(400); }
  throw new Error(`timeout waiting for ${label}`);
};

// fixture repo: one tiny app that reads PORT_FIXTURE from env
const repo = mkdtempSync(join(tmpdir(), 'ak-app-runner-selftest-'));
mkdirSync(join(repo, '.app-runner'), { recursive: true });
writeFileSync(join(repo, 'app.mjs'), `
import http from 'node:http';
http.createServer((req, res) => { res.writeHead(200); res.end(req.url === '/health' ? 'ok' : 'hello from fixture'); })
  .listen(Number(process.env.PORT_FIXTURE), '127.0.0.1');
`);
writeFileSync(join(repo, '.app-runner', 'apps.json'), JSON.stringify({
  version: 1,
  apps: [{ id: 'fixture', name: 'Fixture app', start: 'node app.mjs', portEnv: 'PORT_FIXTURE', healthPath: '/health', startTimeoutSec: 20 }],
}, null, 2));

// empty-case repo: no config at all
const emptyRepo = mkdtempSync(join(tmpdir(), 'ak-app-runner-empty-'));

let dash, dash2;
try {
  // --- dashboard against the fixture repo ---
  const port = await freePort();
  dash = spawn(process.execPath, [join(here, 'serve.mjs')], {
    env: { ...process.env, PORT: String(port), APP_RUNNER_REPO: repo, APP_RUNNER_PROJECT: 'selftest' },
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  });
  dash.stderr.on('data', () => {});
  await until(async () => (await get(port, '/health')).code === 200, 10000, 'dashboard /health');
  ok(true, 'dashboard binds PORT and answers /health');

  const state1 = JSON.parse((await get(port, '/api/state')).body);
  ok(state1.apps.length === 1 && state1.apps[0].status === 'stopped', 'state lists the fixture app as stopped');

  const started = JSON.parse((await get(port, '/api/apps/fixture/start', 'POST')).body);
  ok(started.ok && started.port > 0, `start allocates a port (${started.port}) and spawns`);
  await until(async () => JSON.parse((await get(port, '/api/state')).body).apps[0].healthy, 15000, 'app healthy');
  const running = JSON.parse((await get(port, '/api/state')).body).apps[0];
  ok(running.status === 'running' && running.healthy, 'app becomes running+healthy via portEnv');
  const direct = await get(running.port, '/');
  ok(direct.code === 200 && direct.body.includes('hello'), 'app itself answers on the allocated port');

  const dup = JSON.parse((await get(port, '/api/apps/fixture/start', 'POST')).body);
  ok(!!dup.error, 'double start is refused');

  const logs = JSON.parse((await get(port, '/api/apps/fixture/logs')).body);
  ok(logs.logs.some((l) => l.includes('started:')), 'logs captured');

  const stopped = JSON.parse((await get(port, '/api/apps/fixture/stop', 'POST')).body);
  ok(stopped.ok === true, 'stop succeeds');
  await until(async () => {
    const a = JSON.parse((await get(port, '/api/state')).body).apps[0];
    return a.status === 'stopped' && !a.healthy;
  }, 10000, 'app reported stopped');
  ok(true, 'app reported stopped and unhealthy after stop');

  const page = await get(port, '/');
  ok(page.code === 200 && page.body.includes('App Runner'), 'dashboard page renders');

  // --- empty case ---
  const port2 = await freePort();
  dash2 = spawn(process.execPath, [join(here, 'serve.mjs')], {
    env: { ...process.env, PORT: String(port2), APP_RUNNER_REPO: emptyRepo },
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  });
  await until(async () => (await get(port2, '/health')).code === 200, 10000, 'empty dashboard /health');
  const emptyState = JSON.parse((await get(port2, '/api/state')).body);
  ok(emptyState.missing === true, 'missing config reported as missing, not as an error');
  const emptyPage = await get(port2, '/');
  ok(emptyPage.code === 200, 'empty case still renders a 200 page');
} catch (e) {
  console.log(`FAIL ${e.message}`);
  failures++;
} finally {
  for (const d of [dash, dash2]) if (d && !d.killed) d.kill();
  await sleep(300);
  for (const dir of [repo, emptyRepo]) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* win file locks */ } }
}
console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
