---
name: token-budget
description: Count and analyze LLM token usage across files, codebases, docs, and agent skills; measure the exact cost + token usage of spawned `claude -p` runs (subagents included); then optimize prose to cut redundant/noisy tokens without losing performance. Use when the user wants to "count tokens", "how many tokens is this", "measure context size", "find the biggest token consumers", "measure the cost of a claude -p run / agent / subagents", "how much did that session cost", "shrink/optimize a prompt/skill/doc", "reduce token count", or audit a CLAUDE.md / skill / docs folder for bloat.
---

# token-budget

Portable, offline-first token counting + prose-optimization for SOTA LLMs
(Claude Opus 4.8 / Sonnet 4.6, GPT-5.x, Gemini). Bundles a self-contained
tokenizer so it works with no per-call network round-trip.

## When to use
- "How many tokens is this file / folder / string?"
- "Which files in this repo eat the most context?"
- "Audit this CLAUDE.md / skill / docs dir and tell me where the bloat is."
- "Shrink this prompt/skill/doc without losing meaning."

## Quick start
```bash
# one-time
cd <skill-dir> && npm install

# count a string or file
node bin/tokt.js count "some text"
node bin/tokt.js count --file path/to/doc.md

# scan a tree → ranked per-file token table + total
node bin/tokt.js scan ./docs --model opus-4.8
node bin/tokt.js scan . --glob "**/*.md" --top 20

# analyze a SKILL/agent dir the way agents pay for it (progressive disclosure)
node bin/tokt.js skill path/to/skill-dir

# optimization report: flags redundancy, filler, restating, dead sections
node bin/tokt.js audit path/to/SKILL.md

# measure a spawned Claude Code run — EXACT cost + tokens, subagents included
node bin/tokt.js run "list the files here" -- --model haiku --allowedTools "Bash"
node bin/tokt.js cost saved-envelope.json      # cost + tokens from a captured envelope
node bin/tokt.js result saved-envelope.json    # just the run's output text (no jq)
node bin/tokt.js session <session-id>          # reconstruct from a transcript
```

## Model selection
One shared **offline normalizer — `o200k_base`** (via `gpt-tokenizer`) is the
local metric for every family. It's *exact* for OpenAI and a good *relative*
proxy for Claude/Gemini, which have **no portable local tokenizer** (see
`references/tokenizers.md`). `--model` mainly changes which caveat/exact path applies:
- `gpt-5.5`, `gpt-5.4` → o200k_base, **exact** offline for OpenAI.
- `opus-4.8`, `sonnet-4.6`, `haiku-4.5`, `fable-5` → o200k_base estimate; Claude
  has no public local tokenizer. Keep ~15–20% headroom near a hard limit.
- `gemini` → o200k_base estimate (Gemini's local tokenizer is Python-only).
- `heuristic` → no-dependency chars/token estimate (used automatically if
  `gpt-tokenizer` isn't installed).

Counting is **relative by design** — ideal for ranking the biggest consumers and
measuring before/after a rewrite. For billing-grade exact counts, add `--exact`
(only on `count`): Claude → `count_tokens` API (`ANTHROPIC_API_KEY`), Gemini →
`countTokens` API (`GEMINI_API_KEY`). Without a key it degrades to the estimate.

## Analyzing skills (progressive disclosure)
Agents don't pay for a skill's files equally — `tokt skill <dir>` models the real
tiers instead of a flat sum:
- **Tier 0 — always-on:** the frontmatter `name` + `description`. Injected into
  the system prompt **every turn of every session**, for every registered skill.
  Highest leverage — a token here is paid thousands of times. Keep `description`
  tight (aim <~100 tokens).
- **Tier 1 — on-invoke:** the `SKILL.md` body. Loaded once when the skill triggers.
- **Tier 2 — on-demand:** reference docs the agent reads **only when SKILL.md (or
  another reachable doc) points at them**. Reachability is transitive.
- **Not context:** code/assets (executed, never read into the window) and
  **orphan docs** — reference files no SKILL.md path reaches, so an agent never
  discovers them. Either link them or delete them. (README/LICENSE are recognized
  as human-facing, not flagged.)

When optimizing a skill, cut Tier 0 first (every-turn cost), then Tier 1, and
move rarely-needed detail from Tier 1 down into a Tier 2 reference doc.

## Measuring spawned `claude -p` runs (exact cost + tokens, subagents included)
When you spawn Claude Code non-interactively (`claude -p`), you can get **billing-grade**
cost and token numbers straight from the run — no tokenizer estimate needed.

- **`tokt run "<prompt>" [-- <claude flags>]`** — runs `claude -p <prompt>
  --output-format json`, then reports `total_cost_usd` and a per-model token
  table. Everything after `--` is passed verbatim to `claude` (e.g. `--model
  haiku`, `--allowedTools "Task"`, `--append-system-prompt ...`). The prompt is
  sent on stdin, so quotes/spaces/newlines in it are safe.
- **`tokt cost <envelope.json | ->`** — if you already captured the envelope
  (`claude -p ... --output-format json > run.json`, or piped stream-json), parse
  it without re-running. Reads `-` for stdin.
- **`tokt result <envelope.json | ->`** — print *only* the run's output text
  (what the agent produced/found), raw and untruncated. The Node-only,
  dependency-free replacement for `jq -r .result`; exits non-zero if the run
  errored. Reads `-` for stdin.
- **`tokt session <id | transcript.jsonl | session-dir>`** — reconstruct usage
  from a session transcript under `~/.claude/projects/`, with a **per-subagent**
  breakdown (agent type + description). Use this for interactive sessions or any
  run not captured with `--output-format json`.

**Subagents are already included.** The `--output-format json` envelope's
`modelUsage` is keyed by model and aggregates the *entire* run — the main agent,
every Task subagent, and auxiliary calls (e.g. title generation). A subagent on
a different model simply appears as an extra `modelUsage` key, and
`total_cost_usd` sums them all. So `run`/`cost` give a subagent-inclusive total
with a per-model split for free.

**Two routes, one is authoritative:**
- `run` / `cost` read Anthropic-computed dollars (`costUSD`, `total_cost_usd`) —
  **exact, billing-grade**. Prefer these whenever you control the spawn.
- `session` reconstructs from the transcript's per-message `usage`, which records
  *tokens* but not dollars, so it prices them with a bundled local table
  (`src/pricing.js`) — an **estimate**, and its per-subagent attribution is the
  reason to use it. Token counts are exact; the `$` is approximate (marked with
  `?` if a model isn't in the price table). Don't sum transcript tokens naively
  across turns for a single "context size" — cache reads repeat every turn; the
  per-category pricing in `session` is what makes the sum meaningful.

Transcript layout the `session` command walks:
`~/.claude/projects/<encoded-cwd>/<session_id>.jsonl` (main) plus
`<session_id>/subagents/agent-*.jsonl` (+ `.meta.json` with `agentType` /
`description`) for each Task subagent.

### Benchmark workflow — you drive `claude -p`, this skill costs it
When you're benchmarking an agentic task (e.g. "did the reviewer catch the bug we
planted in this PR, and what did the review cost?"), you usually want **both** the
run's *output* (to judge it) and its *cost*. You don't need `tokt run` for this —
call `claude -p` yourself so you fully control the invocation and keep its result,
then hand the envelope to the two `tokt` readers. The `--output-format json`
envelope carries both: `result` is what the agent produced; `modelUsage` /
`total_cost_usd` is the subagent-inclusive cost. Everything below is Node-only —
**no `jq` or other external tools needed.**

```bash
# 1. Run the reviewer under test, capturing output + usage in one envelope.
claude -p "Review the diff for bugs. Report each with file:line and severity." \
  --output-format json --model opus \
  --append-system-prompt "You are a strict code reviewer." > review.json

# 2a. Judge it: pull just the reviewer's output text (no jq) and check for the bug.
node bin/tokt.js result review.json | grep -qi "off-by-one" && echo "BUG FOUND" || echo "MISSED"

# 2b. Cost it (per model, subagents rolled in):
node bin/tokt.js cost review.json
```

- **`tokt result <envelope>`** prints *only* the run's output text (raw, untruncated,
  nothing else) — the drop-in replacement for `jq -r .result`. It exits non-zero if
  the run errored, so you can gate on it. Reads `-` for stdin.
- **`tokt cost <envelope>`** prints the cost + per-model token table.

For a fully scripted benchmark, `tokt cost review.json --json` returns one object
with everything per run — `result` (full, untruncated, to grep/grade),
`totalCostUSD`, `isError`, `numTurns`, `durationMs`, and per-model `models[]`. Loop
it over your PR fixtures and you get a found-the-bug × cost table, using nothing but
`node`.

If a run wasn't captured with `--output-format json`, fall back to `tokt session
<session-id>` to reconstruct cost from its transcript (estimate; per-subagent).

## Optimization workflow (the point of the skill)
When asked to shrink a doc/skill without losing performance:
1. `scan` / `audit` to get a baseline count + ranked hotspots.
2. Apply the reductions in `references/optimization-guide.md` (cut restating,
   redundant examples, filler, hedging; tighten tables; dedupe).
3. Re-`count` to report the delta (tokens saved, % reduction).
4. Preserve every load-bearing instruction — never trade tokens for behavior.
   Report what was cut and confirm semantics are intact.

## Architecture
- `bin/tokt.js` — CLI (count / scan / skill / audit / run / cost / session).
- `src/claude-run.js` — spawn `claude -p --output-format json`, parse the result
  envelope (json or stream-json), normalize per-model usage + total cost. Prompt
  on stdin, no shell (spaces/quotes safe).
- `src/session-cost.js` — locate a session transcript, walk main +
  `subagents/*.jsonl` (+ `.meta.json`), aggregate per model and per subagent.
- `src/pricing.js` — local per-model $/MTok table (input/output/cache), used
  ONLY to estimate cost in `session` (the envelope carries exact dollars).
- `src/counters/` — pluggable counters; `index.js` resolves model → counter
  over the shared o200k_base normalizer. Each exposes `count(text) -> number`
  (+ optional async `exact`). Add a model family = add one file.
- `src/scan.js` — walk a path/glob, count per file, aggregate, rank.
- `src/skill.js` — parse a skill's frontmatter, tier its files by progressive
  disclosure, resolve transitive doc reachability.
- `src/report.js` — formatting (tables, tier breakdown, deltas, audit findings).
- `references/` — tokenizer landscape + optimization guidance (read before
  recommending a tokenizer or doing a rewrite).

> Tokenizer choices are settled (June 2026 research) in `references/tokenizers.md`:
> o200k_base as the shared offline normalizer; Claude/Gemini exact via their
> count APIs (`--exact`). Read it before swapping a tokenizer.
