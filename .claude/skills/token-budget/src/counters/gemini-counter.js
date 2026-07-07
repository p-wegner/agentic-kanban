'use strict';
/*
 * Gemini-family counter.
 *
 * Research verdict (June 2026): Google ships an official LOCAL tokenizer, but
 * only in the Python `google-genai` SDK (Gemma-3 SentencePiece for 2.x, HF
 * tokenizers for 3.x) — not portable to a Node skill, and it still fetches
 * artifacts on first use. So for a Node-first portable skill:
 *
 *   - offline → o200k_base shared normalizer (relative metric).
 *   - exact   → Gemini `countTokens` REST API (needs GEMINI_API_KEY /
 *               GOOGLE_API_KEY). Opt-in: --exact.
 *
 * If you target Gemini specifically and can use Python, vendor the google-genai
 * local tokenizer for a closer offline count (see references/tokenizers.md).
 */

const { postJson } = require('./_api');

const NOTE =
  'Gemini local tokenizer is Python-only (google-genai); counting with o200k_base as a ' +
  'relative metric. Use --exact for the Gemini countTokens API.';

const MODELS = { gemini: 'gemini-2.5-pro' };

async function exactViaApi(text, model = 'gemini-2.5-pro') {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY / GOOGLE_API_KEY not set');
  const m = MODELS[model] || model;
  const r = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${m}:countTokens?key=${encodeURIComponent(key)}`,
    {},
    { contents: [{ parts: [{ text }] }] },
  );
  if (!r || typeof r.totalTokens !== 'number') throw new Error('unexpected countTokens response');
  return r.totalTokens;
}

function make(base) {
  return {
    name: `gemini (${base.name} est.)`,
    estimate: true,
    note: NOTE,
    count: (t) => base.count(t),
    exact: (t, model) => exactViaApi(t, model),
  };
}

module.exports = { make, exactViaApi, NOTE, MODELS };
