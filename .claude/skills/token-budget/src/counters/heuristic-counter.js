'use strict';
/*
 * Dependency-free token estimate. Always available — the universal fallback.
 *
 * Uses a chars-per-token ratio tuned per family. These are rough; good enough
 * for RELATIVE comparison (which file is biggest, before/after a rewrite), not
 * for billing. Concrete tokenizers in sibling files supersede this when present.
 *
 * Ratios are placeholders pending references/tokenizers.md (the deep-research
 * pass measuring real chars/token for current models).
 */

// avg characters per token, by family (English prose / code mix)
const CHARS_PER_TOKEN = {
  claude: 3.6,
  openai: 4.0,
  gemini: 4.0,
  heuristic: 4.0,
};

function makeCounter(ratio, name) {
  return {
    name,
    estimate: true,
    count(text) {
      if (!text) return 0;
      // blend char-based and whitespace-token-based estimates for stability
      const byChars = text.length / ratio;
      const byWords = text.trim().split(/\s+/).length / 0.75; // ~0.75 words/token
      return Math.ceil((byChars + byWords) / 2);
    },
  };
}

function forFamily(family) {
  const ratio = CHARS_PER_TOKEN[family] || CHARS_PER_TOKEN.heuristic;
  return makeCounter(ratio, `heuristic:${family}`);
}

module.exports = { forFamily, makeCounter, CHARS_PER_TOKEN };
