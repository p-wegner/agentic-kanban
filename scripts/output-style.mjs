#!/usr/bin/env node
// output-style.mjs — profile the STYLE of a single Claude session WITHOUT
// reading every token. Two modes:
//   (default)  ASSISTANT output style — tool mix, prose-vs-tool ratio,
//              message-length distribution, markdown/formatting habits,
//              opening-phrase tics, thinking-block count, representative prose.
//   --human    PROMPTING style — the human's real typed prompts: count,
//              length distribution, lowercase/imperative/question tics,
//              opening phrases, and the prompts themselves as samples.
// Pulls a few representative samples so a human/agent can characterize "how
// this session wrote / how it was driven" cheaply.
//
// Usage:
//   node scripts/output-style.mjs <session.jsonl>          # assistant style
//   node scripts/output-style.mjs <session.jsonl> --human  # prompting style
//   node scripts/output-style.mjs --latest                 # newest session here
//   node scripts/output-style.mjs <file> --samples 6       # N samples (default 4)
//   node scripts/output-style.mjs <file> --json            # machine-readable
//
// Reads only the file you point at — O(one session), not a fleet scan.
// To FIND the session to profile, rank first:  node scripts/session-rank.mjs --by output

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const has  = (n) => args.includes(n);
const SAMPLES = parseInt(flag('--samples', '4'), 10);
const JSON_OUT = has('--json');
const HUMAN = has('--human');

function resolveTarget() {
  const explicit = args.find(a => a.endsWith('.jsonl'));
  if (explicit) return explicit;
  if (has('--latest')) {
    // map cwd -> claude project dir (replace separators with --, drive colon dropped)
    const cwd = process.cwd();
    const slug = cwd.replace(/:/g, '').replace(/[\\/]/g, '-').replace(/^-/, 'C--'.startsWith('C') ? '' : '');
    const projDir = path.join(os.homedir(), '.claude', 'projects',
      'C--' + cwd.replace(/^[A-Za-z]:[\\/]/, '').replace(/[\\/]/g, '-'));
    if (!fs.existsSync(projDir)) { console.error('No project dir at', projDir); process.exit(1); }
    const f = fs.readdirSync(projDir).filter(x => x.endsWith('.jsonl'))
      .map(x => ({ x, m: fs.statSync(path.join(projDir, x)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0];
    return path.join(projDir, f.x);
  }
  console.error('Pass a <session>.jsonl path or --latest'); process.exit(1);
}

const file = resolveTarget();
const lines = fs.readFileSync(file, 'utf8').split('\n');

const sum = a => a.reduce((x, y) => x + y, 0);
const pct = (n, d) => d ? Math.round((n / d) * 100) : 0;
const quant = (a, q) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

// ================= HUMAN (prompting style) MODE =================
if (HUMAN) {
  // Extract REAL human-typed prompts: skip tool_results, meta, harness echoes,
  // continuation summaries, slash-command wrappers, and bare interrupts.
  const NOISE = ['<command-name>', '<local-command-stdout>', '<command-message>',
    '<task-notification>', '<bash-input>', '<bash-stdout>', 'Caveat:',
    'This session is being continued', '[Request interrupted', '[SESSION HANDOFF]'];
  const prompts = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.type !== 'user' || o.isMeta) continue;
    const m = o.message; if (!m || m.role !== 'user') continue;
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) {
      if (m.content.some(b => b && b.type === 'tool_result')) continue;
      text = m.content.filter(b => b && b.type === 'text').map(b => b.text).join('');
    }
    text = text.trim();
    if (!text) continue;
    if (NOISE.some(n => text.includes(n))) continue;
    prompts.push(text);
  }
  const wl = prompts.map(p => p.split(/\s+/).filter(Boolean).length);
  const lower = prompts.filter(p => /^[a-z]/.test(p)).length;
  const question = prompts.filter(p => p.includes('?')).length;
  const VERBS = /^(fix|add|make|implement|drive|start|stop|check|write|run|disable|enable|file|create|update|remove|use|let'?s|build|move|do|put|give|show|find|set)\b/i;
  const imperative = prompts.filter(p => VERBS.test(p)).length;
  const openers = {};
  for (const p of prompts) { const op = p.split(/\s+/).slice(0, 3).join(' ').toLowerCase().replace(/[*`#>]/g, ''); openers[op] = (openers[op] || 0) + 1; }
  const topOp = Object.entries(openers).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const longest = [...prompts].sort((a, b) => b.length - a.length).slice(0, SAMPLES);
  if (JSON_OUT) {
    console.log(JSON.stringify({ file: path.basename(file), prompts: prompts.length,
      words: { min: quant(wl, 0), median: quant(wl, 0.5), p90: quant(wl, 0.9), max: Math.max(0, ...wl) },
      lowercaseStart: lower, questions: question, imperatives: imperative, topOpeners: topOp, allPrompts: prompts }, null, 2));
    process.exit(0);
  }
  console.log(`\n■ PROMPTING-STYLE PROFILE — ${path.basename(file)}`);
  console.log(`  human prompts ${prompts.length}`);
  console.log(`  prompt length (words): min ${quant(wl, 0)} · median ${quant(wl, 0.5)} · p90 ${quant(wl, 0.9)} · max ${Math.max(0, ...wl)}`);
  console.log(`  lowercase-start ${lower}/${prompts.length} (${pct(lower, prompts.length)}%) · questions ${question} (${pct(question, prompts.length)}%) · imperative-open ${imperative} (${pct(imperative, prompts.length)}%)`);
  console.log(`\n  Opening tics (first 3 words):`);
  for (const [op, n] of topOp) console.log(`    ${String(n).padStart(3)}×  ${op}`);
  console.log(`\n  All prompts (chronological, truncated):`);
  prompts.forEach((p, i) => console.log(`    [${i + 1}] ${p.replace(/\n+/g, ' ⏎ ').slice(0, 200)}`));
  console.log('');
  process.exit(0);
}

// ================= ASSISTANT (output style) MODE =================
// ---- accumulators ----
const tools = {};            // tool name -> count
let turns = 0;               // assistant entries
let textBlocks = 0, toolBlocks = 0, thinkingBlocks = 0;
let textWords = 0, thinkWords = 0;
const blockWordLens = [];    // words per text block (for distribution)
const md = { headers: 0, bullets: 0, numbered: 0, bold: 0, codeFence: 0, inlineCode: 0, tables: 0, links: 0, blockquote: 0 };
let emoji = 0;
const openers = {};          // first ~4 words of each prose block, lowercased
const samples = [];          // {words, text}
let outTokens = 0;
const stopReasons = {};
const emojiRe = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u;

for (const l of lines) {
  if (!l.trim()) continue;
  let o; try { o = JSON.parse(l); } catch { continue; }
  if (o.type !== 'assistant') continue;
  const m = o.message; if (!m) continue;
  turns++;
  if (m.usage) outTokens += (m.usage.output_tokens || 0);
  if (m.stop_reason) stopReasons[m.stop_reason] = (stopReasons[m.stop_reason] || 0) + 1;
  const blocks = Array.isArray(m.content) ? m.content : (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : []);
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === 'tool_use') { toolBlocks++; tools[b.name] = (tools[b.name] || 0) + 1; continue; }
    if (b.type === 'thinking') { thinkingBlocks++; thinkWords += (b.thinking || '').split(/\s+/).filter(Boolean).length; continue; }
    if (b.type === 'text') {
      const t = b.text || ''; if (!t.trim()) continue;
      textBlocks++;
      const words = t.split(/\s+/).filter(Boolean).length;
      textWords += words; blockWordLens.push(words);
      // markdown / formatting habits (per line where relevant)
      for (const line of t.split('\n')) {
        if (/^#{1,6}\s/.test(line)) md.headers++;
        if (/^\s*[-*]\s/.test(line)) md.bullets++;
        if (/^\s*\d+\.\s/.test(line)) md.numbered++;
        if (/^\s*\|.*\|/.test(line) && /---/.test(line)) md.tables++;
        if (/^\s*>/.test(line)) md.blockquote++;
      }
      md.bold      += (t.match(/\*\*[^*]+\*\*/g) || []).length;
      md.codeFence += (t.match(/```/g) || []).length / 2 | 0;
      md.inlineCode+= (t.match(/`[^`]+`/g) || []).length;
      md.links     += (t.match(/\[[^\]]+\]\([^)]+\)/g) || []).length;
      if (emojiRe.test(t)) emoji++;
      const op = t.trim().split(/\s+/).slice(0, 4).join(' ').toLowerCase().replace(/[*`#>]/g, '');
      openers[op] = (openers[op] || 0) + 1;
      samples.push({ words, text: t.trim() });
    }
  }
}

const topTools = Object.entries(tools).sort((a, b) => b[1] - a[1]);
const topOpeners = Object.entries(openers).filter(([k]) => k).sort((a, b) => b[1] - a[1]).slice(0, 12);
const longSamples = [...samples].sort((a, b) => b.words - a.words).slice(0, SAMPLES);

const report = {
  file: path.basename(file),
  assistantTurns: turns,
  outputTokens: outTokens,
  blocks: { text: textBlocks, tool: toolBlocks, thinking: thinkingBlocks },
  proseToToolRatio: toolBlocks ? +(textBlocks / toolBlocks).toFixed(2) : null,
  toolCallsPerTurn: turns ? +(toolBlocks / turns).toFixed(2) : 0,
  proseWords: textWords,
  thinkingBlocks,            // note: thinking TEXT is stripped from transcripts (signature only) — count only
  thinkingPerTurn: turns ? +(thinkingBlocks / turns).toFixed(2) : 0,
  proseBlockWords: { min: quant(blockWordLens, 0), median: quant(blockWordLens, 0.5), p90: quant(blockWordLens, 0.9), max: Math.max(0, ...blockWordLens) },
  toolMix: topTools,
  formatting: md,
  emojiBlocks: emoji,
  stopReasons,
  topOpeners,
};

if (JSON_OUT) { console.log(JSON.stringify({ ...report, samples: longSamples }, null, 2)); process.exit(0); }

// ---- human report ----
const bar = (n, max, w = 24) => '█'.repeat(Math.max(0, Math.round((n / (max || 1)) * w)));
console.log(`\n■ OUTPUT-STYLE PROFILE — ${report.file}`);
console.log(`  assistant turns ${turns}  ·  output tokens ${outTokens.toLocaleString()}  ·  stop_reasons ${JSON.stringify(stopReasons)}`);
console.log(`\n  Blocks: ${textBlocks} prose · ${toolBlocks} tool · ${thinkingBlocks} thinking`);
console.log(`  Prose:tool block ratio ${report.proseToToolRatio}   (1 prose block per ${toolBlocks && (toolBlocks/textBlocks).toFixed(1)} tool calls)`);
console.log(`  Tool calls / turn ${report.toolCallsPerTurn}`);
console.log(`  Prose words ${textWords.toLocaleString()} · thinking blocks ${thinkingBlocks} (${report.thinkingPerTurn}/turn; text stripped from transcript)`);
console.log(`  Prose block length (words): min ${report.proseBlockWords.min} · median ${report.proseBlockWords.median} · p90 ${report.proseBlockWords.p90} · max ${report.proseBlockWords.max}`);

console.log(`\n  Tool mix (${toolBlocks} calls):`);
const tmax = topTools[0]?.[1] || 1;
for (const [name, n] of topTools.slice(0, 14)) console.log(`    ${String(n).padStart(5)} ${pct(n, toolBlocks).toString().padStart(3)}%  ${bar(n, tmax, 18)} ${name}`);

console.log(`\n  Formatting habits (counts):`);
console.log(`    headers ${md.headers} · bullets ${md.bullets} · numbered ${md.numbered} · tables ${md.tables} · blockquotes ${md.blockquote}`);
console.log(`    **bold** ${md.bold} · \`inline\` ${md.inlineCode} · fences ${md.codeFence} · md-links ${md.links} · emoji-blocks ${emoji}`);

console.log(`\n  Opening-phrase tics (first 4 words):`);
for (const [op, n] of topOpeners) console.log(`    ${String(n).padStart(4)}×  ${op}`);

console.log(`\n  ${SAMPLES} longest prose blocks (representative voice):`);
for (const s of longSamples) {
  const t = s.text.replace(/\n+/g, ' ⏎ ').slice(0, 340);
  console.log(`    [${s.words}w] ${t}${s.text.length > 340 ? ' …' : ''}`);
}
console.log('');
