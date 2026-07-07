'use strict';
/* Formatting helpers: scan tables, deltas, and the audit findings list. */

function fmt(n) { return n.toLocaleString('en-US'); }

function bar(frac, width = 20) {
  const filled = Math.round(frac * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function scanTable({ files, total, counter, skippedLarge = [] }, { top = 0 } = {}) {
  const rows = top > 0 ? files.slice(0, top) : files;
  const wPath = Math.max(4, ...rows.map(f => f.path.length));
  const lines = [];
  lines.push(`counter: ${counter}   files: ${files.length}   total: ${fmt(total)} tokens`);
  lines.push('');
  lines.push(`${'TOKENS'.padStart(9)}  ${'SHARE'.padEnd(22)}  FILE`);
  for (const f of rows) {
    const frac = total ? f.tokens / total : 0;
    lines.push(`${fmt(f.tokens).padStart(9)}  ${bar(frac)} ${(frac * 100).toFixed(1).padStart(4)}%  ${f.path.padEnd(wPath)}`);
  }
  if (top > 0 && files.length > top) {
    const rest = files.slice(top).reduce((s, f) => s + f.tokens, 0);
    lines.push(`${fmt(rest).padStart(9)}  ${' '.repeat(22)}  …${files.length - top} more files`);
  }
  if (skippedLarge.length) {
    const mb = (b) => `${(b / 1048576).toFixed(1)}MB`;
    lines.push('');
    lines.push(`skipped ${skippedLarge.length} large file(s) (>2MB, likely generated/minified — not tokenized):`);
    for (const f of skippedLarge.slice(0, 5)) lines.push(`  ${mb(f.bytes).padStart(8)}  ${f.path}`);
    if (skippedLarge.length > 5) lines.push(`  …and ${skippedLarge.length - 5} more`);
  }
  return lines.join('\n');
}

function delta(before, after) {
  const saved = before - after;
  const pct = before ? (saved / before) * 100 : 0;
  return `${fmt(before)} → ${fmt(after)} tokens  (${saved >= 0 ? '-' : '+'}${fmt(Math.abs(saved))}, ${pct.toFixed(1)}%)`;
}

function skillReport(a) {
  const L = [];
  const t = a.tiers;
  L.push(`skill: ${a.name || '(no name)'}    counter: ${a.counter}`);
  L.push('');
  L.push('CONTEXT COST (progressive disclosure — how an agent actually loads it)');
  L.push(`  ${'Tier 0  always-on'.padEnd(20)} ${fmt(t.alwaysOn).padStart(6)} tok   name+description — in context EVERY turn, every session`);
  L.push(`  ${'Tier 1  on-invoke'.padEnd(20)} ${fmt(t.onInvoke).padStart(6)} tok   SKILL.md body — loaded when the skill triggers`);
  L.push(`  ${'Tier 2  on-demand'.padEnd(20)} ${fmt(t.onDemand).padStart(6)} tok   reference docs — only if a pointer is followed`);
  for (const f of t.onDemandDocs) L.push(`  ${' '.repeat(20)} ${fmt(f.tokens).padStart(6)} tok     └ ${f.path}`);
  L.push(`  ${'─'.repeat(44)}`);
  L.push(`  ${'fully expanded'.padEnd(20)} ${fmt(a.fullyExpanded).padStart(6)} tok   worst case: invoked + every reachable doc read`);

  const nc = a.notContext;
  const codeTotal = nc.code.reduce((s, f) => s + f.tokens, 0);
  if (nc.code.length || nc.humanDocs.length || nc.orphanDocs.length) {
    L.push('');
    L.push('NOT CONTEXT (in the repo, never loaded into the window)');
    if (nc.code.length) L.push(`  ${'code/assets (run)'.padEnd(20)} ${fmt(codeTotal).padStart(6)} tok   ${nc.code.length} files — executed or ignored, not read`);
    for (const f of nc.humanDocs) L.push(`  ${'human doc'.padEnd(20)} ${fmt(f.tokens).padStart(6)} tok   ${f.path}  (for people, not agents)`);
    for (const f of nc.orphanDocs) L.push(`  ${'⚠ orphan doc'.padEnd(20)} ${fmt(f.tokens).padStart(6)} tok   ${f.path}  (no SKILL.md path reaches it — agents won't read it)`);
  }

  L.push('');
  // guidance focused on the highest-leverage tier
  if (t.alwaysOn > 120) L.push(`! Tier 0 is ${fmt(t.alwaysOn)} tok. The description loads every turn — keep it tight (aim <~100). This is the highest-leverage place to cut.`);
  if (nc.orphanDocs.length) L.push(`! ${nc.orphanDocs.length} orphan doc(s): either link them from SKILL.md or delete — as-is they cost repo weight but never help an agent.`);
  L.push('See references/optimization-guide.md; preserve every load-bearing instruction.');
  return L.join('\n');
}

function usd(n) {
  if (n == null) return '   n/a';
  if (n < 0.01) return `$${n.toFixed(5)}`;
  return `$${n.toFixed(4)}`;
}

// Report for `tokt run` / `tokt cost` — the authoritative envelope.
function claudeRunReport(n) {
  const L = [];
  L.push(`claude -p run   session: ${n.sessionId || '(unknown)'}`);
  if (n.result != null) {
    const r = n.result.replace(/\s+/g, ' ').trim();
    L.push(`  result: ${r.length > 80 ? r.slice(0, 77) + '…' : r}`);
  }
  const meta = [];
  if (n.numTurns != null) meta.push(`${n.numTurns} turn${n.numTurns === 1 ? '' : 's'}`);
  if (n.durationMs != null) meta.push(`${(n.durationMs / 1000).toFixed(1)}s`);
  if (n.isError) meta.push('ERROR');
  if (n.permissionDenials) meta.push(`${n.permissionDenials} permission denial(s)`);
  if (meta.length) L.push(`  ${meta.join('   ')}`);
  L.push('');
  L.push('COST + TOKENS (Anthropic-computed; includes subagents & aux calls)');
  L.push(`  ${'MODEL'.padEnd(26)} ${'COST'.padStart(11)} ${'INPUT'.padStart(9)} ${'OUTPUT'.padStart(8)} ${'CACHE-R'.padStart(9)} ${'CACHE-W'.padStart(9)}`);
  for (const m of n.models) {
    L.push(`  ${m.model.padEnd(26)} ${usd(m.costUSD).padStart(11)} ${fmt(m.inputTokens).padStart(9)} ${fmt(m.outputTokens).padStart(8)} ${fmt(m.cacheReadInputTokens).padStart(9)} ${fmt(m.cacheCreationInputTokens).padStart(9)}`);
  }
  L.push(`  ${'─'.repeat(75)}`);
  L.push(`  ${'TOTAL'.padEnd(26)} ${usd(n.totalCostUSD).padStart(11)} ${fmt(n.totals.inputTokens).padStart(9)} ${fmt(n.totals.outputTokens).padStart(8)} ${fmt(n.totals.cacheReadInputTokens).padStart(9)} ${fmt(n.totals.cacheCreationInputTokens).padStart(9)}`);
  if (n.multiModel) {
    L.push('');
    L.push(`  ${n.models.length} models billed — extra keys are subagents (Task) and/or aux calls (e.g. title generation).`);
  }
  return L.join('\n');
}

// Report for `tokt session` — reconstructed from a transcript, with per-subagent
// breakdown. Dollars are a local-table estimate.
function sessionCostReport(a) {
  const L = [];
  L.push(`session: ${a.session}   (reconstructed from transcript)`);
  L.push(`  ${a.transcript}`);
  L.push('');
  L.push('PER-MODEL (main + all subagents)   [$ = local-table ESTIMATE, not billed]');
  L.push(`  ${'MODEL'.padEnd(26)} ${'~COST'.padStart(11)} ${'MSGS'.padStart(5)} ${'INPUT'.padStart(9)} ${'OUTPUT'.padStart(8)} ${'CACHE-R'.padStart(9)} ${'CACHE-W'.padStart(9)}`);
  for (const m of a.models) {
    const c = m.costKnown ? usd(m.costUSD) : usd(m.costUSD) + '?';
    L.push(`  ${m.model.padEnd(26)} ${c.padStart(11)} ${fmt(m.messages).padStart(5)} ${fmt(m.input_tokens).padStart(9)} ${fmt(m.output_tokens).padStart(8)} ${fmt(m.cache_read_input_tokens).padStart(9)} ${fmt(m.cache_creation_input_tokens).padStart(9)}`);
  }
  L.push(`  ${'─'.repeat(81)}`);
  const gc = a.grand.costKnown ? usd(a.grand.costUSD) : usd(a.grand.costUSD) + '?';
  L.push(`  ${'TOTAL'.padEnd(26)} ${gc.padStart(11)} ${''.padStart(5)} ${fmt(a.grand.input_tokens).padStart(9)} ${fmt(a.grand.output_tokens).padStart(8)} ${fmt(a.grand.cache_read_input_tokens).padStart(9)} ${fmt(a.grand.cache_creation_input_tokens).padStart(9)}`);

  L.push('');
  L.push(`ATTRIBUTION   main: ${fmt(a.main.messages)} msg    subagents: ${a.subagents.length}`);
  for (const s of a.subagents) {
    const cost = s.models.reduce((t, m) => t + m.costUSD, 0);
    const known = s.models.every((m) => m.costKnown);
    const modelList = s.models.map((m) => m.model).join(', ') || '—';
    const label = s.agentType || '(unknown type)';
    const desc = s.description ? ` — ${s.description}` : '';
    L.push(`  ${('└ ' + label).padEnd(22)} ${(known ? usd(cost) : usd(cost) + '?').padStart(11)}   ${modelList}${desc}`);
  }
  if (!a.grand.costKnown) {
    L.push('');
    L.push('! "?" = a model had no price-table entry; its token counts are exact but cost is partial. Update src/pricing.js.');
  }
  L.push('');
  L.push('Note: cost is estimated from src/pricing.js. For billing-grade numbers, run via `tokt run` / capture `claude -p --output-format json` and use `tokt cost`.');
  return L.join('\n');
}

module.exports = { scanTable, skillReport, claudeRunReport, sessionCostReport, delta, fmt, bar, usd };
