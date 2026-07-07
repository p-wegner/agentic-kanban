'use strict';
/* Tiny smoke test — no framework. `npm test`. */

const assert = require('assert');
const { resolveCounter, familyOf } = require('../src/counters');
const { scan } = require('../src/scan');
const { audit } = require('../src/audit');
const { analyzeSkill, parseFrontmatter } = require('../src/skill');
const { parseEnvelope, normalizeEnvelope } = require('../src/claude-run');
const { costForUsage, ratesFor } = require('../src/pricing');

let pass = 0;
function ok(name, fn) { try { fn(); console.log('  ✓', name); pass++; } catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; } }

console.log('token-budget smoke test');

ok('family resolution', () => {
  assert.strictEqual(familyOf('opus-4.8'), 'claude');
  assert.strictEqual(familyOf('gpt-5.5'), 'openai');
  assert.strictEqual(familyOf('gemini'), 'gemini');
  assert.strictEqual(familyOf('nonsense'), 'heuristic');
});

ok('counter always resolves + counts', () => {
  for (const m of ['opus-4.8', 'gpt-5.5', 'gemini', 'heuristic', undefined]) {
    const c = resolveCounter(m);
    assert.ok(typeof c.count === 'function', `${m} has count`);
    const n = c.count('The quick brown fox jumps over the lazy dog.');
    assert.ok(n > 0 && n < 50, `${m} -> ${n} tokens plausible`);
  }
});

ok('empty string is zero', () => {
  assert.strictEqual(resolveCounter('heuristic').count(''), 0);
});

ok('scan this repo finds files + nonzero total', () => {
  const res = scan(__dirname + '/..', { counter: resolveCounter('heuristic'), glob: '**/*.js' });
  assert.ok(res.files.length > 0, 'found js files');
  assert.ok(res.total > 0, 'nonzero total');
  assert.ok(res.files[0].tokens >= res.files[res.files.length - 1].tokens, 'sorted desc');
});

ok('scan size-caps large files and reports them (no silent drop)', () => {
  // tiny cap → this repo's own .js files exceed it → reported, not tokenized
  const res = scan(__dirname + '/..', { counter: resolveCounter('heuristic'), glob: '**/*.js', maxBytes: 200 });
  assert.ok(res.skippedLarge.length > 0, 'reported skipped large files');
  assert.ok(res.skippedLarge[0].bytes > 200, 'skipped entries carry size');
});

ok('audit flags duplicate lines', () => {
  const dup = 'this is a sufficiently long repeated line of text\n'.repeat(3);
  const res = audit(dup, resolveCounter('heuristic'));
  assert.ok(res.findings.some(f => f.kind === 'duplicate-lines'), 'found dupes');
});

ok('claude/gemini counters: o200k normalized offline + exact API hook', () => {
  for (const m of ['opus-4.8', 'gemini']) {
    const c = resolveCounter(m);
    assert.ok(c.estimate === true, `${m} marked as estimate`);
    assert.ok(typeof c.note === 'string' && c.note.length, `${m} has caveat note`);
    assert.ok(typeof c.exact === 'function', `${m} exposes async exact()`);
    // offline number must match the shared o200k_base normalizer
    const txt = 'The quick brown fox jumps over the lazy dog.';
    assert.strictEqual(c.count(txt), resolveCounter('gpt-5.5').count(txt), `${m} == o200k normalized`);
  }
  // openai is exact, no caveat
  assert.strictEqual(resolveCounter('gpt-5.5').estimate, false);
});

ok('frontmatter parse: name + description + body split', () => {
  const { name, description, body } = parseFrontmatter('---\nname: foo\ndescription: a thing it does\n---\nBody here mentions refs/x.md');
  assert.strictEqual(name, 'foo');
  assert.strictEqual(description, 'a thing it does');
  assert.ok(body.startsWith('Body here'));
});

ok('analyzeSkill tiers this repo + flags reachability', () => {
  const a = analyzeSkill(__dirname + '/..', resolveCounter('gpt-5.5'));
  assert.strictEqual(a.name, 'token-budget');
  assert.ok(a.tiers.alwaysOn > 0 && a.tiers.onInvoke > a.tiers.alwaysOn, 'body > desc');
  // references/*.md are linked from SKILL.md → on-demand, not orphaned
  assert.ok(a.tiers.onDemandDocs.some(f => f.path.includes('optimization-guide')), 'guide reachable');
  // README is a human doc, never a scary orphan
  assert.ok(a.notContext.humanDocs.some(f => /readme/i.test(f.path)), 'README = human doc');
  assert.strictEqual(a.notContext.orphanDocs.length, 0, 'no true orphans');
  assert.strictEqual(a.fullyExpanded, a.tiers.alwaysOn + a.tiers.onInvoke + a.tiers.onDemand, 'expanded = sum of tiers');
});

ok('parseEnvelope: single json object and stream-json ndjson', () => {
  const env = { type: 'result', total_cost_usd: 0.5, session_id: 's1', modelUsage: {} };
  assert.strictEqual(parseEnvelope(JSON.stringify(env)).session_id, 's1');
  // stream-json: result is the last type:"result" line amid other events
  const nd = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'assistant', message: {} }),
    JSON.stringify(env),
  ].join('\n');
  assert.strictEqual(parseEnvelope(nd).total_cost_usd, 0.5);
  assert.throws(() => parseEnvelope('not json at all'), /no result envelope|empty/);
});

ok('normalizeEnvelope: rolls up subagent model as a second key', () => {
  // main model + a subagent on a different model, as claude -p reports it
  const env = {
    type: 'result', session_id: 's2', total_cost_usd: 0.2418, num_turns: 2,
    modelUsage: {
      'claude-sonnet-5': { inputTokens: 12257, outputTokens: 876, cacheReadInputTokens: 85575, cacheCreationInputTokens: 33880, costUSD: 0.24117 },
      'claude-haiku-4-5-20251001': { inputTokens: 554, outputTokens: 14, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.000624 },
    },
  };
  const n = normalizeEnvelope(env);
  assert.strictEqual(n.multiModel, true, 'two models => subagent/aux present');
  assert.strictEqual(n.models[0].model, 'claude-sonnet-5', 'sorted by cost desc');
  assert.strictEqual(n.totals.inputTokens, 12811, 'input tokens summed across models');
  assert.strictEqual(n.totalCostUSD, 0.2418, 'authoritative total preserved');
});

ok('pricing: known models priced, unknown returns null', () => {
  assert.ok(ratesFor('claude-opus-4-8'), 'opus known');
  assert.strictEqual(ratesFor('gpt-5.5'), null, 'non-claude unknown');
  // output billed at output rate; a pure-output record is cheap but nonzero
  const c = costForUsage('claude-haiku-4-5-20251001', { output_tokens: 1_000_000 });
  assert.strictEqual(c, 5, 'haiku output = $5/1M');
  assert.strictEqual(costForUsage('mystery-model', { output_tokens: 100 }), null, 'unknown => null');
});

console.log(`\n${pass} checks passed`);
