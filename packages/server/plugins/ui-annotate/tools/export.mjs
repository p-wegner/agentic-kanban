#!/usr/bin/env node
// Print the collected annotations as ticket-ready markdown (default) or JSON (--json).
// Reads the store file directly, so it works whether or not the collector is running.
//   node tools/export.mjs [--json] [--all] [--session <name>]
import { readFileSync, existsSync } from 'node:fs';
import { storePath, exportMarkdown } from './lib/store.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const session = args.includes('--session') ? args[args.indexOf('--session') + 1] : undefined;

const file = storePath();
const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { annotations: [] };
let list = state.annotations || [];
if (session) list = list.filter((a) => a.session === session);
if (flag('--json')) {
  console.log(JSON.stringify(flag('--all') ? list : list.filter((a) => a.status === 'open'), null, 2));
} else {
  console.log(exportMarkdown(list, { includeResolved: flag('--all') }));
}
