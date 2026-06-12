#!/usr/bin/env node
// session-rank.mjs — rank the sessions in ONE Claude project dir by a metric,
// so "which session had the most user prompts / output tokens / turns / time"
// is a single command instead of an ad-hoc node one-liner.
//
// Pairs with output-style.mjs: rank to FIND the session, then profile it.
//   node scripts/session-rank.mjs --by output            # then:
//   node scripts/output-style.mjs <top-file>             # assistant style
//   node scripts/output-style.mjs <top-file> --human     # prompting style
//
// Usage:
//   node scripts/session-rank.mjs                         # this project, by prompts
//   node scripts/session-rank.mjs --by output             # prompts|output|turns|duration|cost
//   node scripts/session-rank.mjs --dir <projectDir>      # rank a different project
//   node scripts/session-rank.mjs --top 20 --json
//
// "prompts" = REAL human-typed prompts (same noise filter as output-style --human),
// not raw type:"user" rows (which include tool_results + <task-notification> echoes).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BY = flag('--by', 'prompts');
const TOP = parseInt(flag('--top', '15'), 10);
const JSON_OUT = args.includes('--json');

// approx Anthropic opus pricing for a rough cost proxy (per Mtok)
const PRICE = { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 };

let dir = flag('--dir', null);
if (!dir) {
  const cwd = process.cwd();
  dir = path.join(os.homedir(), '.claude', 'projects',
    'C--' + cwd.replace(/^[A-Za-z]:[\\/]/, '').replace(/[\\/]/g, '-'));
}
if (!fs.existsSync(dir)) { console.error('No project dir:', dir); process.exit(1); }

const NOISE = ['<command-name>', '<local-command-stdout>', '<command-message>',
  '<task-notification>', '<bash-input>', '<bash-stdout>', 'Caveat:',
  'This session is being continued', '[Request interrupted', '[SESSION HANDOFF]'];

const rows = [];
for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.jsonl'))) {
  let lines; try { lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n'); } catch { continue; }
  let prompts = 0, turns = 0, output = 0, cost = 0, first = null, last = null;
  for (const l of lines) {
    if (!l.trim()) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.timestamp) { if (!first) first = o.timestamp; last = o.timestamp; }
    if (o.type === 'assistant' && o.message) {
      turns++;
      const u = o.message.usage;
      if (u) {
        output += u.output_tokens || 0;
        cost += ((u.input_tokens || 0) * PRICE.in + (u.output_tokens || 0) * PRICE.out
          + (u.cache_read_input_tokens || 0) * PRICE.cacheRead
          + (u.cache_creation_input_tokens || 0) * PRICE.cacheWrite) / 1e6;
      }
    } else if (o.type === 'user' && !o.isMeta && o.message && o.message.role === 'user') {
      const c = o.message.content; let text = '';
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) { if (c.some(b => b && b.type === 'tool_result')) continue; text = c.filter(b => b && b.type === 'text').map(b => b.text).join(''); }
      text = text.trim();
      if (text && !NOISE.some(n => text.includes(n))) prompts++;
    }
  }
  const durMin = first && last ? Math.round((Date.parse(last) - Date.parse(first)) / 60000) : 0;
  rows.push({ file: f, prompts, turns, output, cost: +cost.toFixed(2), durationMin: durMin, start: first });
}

const key = { prompts: 'prompts', output: 'output', turns: 'turns', duration: 'durationMin', cost: 'cost' }[BY] || 'prompts';
rows.sort((a, b) => b[key] - a[key]);
const top = rows.slice(0, TOP);

if (JSON_OUT) { console.log(JSON.stringify({ dir, by: BY, rows: top }, null, 2)); process.exit(0); }

console.log(`\n■ SESSION RANK — ${path.basename(dir)}  ·  ${rows.length} sessions  ·  by ${BY}\n`);
console.log(`  ${'prompts'.padStart(7)} ${'turns'.padStart(6)} ${'output'.padStart(10)} ${'cost$'.padStart(7)} ${'min'.padStart(5)}  session`);
for (const r of top) {
  console.log(`  ${String(r.prompts).padStart(7)} ${String(r.turns).padStart(6)} ${r.output.toLocaleString().padStart(10)} ${String(r.cost).padStart(7)} ${String(r.durationMin).padStart(5)}  ${r.file}`);
}
console.log(`\n  → profile the top one:  node scripts/output-style.mjs "${path.join(dir, top[0]?.file || '')}"${BY === 'prompts' ? ' --human' : ''}\n`);
