# Tokenizer landscape (June 2026) — bundled-counter decision

> Provenance: distilled from the raw deep-research report in
> `research-raw-2026-06.md` (German; with source citations).

Findings from a deep-research pass on current token-counting tooling, and the
decisions baked into `src/counters/`. **Core verdict:** use ONE shared local
normalizer — **o200k_base** — as the offline metric for every family (exact for
OpenAI, a good *relative* proxy for Claude/Gemini, which have no portable local
tokenizer), with optional per-provider **exact API** paths for online use.

## Per-provider

### Anthropic Claude (Opus 4.8 / Sonnet 4.6 / Haiku 4.5 / Fable 5)
- **No public, current local tokenizer.** A "newest tokenizer" was introduced at
  Opus 4.7 (also used by Fable 5 / Mythos 5); its family is **not publicly
  specified** (not stated to be BPE or SentencePiece).
- The old `@anthropic-ai/tokenizer` (npm **v0.0.4, 2023**) self-describes as a
  "very rough approximation" for Claude 3+. **Do not use it for Claude 4/5.**
- Exact counting = **Messages `count_tokens` API** (`client.messages.count_tokens`
  / `POST /v1/messages/count_tokens`). Network-bound, **free**, but **counts
  against normal rate limits**.
- Community offline approximations (e.g. `bpe-lite`) reverse-engineer Anthropic —
  fine for *relative* hygiene, not hard limits.
- **No official benchmark** exists for how far o200k_base drifts from real Claude
  counts. Conservative operating rule: keep **~15–20% headroom** when optimizing
  against a hard Claude context limit. (Not an official number.)
- **Decision:** `claude-counter.js` → offline o200k_base normalized; `--exact` →
  `count_tokens` API (raw HTTPS, needs `ANTHROPIC_API_KEY`).

### OpenAI (GPT-5.5 / 5.4 / mini / nano)
- `tiktoken` remains the reference (OSS **0.13.0**, May 2026). `gpt-5` and
  `gpt-5-*` prefixes map to **o200k_base**; `o1`/`o3`/`o4-mini` too.
- **Gotcha:** dotted IDs like `gpt-5.4` / `gpt-5.5` can lag in
  `encoding_for_model(...)`. **Load `o200k_base` directly** as the robust path —
  which is exactly what `tiktoken-counter.js` does (`gpt-tokenizer/model/gpt-4o`).
- `tiktoken` fetches `.tiktoken` vocab from OpenAI blob URLs on first use, then
  caches (`TIKTOKEN_CACHE_DIR`). `gpt-tokenizer` (JS) bundles the vocab → truly
  offline, no first-run download. **That's why we use `gpt-tokenizer`.**
- Exact online = `POST /v1/responses/input_tokens` (handles images/files/tools);
  reportedly free, not confirmed in official pricing. Optional, not implemented.
- **Decision:** `tiktoken-counter.js` (o200k_base via `gpt-tokenizer`) — exact &
  offline for OpenAI, and the shared normalizer for everyone else.

### Google Gemini (2.5 / 3.x)
- Official `countTokens` API (`POST /v1beta/{model}:countTokens`), multimodal.
- A **local** tokenizer now ships in the **Python** `google-genai` SDK (v2.8.0):
  Gemma-3 SentencePiece for 2.x, HF tokenizers for 3.x — but it `requests.get`s
  artifacts (not zero-config offline) and coverage **lags new model IDs**. It is
  **Python-only**, so not portable into this Node skill.
- **Decision:** `gemini-counter.js` → offline o200k_base normalized; `--exact` →
  `countTokens` API (needs `GEMINI_API_KEY`/`GOOGLE_API_KEY`). If you specifically
  target Gemini and can run Python, vendor the google-genai local tokenizer.

## Portable tooling surveyed
- **`gpt-tokenizer`** (JS): TS BPE, bundles o200k_base/o200k_harmony, covers
  GPT-5/o-series/4o, synchronous, browser-ok, no Python. ✅ **chosen backbone.**
- **`js-tiktoken`**: pure-JS port of tiktoken (the npm `tiktoken` README points to
  it for non-WASM). Viable alternative.
- **`ttok`** (simonw): handy little CLI but **OpenAI/tiktoken-centric**, README
  model list ends at older OpenAI lines — *not* a good multi-provider base.
- **`@anthropic-ai/tokenizer`**: stale (2023), rough for Claude 3+ — avoid.
- **`bpe-lite`**: pure-JS, zero-dep, OpenAI+Anthropic+Gemini, but Anthropic is
  reverse-engineered and Gemini approximated via Gemma SPM. Only if you accept that.
- **HF Transformers** offline mode (`HF_HUB_OFFLINE=1`, `local_files_only=True`):
  great for open models, doesn't replace provider counting for hosted Claude/GPT.

## Heuristics (still useful for rough planning)
- ~**4 chars/token**, ~**0.7–0.8 words/token** for English prose.
- OpenAI: ~1,500 words ≈ 2,048 tokens; ~1 paragraph ≈ 100 tokens.
- Gemini: 1 token ≈ 4 chars; 100 tokens ≈ 60–80 English words.
- Code: ~50,000 lines × 80 chars ≈ 1M tokens.
- These live in `heuristic-counter.js`, used only when `gpt-tokenizer` is absent.

## Chosen stack (implemented)
- **Offline normalizer:** `gpt-tokenizer` → **o200k_base** (`src/counters/tiktoken-counter.js`).
- **Claude/Gemini offline:** o200k_base normalized + a printed caveat note.
- **Exact (opt-in, online):** Claude `count_tokens`, Gemini `countTokens` — raw
  HTTPS, no SDK dependency (`src/counters/_api.js`).
- **Fallback:** `heuristic-counter.js` (no deps) if `gpt-tokenizer` isn't installed.

> Two-number model the research recommends, available here: the local o200k_base
> count is the cross-provider comparison number; `--exact` fetches the exact
> provider number for a final preflight when a network + key are present.
