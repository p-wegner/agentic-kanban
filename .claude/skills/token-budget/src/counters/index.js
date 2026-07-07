'use strict';
/*
 * Counter registry. A counter is `{ name, count(text)->number, estimate, note?,
 * exact?(text,model)->Promise<number> }`.
 *
 * Architecture follows the 2026 research verdict (references/tokenizers.md):
 * ONE shared local normalizer — o200k_base — is the offline metric for every
 * family (it's exact for OpenAI and a good relative proxy for Claude/Gemini,
 * which have no portable local tokenizer). Optional per-provider `exact` API
 * paths give billing-grade counts when online (--exact).
 *
 * Adding a model family = add one file + a FAMILY entry. The CLI only talks to
 * this module.
 */

const heuristic = require('./heuristic-counter');

const FAMILY = {
  'opus-4.8': 'claude', 'sonnet-4.6': 'claude', 'haiku-4.5': 'claude',
  'fable-5': 'claude', 'claude': 'claude',
  'gpt-5.5': 'openai', 'gpt-5.4': 'openai', 'gpt': 'openai', 'openai': 'openai',
  'gemini': 'gemini',
  'heuristic': 'heuristic',
};

function familyOf(model) {
  if (!model) return 'openai'; // default: o200k_base — best shared cross-model estimate
  return FAMILY[String(model).toLowerCase()] || 'heuristic';
}

function tryLoad(path) {
  try { return require(path); } catch { return null; }
}

// the shared local metric: o200k_base when gpt-tokenizer is installed, else the
// dependency-free heuristic. Everything else is built on top of this.
function normalizer() {
  return tryLoad('./tiktoken-counter') || heuristic.forFamily('openai');
}

function resolveCounter(model /*, opts */) {
  const family = familyOf(model);
  if (family === 'heuristic') return heuristic.forFamily('heuristic');

  const base = normalizer();
  if (family === 'openai') return base; // exact for OpenAI when tiktoken present
  if (family === 'claude') return require('./claude-counter').make(base);
  if (family === 'gemini') return require('./gemini-counter').make(base);
  return base;
}

module.exports = { resolveCounter, familyOf, normalizer, FAMILY };
