#!/usr/bin/env node
// output-style.mjs — profile the STYLE of agent session(s) WITHOUT reading every
// token. Works on Claude (~/.claude/projects/*.jsonl) AND Copilot
// (~/.copilot/session-state/<uuid>/events.jsonl); format is auto-detected.
//
// Modes:
//   (default)  ASSISTANT output style — tool mix, prose-vs-tool ratio,
//              silent (tool-only) turn %, message-length distribution,
//              markdown/formatting tics, reasoning volume, representative prose.
//   --human    PROMPTING style — the human's typed prompts: count, length dist,
//              lowercase/imperative/question tics, opening phrases, samples.
//
// Targets (single OR fleet — one shared profile is computed across all):
//   <file.jsonl>                  one Claude session, OR a Copilot events.jsonl
//   --latest                      newest Claude session for this cwd's project
//   --copilot                     ALL Copilot sessions (~/.copilot/session-state)
//   --fleet <dir>                 aggregate every session under <dir>
//   --builders                    (fleet) keep only worktree/feature builder sessions
//   --top N                       (fleet) cap to N largest sessions by bytes
//
//   --samples N (default 4) · --json
//
// Find what to profile first:  node scripts/session-rank.mjs --by output

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const has  = (n) => args.includes(n);
const SAMPLES = parseInt(flag('--samples', '4'), 10);
const JSON_OUT = has('--json');
const HUMAN = has('--human');
const BUILDERS = has('--builders');
const TOP = parseInt(flag('--top', '0'), 10);

const sum = a => a.reduce((x, y) => x + y, 0);
const pct = (n, d) => d ? Math.round((n / d) * 100) : 0;
const quant = (a, q) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

// ---------- target resolution ----------
function claudeProjDir() {
  const cwd = process.cwd();
  return path.join(os.homedir(), '.claude', 'projects',
    'C--' + cwd.replace(/^[A-Za-z]:[\\/]/, '').replace(/[\\/]/g, '-'));
}
function listFleet() {
  let files = [];
  if (has('--copilot')) {
    const root = path.join(os.homedir(), '.copilot', 'session-state');
    files = fs.readdirSync(root).map(d => path.join(root, d, 'events.jsonl')).filter(f => fs.existsSync(f));
  } else {
    const dir = flag('--fleet', null);
    if (!fs.existsSync(dir)) { console.error('No dir:', dir); process.exit(1); }
    // copilot-style (<uuid>/events.jsonl) or claude-style (*.jsonl)?
    const sub = fs.readdirSync(dir);
    if (sub.some(s => fs.existsSync(path.join(dir, s, 'events.jsonl'))))
      files = sub.map(d => path.join(dir, d, 'events.jsonl')).filter(f => fs.existsSync(f));
    else files = sub.filter(s => s.endsWith('.jsonl')).map(s => path.join(dir, s));
  }
  if (TOP > 0) files = files.map(f => ({ f, s: fs.statSync(f).size })).sort((a, b) => b.s - a.s).slice(0, TOP).map(x => x.f);
  return files;
}
function targets() {
  const explicit = args.find(a => a.endsWith('.jsonl'));
  if (explicit) return [explicit];
  if (has('--copilot') || has('--fleet')) return listFleet();
  if (has('--latest')) {
    const d = claudeProjDir();
    if (!fs.existsSync(d)) { console.error('No project dir', d); process.exit(1); }
    const f = fs.readdirSync(d).filter(x => x.endsWith('.jsonl'))
      .map(x => ({ x, m: fs.statSync(path.join(d, x)).mtimeMs })).sort((a, b) => b.m - a.m)[0];
    return [path.join(d, f.x)];
  }
  console.error('Pass <file>.jsonl | --latest | --copilot | --fleet <dir>'); process.exit(1);
}

const FILES = targets();
const isFleet = FILES.length > 1;

// ---------- format detection ----------
function detectFormat(lines) {
  for (const l of lines) { if (!l.trim()) continue; let o; try { o = JSON.parse(l); } catch { continue; }
    if (typeof o.type === 'string' && /^(session|assistant|user|tool|hook|system)\./.test(o.type)) return 'copilot';
    return 'claude'; }
  return 'claude';
}
function builderCwd(lines) {
  for (const l of lines) { if (!l.includes('session.start')) continue; let o; try { o = JSON.parse(l); } catch { continue; }
    const cwd = o.data?.context?.cwd || o.data?.cwd || ''; return cwd; }
  return '';
}
const isBuilder = cwd => /worktree|feature[_-]ak-|[\\/]\.worktrees[\\/]/i.test(cwd);

// ---------- shared accumulator ----------
const acc = {
  files: 0, turns: 0, outTokens: 0,
  textBlocks: 0, toolBlocks: 0, reasoningBlocks: 0, silentToolTurns: 0,
  textWords: 0, reasoningWords: 0,
  blockWordLens: [], tools: {}, openers: {}, stop: {},
  md: { headers: 0, bullets: 0, numbered: 0, bold: 0, codeFence: 0, inlineCode: 0, tables: 0, links: 0, blockquote: 0 },
  emoji: 0, samples: [], prompts: [],
};
const emojiRe = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u;
const NOISE = ['<command-name>', '<local-command-stdout>', '<command-message>', '<task-notification>',
  '<bash-input>', '<bash-stdout>', 'Caveat:', 'This session is being continued', '[Request interrupted', '[SESSION HANDOFF]'];

function eatProse(t) {
  if (!t.trim()) return;
  acc.textBlocks++;
  const words = t.split(/\s+/).filter(Boolean).length;
  acc.textWords += words; acc.blockWordLens.push(words);
  for (const line of t.split('\n')) {
    if (/^#{1,6}\s/.test(line)) acc.md.headers++;
    if (/^\s*[-*]\s/.test(line)) acc.md.bullets++;
    if (/^\s*\d+\.\s/.test(line)) acc.md.numbered++;
    if (/^\s*\|.*\|/.test(line) && /---/.test(line)) acc.md.tables++;
    if (/^\s*>/.test(line)) acc.md.blockquote++;
  }
  acc.md.bold += (t.match(/\*\*[^*]+\*\*/g) || []).length;
  acc.md.codeFence += ((t.match(/```/g) || []).length / 2) | 0;
  acc.md.inlineCode += (t.match(/`[^`]+`/g) || []).length;
  acc.md.links += (t.match(/\[[^\]]+\]\([^)]+\)/g) || []).length;
  if (emojiRe.test(t)) acc.emoji++;
  const op = t.trim().split(/\s+/).slice(0, 4).join(' ').toLowerCase().replace(/[*`#>]/g, '');
  if (op) acc.openers[op] = (acc.openers[op] || 0) + 1;
  acc.samples.push({ words, text: t.trim() });
}
function eatPrompt(text) {
  text = (text || '').trim();
  if (!text || NOISE.some(n => text.includes(n))) return;
  acc.prompts.push(text);
}

function parseClaude(lines) {
  for (const l of lines) { if (!l.trim()) continue; let o; try { o = JSON.parse(l); } catch { continue; }
    if (HUMAN) {
      if (o.type !== 'user' || o.isMeta) continue;
      const m = o.message; if (!m || m.role !== 'user') continue;
      let text = ''; if (typeof m.content === 'string') text = m.content;
      else if (Array.isArray(m.content)) { if (m.content.some(b => b && b.type === 'tool_result')) continue; text = m.content.filter(b => b && b.type === 'text').map(b => b.text).join(''); }
      eatPrompt(text); continue;
    }
    if (o.type !== 'assistant' || !o.message) continue;
    acc.turns++;
    if (o.message.usage) acc.outTokens += o.message.usage.output_tokens || 0;
    if (o.message.stop_reason) acc.stop[o.message.stop_reason] = (acc.stop[o.message.stop_reason] || 0) + 1;
    const blocks = Array.isArray(o.message.content) ? o.message.content : (typeof o.message.content === 'string' ? [{ type: 'text', text: o.message.content }] : []);
    let toolsThis = 0, textThis = false;
    for (const b of blocks) { if (!b) continue;
      if (b.type === 'tool_use') { acc.toolBlocks++; toolsThis++; acc.tools[b.name] = (acc.tools[b.name] || 0) + 1; }
      else if (b.type === 'thinking') { acc.reasoningBlocks++; } // text stripped in claude
      else if (b.type === 'text' && b.text?.trim()) { textThis = true; eatProse(b.text); }
    }
    if (toolsThis > 0 && !textThis) acc.silentToolTurns++;
  }
}
function parseCopilot(lines) {
  for (const l of lines) { if (!l.trim()) continue; let o; try { o = JSON.parse(l); } catch { continue; }
    const d = o.data || {};
    if (HUMAN) { if (o.type === 'user.message') eatPrompt(typeof d.content === 'string' ? d.content : (d.content?.map?.(c => c.text).join('') || '')); continue; }
    if (o.type === 'session.shutdown' && d.shutdownType) acc.stop[d.shutdownType] = (acc.stop[d.shutdownType] || 0) + 1;
    if (o.type !== 'assistant.message') continue;
    acc.turns++;
    acc.outTokens += d.outputTokens || 0;
    if (d.reasoningText && d.reasoningText.trim()) { acc.reasoningBlocks++; acc.reasoningWords += d.reasoningText.split(/\s+/).filter(Boolean).length; }
    const reqs = Array.isArray(d.toolRequests) ? d.toolRequests : [];
    for (const r of reqs) { acc.toolBlocks++; const n = r.name || r.toolName || '?'; acc.tools[n] = (acc.tools[n] || 0) + 1; }
    const text = typeof d.content === 'string' ? d.content : (Array.isArray(d.content) ? d.content.map(c => c.text || '').join('') : '');
    if (text.trim()) eatProse(text); else if (reqs.length) acc.silentToolTurns++;
  }
}

let skippedNonBuilder = 0;
for (const f of FILES) {
  let lines; try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch { continue; }
  const fmt = detectFormat(lines);
  if (BUILDERS && fmt === 'copilot' && !isBuilder(builderCwd(lines))) { skippedNonBuilder++; continue; }
  acc.files++;
  if (fmt === 'copilot') parseCopilot(lines); else parseClaude(lines);
}

// ---------- HUMAN report ----------
if (HUMAN) {
  const P = acc.prompts; const wl = P.map(p => p.split(/\s+/).filter(Boolean).length);
  const lower = P.filter(p => /^[a-z]/.test(p)).length, question = P.filter(p => p.includes('?')).length;
  const VERBS = /^(fix|add|make|implement|drive|start|stop|check|write|run|disable|enable|file|create|update|remove|use|let'?s|build|move|do|put|give|show|find|set)\b/i;
  const imperative = P.filter(p => VERBS.test(p)).length;
  const openers = {}; for (const p of P) { const op = p.split(/\s+/).slice(0, 3).join(' ').toLowerCase().replace(/[*`#>]/g, ''); openers[op] = (openers[op] || 0) + 1; }
  const topOp = Object.entries(openers).sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (JSON_OUT) { console.log(JSON.stringify({ files: acc.files, prompts: P.length, words: { median: quant(wl, 0.5), p90: quant(wl, 0.9), max: Math.max(0, ...wl) }, lowercaseStart: lower, questions: question, imperatives: imperative, topOpeners: topOp, allPrompts: isFleet ? undefined : P }, null, 2)); process.exit(0); }
  console.log(`\n■ PROMPTING-STYLE — ${acc.files} session(s)`);
  console.log(`  human prompts ${P.length} · length(words) median ${quant(wl, 0.5)} · p90 ${quant(wl, 0.9)} · max ${Math.max(0, ...wl)}`);
  console.log(`  lowercase-start ${pct(lower, P.length)}% · questions ${pct(question, P.length)}% · imperative-open ${pct(imperative, P.length)}%`);
  console.log(`\n  Opening tics:`); for (const [op, n] of topOp) console.log(`    ${String(n).padStart(3)}×  ${op}`);
  if (!isFleet) { console.log(`\n  Prompts:`); P.forEach((p, i) => console.log(`    [${i + 1}] ${p.replace(/\n+/g, ' ⏎ ').slice(0, 200)}`)); }
  console.log(''); process.exit(0);
}

// ---------- ASSISTANT report ----------
const topTools = Object.entries(acc.tools).sort((a, b) => b[1] - a[1]);
const topOpeners = Object.entries(acc.openers).filter(([k]) => k).sort((a, b) => b[1] - a[1]).slice(0, 12);
const longSamples = [...acc.samples].sort((a, b) => b.words - a.words).slice(0, SAMPLES);
const report = {
  scope: isFleet ? `${acc.files} sessions${BUILDERS ? ' (builders)' : ''}` : path.basename(FILES[0]),
  assistantTurns: acc.turns, outputTokens: acc.outTokens,
  blocks: { text: acc.textBlocks, tool: acc.toolBlocks, reasoning: acc.reasoningBlocks },
  silentToolTurnPct: pct(acc.silentToolTurns, acc.turns),
  proseToToolRatio: acc.toolBlocks ? +(acc.textBlocks / acc.toolBlocks).toFixed(2) : null,
  toolCallsPerTurn: acc.turns ? +(acc.toolBlocks / acc.turns).toFixed(2) : 0,
  proseWords: acc.textWords, reasoningWords: acc.reasoningWords,
  proseBlockWords: { median: quant(acc.blockWordLens, 0.5), p90: quant(acc.blockWordLens, 0.9), max: Math.max(0, ...acc.blockWordLens) },
  toolMix: topTools, formatting: acc.md, emojiBlocks: acc.emoji, stop: acc.stop, topOpeners,
};
if (JSON_OUT) { console.log(JSON.stringify({ ...report, samples: longSamples }, null, 2)); process.exit(0); }

const bar = (n, max, w = 18) => '█'.repeat(Math.max(0, Math.round((n / (max || 1)) * w)));
console.log(`\n■ OUTPUT-STYLE — ${report.scope}`);
if (skippedNonBuilder) console.log(`  (skipped ${skippedNonBuilder} non-builder sessions)`);
console.log(`  turns ${acc.turns}  ·  output tokens ${acc.outTokens.toLocaleString()}  ·  end/shutdown ${JSON.stringify(acc.stop)}`);
console.log(`\n  Blocks: ${acc.textBlocks} prose · ${acc.toolBlocks} tool · ${acc.reasoningBlocks} reasoning`);
console.log(`  Silent (tool-only, no prose) turns: ${report.silentToolTurnPct}%`);
console.log(`  Prose:tool ratio ${report.proseToToolRatio} · tool calls/turn ${report.toolCallsPerTurn}`);
console.log(`  Prose words ${acc.textWords.toLocaleString()} · reasoning words ${acc.reasoningWords.toLocaleString()}${acc.reasoningWords ? '' : ' (stripped/none)'}`);
console.log(`  Prose block length (words): median ${report.proseBlockWords.median} · p90 ${report.proseBlockWords.p90} · max ${report.proseBlockWords.max}`);
console.log(`\n  Tool mix (${acc.toolBlocks} calls):`);
const tmax = topTools[0]?.[1] || 1;
for (const [name, n] of topTools.slice(0, 14)) console.log(`    ${String(n).padStart(6)} ${pct(n, acc.toolBlocks).toString().padStart(3)}%  ${bar(n, tmax)} ${name}`);
console.log(`\n  Formatting: headers ${acc.md.headers} · bullets ${acc.md.bullets} · numbered ${acc.md.numbered} · tables ${acc.md.tables} · **bold** ${acc.md.bold} · \`inline\` ${acc.md.inlineCode} · fences ${acc.md.codeFence} · emoji ${acc.emoji}`);
console.log(`\n  Opening-phrase tics:`); for (const [op, n] of topOpeners) console.log(`    ${String(n).padStart(4)}×  ${op}`);
console.log(`\n  ${SAMPLES} longest prose blocks:`);
for (const s of longSamples) { const t = s.text.replace(/\n+/g, ' ⏎ ').slice(0, 320); console.log(`    [${s.words}w] ${t}${s.text.length > 320 ? ' …' : ''}`); }
console.log('');
