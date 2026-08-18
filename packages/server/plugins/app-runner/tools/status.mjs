#!/usr/bin/env node
// Read-only: report whether .app-runner/apps.json exists and is valid, and what it declares.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const repo = process.env.APP_RUNNER_REPO;
if (!repo || !existsSync(repo)) {
  console.log(`APP_RUNNER_REPO not set or missing: ${repo}`);
  process.exit(1);
}
const file = join(repo, '.app-runner', 'apps.json');
if (!existsSync(file)) {
  console.log(`no run profile yet: ${file} does not exist.`);
  console.log('Run the app-runner-discover skill to create one.');
  process.exit(0);
}
let cfg;
try { cfg = JSON.parse(readFileSync(file, 'utf8')); }
catch (e) { console.log(`INVALID: ${file} is not JSON: ${e.message}`); process.exit(1); }
const apps = Array.isArray(cfg.apps) ? cfg.apps : [];
console.log(`${file}: ${apps.length} app(s)`);
let bad = 0;
for (const a of apps) {
  const problems = [];
  if (!a.id || !/^[a-z0-9-]+$/.test(a.id)) problems.push('bad id');
  if (!a.name) problems.push('no name');
  if (!a.start) problems.push('no start command');
  if (!a.port && !a.portEnv) problems.push('neither port nor portEnv');
  bad += problems.length ? 1 : 0;
  console.log(`  - ${a.id ?? '?'} (${a.name ?? '?'}) start: ${a.start ?? '?'} port: ${a.port ?? `env:${a.portEnv}`}`
    + (problems.length ? `  PROBLEMS: ${problems.join(', ')}` : ''));
}
process.exit(bad ? 1 : 0);
