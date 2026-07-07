'use strict';
/*
 * Run `claude -p` non-interactively and capture EXACT cost + token usage from
 * the result envelope — the easiest, authoritative route.
 *
 * `claude -p "<prompt>" --output-format json` prints a single JSON object whose
 * `total_cost_usd` and `modelUsage` are Anthropic-computed billing figures.
 * Crucially, `modelUsage` is keyed by model and AGGREGATES the whole run —
 * including any subagents (Task tool) and auxiliary calls (e.g. title
 * generation), which typically run on a different model and show up as extra
 * `modelUsage` keys. So the envelope already accounts for subagents; we don't
 * have to reconstruct them for a cost total. (For a per-subagent breakdown, see
 * session-cost.js, which walks the transcript's subagents/ dir.)
 */

const { spawnSync } = require('child_process');

// Resolve a bare command name to an absolute path so we can spawn without a
// shell (shell:true concatenates args, which breaks on spaces/quotes and is a
// deprecated foot-gun). If `bin` already looks like a path, use it as-is.
function resolveBin(bin) {
  if (/[\\/]/.test(bin)) return bin;
  const finder = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [bin] : ['-v', bin];
  const r = spawnSync(finder, args, { encoding: 'utf8', shell: process.platform !== 'win32' });
  const line = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return line || bin; // fall back to the bare name (may still work via PATH)
}

// Pull the authoritative result object out of either --output-format json (a
// single object) or --output-format stream-json (ndjson; the final line with
// type:"result" is the envelope).
function parseEnvelope(text) {
  const trimmed = String(text).trim();
  if (!trimmed) throw new Error('empty output (no result envelope)');
  // Fast path: a single JSON object.
  try {
    const o = JSON.parse(trimmed);
    if (o && o.type === 'result') return o;
    if (o && o.total_cost_usd != null) return o;
  } catch (_) { /* fall through to ndjson scan */ }
  // stream-json: scan lines bottom-up for the result envelope.
  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l) continue;
    try {
      const o = JSON.parse(l);
      if (o && o.type === 'result') return o;
    } catch (_) { /* skip non-JSON lines */ }
  }
  throw new Error('no result envelope found (need --output-format json or stream-json)');
}

// Normalize an envelope into a stable shape for reporting.
function normalizeEnvelope(env) {
  const mu = env.modelUsage || {};
  const models = Object.keys(mu).map((id) => {
    const m = mu[id];
    return {
      model: id,
      inputTokens: m.inputTokens || 0,
      outputTokens: m.outputTokens || 0,
      cacheReadInputTokens: m.cacheReadInputTokens || 0,
      cacheCreationInputTokens: m.cacheCreationInputTokens || 0,
      webSearchRequests: m.webSearchRequests || 0,
      costUSD: m.costUSD != null ? m.costUSD : null,
    };
  }).sort((a, b) => (b.costUSD || 0) - (a.costUSD || 0));

  const totals = models.reduce((t, m) => {
    t.inputTokens += m.inputTokens;
    t.outputTokens += m.outputTokens;
    t.cacheReadInputTokens += m.cacheReadInputTokens;
    t.cacheCreationInputTokens += m.cacheCreationInputTokens;
    return t;
  }, { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });

  return {
    sessionId: env.session_id || null,
    totalCostUSD: env.total_cost_usd != null ? env.total_cost_usd : null,
    numTurns: env.num_turns != null ? env.num_turns : null,
    durationMs: env.duration_ms != null ? env.duration_ms : null,
    isError: !!env.is_error,
    subtype: env.subtype || null,
    result: typeof env.result === 'string' ? env.result : null,
    permissionDenials: Array.isArray(env.permission_denials) ? env.permission_denials.length : 0,
    models,
    totals,
    multiModel: models.length > 1,
  };
}

// Spawn `claude -p <prompt> --output-format <fmt> [extra...]` and parse the
// envelope. `extra` is passed verbatim to claude (e.g. --model, --allowedTools).
function runClaude(prompt, { extra = [], format = 'json', bin = 'claude', timeout = 0 } = {}) {
  // Prompt goes on stdin (avoids arg-quoting/injection); flags stay as an argv
  // array so values with spaces/quotes survive without a shell.
  const args = ['-p', '--output-format', format, ...extra];
  const res = spawnSync(resolveBin(bin), args, {
    input: prompt,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeout || undefined,
  });
  if (res.error) throw new Error(`failed to spawn ${bin}: ${res.error.message}`);
  const out = res.stdout || '';
  let env;
  try {
    env = parseEnvelope(out);
  } catch (e) {
    const stderr = (res.stderr || '').trim().split(/\r?\n/).slice(-5).join('\n');
    throw new Error(`${e.message}${stderr ? `\n--- claude stderr (tail) ---\n${stderr}` : ''}`);
  }
  return { envelope: env, normalized: normalizeEnvelope(env), raw: out, exitCode: res.status };
}

module.exports = { parseEnvelope, normalizeEnvelope, runClaude };
