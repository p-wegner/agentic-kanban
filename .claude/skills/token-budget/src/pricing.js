'use strict';
/*
 * Per-model price table (USD per 1M tokens), for ESTIMATING cost from a raw
 * transcript — which records tokens but not dollars. The `claude -p
 * --output-format json` envelope already carries Anthropic-computed
 * `costUSD`/`total_cost_usd`; prefer that (see claude-run.js). This table is a
 * fallback for `tokt session` on transcripts that were never captured with
 * --output-format json (e.g. interactive sessions).
 *
 * Rates sourced from the claude-api skill (cached 2026-06-24). Cache reads bill
 * at ~0.1x input; cache writes at 1.25x (5m TTL) or 2x (1h TTL). Sonnet 5 has an
 * intro discount through 2026-08-31 but we use the sticker rate to avoid a
 * time-dependent estimate. Update when pricing moves; this is an estimate only.
 */

// [inputPerM, outputPerM] in USD/1M tokens. Cache rates derived from input.
const RATES = [
  [/fable-5|mythos-5|mythos-preview/, [10, 50]],
  [/opus-4/, [5, 25]],
  [/sonnet-4|sonnet-5/, [3, 15]],
  [/haiku-4/, [1, 5]],
  [/haiku-3/, [0.8, 4]],
];

const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2.0;

function ratesFor(model) {
  const id = String(model || '').toLowerCase();
  for (const [re, r] of RATES) if (re.test(id)) return r;
  return null; // unknown model — caller reports cost as unavailable
}

/*
 * Estimate USD for one usage record. `u` uses raw-transcript field names
 * (input_tokens, output_tokens, cache_read_input_tokens,
 * cache_creation_input_tokens, and optional cache_creation.ephemeral_{5m,1h}).
 */
function costForUsage(model, u) {
  const r = ratesFor(model);
  if (!r) return null;
  const [inPerM, outPerM] = r;
  const inTok = u.input_tokens || 0;
  const outTok = u.output_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheCreate = u.cache_creation_input_tokens || 0;
  const cc = u.cache_creation || {};
  const w5 = cc.ephemeral_5m_input_tokens;
  const w1 = cc.ephemeral_1h_input_tokens;
  // Use the 5m/1h split when present; otherwise treat all creation as 5m.
  let writeCost;
  if (w5 != null || w1 != null) {
    writeCost = ((w5 || 0) * CACHE_WRITE_5M_MULT + (w1 || 0) * CACHE_WRITE_1H_MULT) * inPerM / 1e6;
  } else {
    writeCost = cacheCreate * CACHE_WRITE_5M_MULT * inPerM / 1e6;
  }
  return (
    (inTok * inPerM + outTok * outPerM + cacheRead * inPerM * CACHE_READ_MULT) / 1e6 +
    writeCost
  );
}

module.exports = { ratesFor, costForUsage };
