#!/usr/bin/env node
'use strict';
/*
 * tokt — token-budget CLI.
 *
 *   tokt count "text"                 count a string
 *   tokt count --file path            count a file
 *   tokt scan <dir|file> [opts]       per-file token table + total
 *   tokt skill <dir>                  progressive-disclosure cost of a skill
 *   tokt audit <file>                 flag likely token bloat
 *   tokt run "<prompt>" [-- ...]      run claude -p; report exact cost + tokens
 *   tokt cost <envelope|->            cost + tokens from a captured json envelope
 *   tokt result <envelope|->          print just the run's output text (no jq)
 *   tokt session <id|path>            reconstruct cost from a session transcript
 *
 * Options:
 *   --model <id>    opus-4.8 | sonnet-4.6 | gpt-5.5 | gemini | heuristic (default: openai estimate)
 *   --glob <pat>    filter scan, e.g. star-star-slash-star.md
 *   --top <n>       show only the N biggest files
 *   --all           include all extensions (not just known text types)
 *   --exact         use exact (API) counter where available (Claude)
 *   --json          machine-readable output
 */

const fs = require('fs');
const { resolveCounter } = require('../src/counters');
const { scan } = require('../src/scan');
const { audit } = require('../src/audit');
const { analyzeSkill } = require('../src/skill');
const { runClaude, parseEnvelope, normalizeEnvelope } = require('../src/claude-run');
const { analyzeSession } = require('../src/session-cost');
const { scanTable, skillReport, claudeRunReport, sessionCostReport, fmt } = require('../src/report');

function parse(argv) {
  const o = { _: [], extra: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { o.extra = argv.slice(i + 1); break; } // rest → passthrough to `claude`
    else if (a === '--file') o.file = argv[++i];
    else if (a === '--model' || a === '-m') o.model = argv[++i];
    else if (a === '--glob' || a === '-g') o.glob = argv[++i];
    else if (a === '--top' || a === '-t') o.top = parseInt(argv[++i], 10);
    else if (a === '--all') o.all = true;
    else if (a === '--exact') o.exact = true;
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else o._.push(a);
  }
  return o;
}

function usage() {
  console.log(`tokt — token-budget CLI

  tokt count "text"            tokt count --file <path>
  tokt scan <dir|file>         [--glob "**/*.md"] [--top 20] [--all]
  tokt skill <dir>             progressive-disclosure cost (name/desc → body → refs)
  tokt audit <file>

  measure a spawned Claude Code run (exact, subagent-inclusive):
  tokt run "<prompt>" [-- <claude flags>]   run claude -p and report cost+tokens
  tokt cost <envelope.json|->                parse a saved --output-format json envelope
  tokt result <envelope.json|->              print just the run's output text (no jq needed)
  tokt session <id|transcript|dir>           reconstruct cost from a session transcript

  --model  opus-4.8|sonnet-4.6|haiku-4.5|gpt-5.5|gpt-5.4|gemini|heuristic
  --exact  use API counter where available (Claude; needs ANTHROPIC_API_KEY)
  --json   machine-readable output

  run passthrough: everything after -- goes to claude, e.g.
    tokt run "hi" -- --model haiku --allowedTools "Task"`);
}

// show the counter's caveat once, on stderr, so it doesn't pollute stdout/JSON
function showNote(counter, o) {
  if (!o.json && counter.note) console.error(`note: ${counter.note}`);
}

async function main() {
  const o = parse(process.argv.slice(2));
  const cmd = o._[0];
  if (o.help || !cmd) return usage();

  const counter = resolveCounter(o.model);

  if (cmd === 'count') {
    let text = o.file ? fs.readFileSync(o.file, 'utf8') : o._.slice(1).join(' ');
    if (!text) { console.error('nothing to count (pass text or --file)'); process.exit(1); }
    let n, label = counter.name;
    if (o.exact && counter.exact) {
      try { n = await counter.exact(text, o.model); label = `exact:api (${o.model || 'default'})`; }
      catch (e) { console.error(`exact count failed (${e.message}); using local estimate`); }
    } else if (o.exact) {
      console.error(`note: --exact has no API counter for this model; using local estimate`);
    }
    if (n == null) { n = counter.count(text); showNote(counter, o); }
    if (o.json) return console.log(JSON.stringify({ tokens: n, counter: label }));
    return console.log(`${fmt(n)} tokens  (${label})`);
  }

  if (cmd === 'scan') {
    const target = o._[1];
    if (!target) { console.error('scan needs a path'); process.exit(1); }
    if (o.exact) console.error('note: --exact applies to `count` only; scan uses the local estimate (avoids per-file API calls)');
    const res = scan(target, { counter, glob: o.glob, includeAll: o.all });
    showNote(counter, o);
    if (o.json) return console.log(JSON.stringify(res, null, 2));
    return console.log(scanTable(res, { top: o.top || 0 }));
  }

  if (cmd === 'skill') {
    const target = o._[1] || '.';
    const res = analyzeSkill(target, counter);
    showNote(counter, o);
    if (o.json) return console.log(JSON.stringify(res, null, 2));
    return console.log(skillReport(res));
  }

  if (cmd === 'audit') {
    const target = o._[1];
    if (!target) { console.error('audit needs a file'); process.exit(1); }
    const text = fs.readFileSync(target, 'utf8');
    const res = audit(text, counter);
    if (o.json) return console.log(JSON.stringify(res, null, 2));
    console.log(`${target}: ${fmt(res.total)} tokens  (${counter.name})\n`);
    if (!res.findings.length) return console.log('no obvious bloat patterns found.');
    for (const f of res.findings) {
      const metric = f.tokens != null ? `~${fmt(f.tokens)} tok` : `${f.count}×`;
      console.log(`  • ${f.kind.padEnd(18)} ${String(metric).padStart(10)}  ${f.hint}`);
    }
    console.log(`\nSee references/optimization-guide.md before cutting; preserve all load-bearing instructions.`);
    return;
  }

  if (cmd === 'run') {
    const prompt = o._.slice(1).join(' ');
    if (!prompt) { console.error('run needs a prompt (tokt run "<prompt>" [-- <claude flags>])'); process.exit(1); }
    if (!o.json) console.error('running claude -p … (this makes a real, billable API call)');
    const { normalized, exitCode } = runClaude(prompt, { extra: o.extra });
    if (o.json) return console.log(JSON.stringify(normalized, null, 2));
    console.log(claudeRunReport(normalized));
    if (exitCode) process.exitCode = exitCode;
    return;
  }

  if (cmd === 'cost') {
    const src = o._[1];
    if (!src) { console.error('cost needs an envelope file or - for stdin'); process.exit(1); }
    const text = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8');
    const normalized = normalizeEnvelope(parseEnvelope(text));
    if (o.json) return console.log(JSON.stringify(normalized, null, 2));
    return console.log(claudeRunReport(normalized));
  }

  if (cmd === 'result') {
    const src = o._[1];
    if (!src) { console.error('result needs an envelope file or - for stdin'); process.exit(1); }
    const text = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8');
    const env = parseEnvelope(text);
    // The run's output text — what the agent produced/found. Print raw, nothing
    // else, so it can be graded/grepped without jq. Errored runs exit non-zero.
    if (typeof env.result === 'string') process.stdout.write(env.result);
    if (env.is_error) process.exitCode = 2;
    return;
  }

  if (cmd === 'session') {
    const target = o._[1];
    if (!target) { console.error('session needs a session id, transcript .jsonl, or session dir'); process.exit(1); }
    const res = analyzeSession(target);
    if (o.json) return console.log(JSON.stringify(res, null, 2));
    return console.log(sessionCostReport(res));
  }

  console.error(`unknown command: ${cmd}`);
  usage();
  process.exit(1);
}

main().catch((e) => { console.error('error:', e.message); process.exit(1); });
