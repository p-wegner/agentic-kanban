'use strict';
/*
 * OpenAI / shared-estimate counter via gpt-tokenizer (pure JS, offline).
 *
 * Uses o200k_base, the encoding for GPT-4o / GPT-5.x. This is also the best
 * single OFFLINE proxy for cross-model relative counts when an exact Claude /
 * Gemini tokenizer isn't bundled (see references/tokenizers.md for drift).
 *
 * Loaded lazily by index.js; if `gpt-tokenizer` isn't installed this throws and
 * the registry falls back to the heuristic counter.
 */

// o200k_base export path in gpt-tokenizer
const { encode } = require('gpt-tokenizer/model/gpt-4o');

module.exports = {
  name: 'tiktoken:o200k_base',
  estimate: false, // exact for OpenAI o200k_base models; a proxy for others
  count(text) {
    if (!text) return 0;
    return encode(text).length;
  },
};
