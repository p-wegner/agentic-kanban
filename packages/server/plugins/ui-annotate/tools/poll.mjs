#!/usr/bin/env node
// Long-poll the collector from any terminal/agent: blocks until annotations change (or the timeout
// elapses), prints the changed annotations as JSON, exits 0. Re-run with the printed `seq` as --since.
//   node tools/poll.mjs [--since <seq>] [--timeout <s>] [--session <name>] [--url <collector base>]
// The collector's URL is read from its endpoint file unless --url is given.
import { readFileSync, existsSync } from 'node:fs';
import { endpointPath } from './lib/store.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);

let base = opt('--url');
if (!base) {
  const f = endpointPath();
  if (!existsSync(f)) { console.error('collector not running (no endpoint file) — open the UI Annotate view first, or pass --url'); process.exit(2); }
  base = JSON.parse(readFileSync(f, 'utf8')).url;
}
const qs = new URLSearchParams({ since: opt('--since', '0'), timeout: opt('--timeout', '25') });
if (opt('--session')) qs.set('session', opt('--session'));
try {
  const r = await fetch(`${base}/api/poll?${qs}`);
  console.log(JSON.stringify(await r.json(), null, 2));
} catch (e) {
  console.error(`collector unreachable at ${base}: ${e.message}`);
  process.exit(2);
}
