#!/usr/bin/env node
// Offline self-test: boots the collector against a temp data dir and drives create / list / update /
// long-poll / export / delete through its HTTP API. No board, no browser.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}`); if (!cond) failures++; };
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

const dataDir = mkdtempSync(join(tmpdir(), 'ak-ui-annotate-selftest-'));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { code: r.status, body: text, json: () => JSON.parse(text) };
};

const srv = spawn(process.execPath, [join(here, 'serve.mjs')], {
  env: { ...process.env, PORT: String(port), UI_ANNOTATE_REPO: 'selftest', UI_ANNOTATE_DATA_DIR: dataDir, UI_ANNOTATE_PROJECT: 'selftest' },
  stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
});
srv.stderr.on('data', () => {});
try {
  for (let i = 0; i < 50; i++) { if (await call('GET', '/health').then((r) => r.code === 200).catch(() => false)) break; await sleep(200); }
  ok((await call('GET', '/health')).code === 200, 'collector binds PORT and answers /health');
  ok((await call('GET', '/overlay.js')).body.includes('__uiAnnotate'), 'serves the overlay script');
  ok((await call('GET', '/')).body.includes('/overlay.js'), 'dashboard shows the overlay snippet');

  ok((await call('POST', '/api/annotations', { selector: 'a' })).code === 400, 'rejects an annotation without a comment');

  const payload = { url: 'http://app.test/board', title: 'Board', selector: '#save', tag: 'button', text: 'Save', comment: 'Button is too small', rect: { x: 1, y: 2, w: 30, h: 10 }, viewport: { w: 1200, h: 800 } };
  const created = (await call('POST', '/api/annotations', payload)).json().annotation;
  ok(created.id === 1 && created.status === 'open', 'creates an open annotation with id 1');

  // long-poll resolves when a new annotation arrives
  const pending = call('GET', `/api/poll?since=${(await call('GET', '/api/annotations')).json().seq}&timeout=10`);
  await sleep(300);
  await call('POST', '/api/annotations', { ...payload, selector: '#cancel', comment: 'Wrong colour' });
  const polled = (await pending).json();
  ok(polled.annotations.length === 1 && polled.annotations[0].comment === 'Wrong colour', 'long-poll returns the new annotation as soon as it is created');

  const idle = (await call('GET', `/api/poll?since=${polled.seq}&timeout=1`)).json();
  ok(idle.annotations.length === 0, 'long-poll times out empty when nothing changes');

  const patched = (await call('PATCH', '/api/annotations/1', { status: 'resolved', reply: 'fixed' })).json().annotation;
  ok(patched.status === 'resolved' && patched.reply === 'fixed', 'PATCH resolves and replies');

  const md = (await call('GET', '/api/export')).body;
  ok(md.includes('Wrong colour') && !md.includes('Button is too small'), 'markdown export lists open items only');
  ok((await call('GET', '/api/export?all=1')).body.includes('Button is too small'), 'export ?all=1 includes resolved items');

  srv.kill();
  await sleep(300);
  const second = spawn(process.execPath, [join(here, 'serve.mjs')], {
    env: { ...process.env, PORT: String(port), UI_ANNOTATE_REPO: 'selftest', UI_ANNOTATE_DATA_DIR: dataDir },
    stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true,
  });
  for (let i = 0; i < 50; i++) { if (await call('GET', '/health').then((r) => r.code === 200).catch(() => false)) break; await sleep(200); }
  ok((await call('GET', '/api/annotations')).json().annotations.length === 2, 'annotations survive a collector restart');

  ok((await call('DELETE', '/api/annotations/2')).code === 200 && (await call('DELETE', '/api/annotations/2')).code === 404, 'DELETE removes once, then 404s');
  second.kill();
} catch (e) {
  console.log(`FAIL unexpected error: ${e.message}`);
  failures++;
} finally {
  srv.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
