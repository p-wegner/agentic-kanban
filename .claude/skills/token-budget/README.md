# token-budget

Portable, offline-first **LLM token counting + prose optimization** for
codebases, docs, and agent skills. Packaged as a reusable Claude/Codex agent
skill (see `SKILL.md`) and usable directly as a CLI (`tokt`).

The point: measure how many tokens a file / folder / prompt costs across SOTA
models (Claude Opus 4.8 / Sonnet 4.6, GPT-5.x, Gemini), find the biggest
consumers, and shrink docs/skills without losing performance. It also measures
the **exact cost + token usage of spawned `claude -p` runs** — subagents
included — straight from the run envelope.

## Install
```bash
cd token-budget
npm install        # pulls gpt-tokenizer (pure-JS, offline o200k_base)
```

## Use
```bash
node bin/tokt.js count "hello world"
node bin/tokt.js count --file SKILL.md --model opus-4.8
node bin/tokt.js scan ./docs --glob "**/*.md" --top 20
node bin/tokt.js audit path/to/CLAUDE.md
```

Add `--json` for machine-readable output, `--model` to pick a family,
`--exact` for billing-grade Claude counts via the API (needs `ANTHROPIC_API_KEY`).

### Measure a spawned `claude -p` run
```bash
# run claude -p and report EXACT cost + tokens (subagents rolled in per model)
node bin/tokt.js run "list the files here" -- --model haiku --allowedTools "Bash"

# parse a previously captured envelope (claude -p ... --output-format json > run.json)
node bin/tokt.js cost run.json          # cost + tokens; or: … | node bin/tokt.js cost -
node bin/tokt.js result run.json        # just the run's output text (no jq needed)

# reconstruct from a session transcript, with a per-subagent breakdown
node bin/tokt.js session <session-id>
```
`run`/`cost` read Anthropic-computed dollars from the `--output-format json`
envelope (`total_cost_usd` + per-model `modelUsage`, which already aggregates
subagents and aux calls) — billing-grade. `result` prints just the run's output
text (the `jq -r .result` replacement, so the skill stays dependency-free).
`session` reconstructs from the transcript's per-message token usage and prices
it with a local table (`src/pricing.js`) — an estimate, but the only route that
attributes cost to each subagent (by `agentType`/`description`).

**Benchmark loop (Node-only, no jq):** run the agent under test with
`claude -p ... --output-format json > run.json`, grade its output via
`tokt result run.json`, and cost it via `tokt cost run.json` — or grab
`tokt cost run.json --json` for one object carrying `result`, `totalCostUSD`,
`isError`, and per-model `models[]`.

### Parsing `claude -p` results

`claude -p "<prompt>" --output-format json` prints **one JSON object** (the
"envelope") when the run finishes. With `--output-format stream-json` it instead
emits newline-delimited events and the envelope is the final line where
`type == "result"`. `tokt` accepts either form everywhere.

The fields that matter:

```jsonc
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "result": "…the agent's final output text…",   // what it produced/found
  "session_id": "eb1ab74d-…",
  "num_turns": 2,
  "duration_ms": 6700,
  "total_cost_usd": 0.0212,                        // exact, whole run
  "modelUsage": {                                  // keyed by model — subagent-inclusive
    "claude-opus-4-8": {
      "inputTokens": 560, "outputTokens": 368,
      "cacheReadInputTokens": 50989, "cacheCreationInputTokens": 6828,
      "costUSD": 0.0212
    }
    // a subagent on a different model shows up as an extra key here;
    // total_cost_usd already sums every key.
  }
}
```

Two ways to read it — pick by whether you want a dependency:

```bash
# With tokt (no jq, no SDK):
node bin/tokt.js result run.json        # → prints only the `result` text
node bin/tokt.js cost   run.json        # → cost + per-model token table
node bin/tokt.js cost   run.json --json # → { result, totalCostUSD, isError,
                                        #     numTurns, durationMs, models[], totals }

# Or parse the raw envelope yourself — it's plain JSON, so any language works.
# Node one-liner (no deps):
node -e 'const e=require("./run.json"); console.log(e.result, e.total_cost_usd)'
```

Notes for parsers:
- **Always branch on `is_error`** before trusting `result`. `tokt result` exits
  non-zero when `is_error` is true so shell pipelines can gate on it.
- **Don't sum `modelUsage` cache tokens to get "context size"** — `cacheRead`
  repeats every turn. For a dollar figure use `total_cost_usd` /
  `modelUsage[*].costUSD` (already de-duplicated); `tokt cost` surfaces both.
- **Subagents need no special handling** for cost — they're folded into
  `modelUsage`. For a *per-subagent* split, use `tokt session <id>` (reads the
  transcript's `subagents/` dir).

## Design
- **Pluggable counters** (`src/counters/`): one file per model family, resolved
  by `index.js`. Missing optional deps degrade gracefully to a no-dependency
  heuristic — the tool never hard-fails on a tokenizer that isn't installed.
- **Offline-first:** scanning a tree repeatedly during a rewrite shouldn't make
  network calls. Exact API counting is opt-in.
- The concrete bundled tokenizer per family is being finalized — see
  `references/tokenizers.md`.

## Layout
```
SKILL.md                     agent-facing instructions (name + description frontmatter)
bin/tokt.js                  CLI: count | scan | skill | audit | run | cost | result | session
src/counters/                pluggable counters (heuristic, tiktoken, claude, gemini)
src/scan.js                  tree walk + per-file aggregation
src/audit.js                 static bloat finder
src/claude-run.js            spawn claude -p, parse the result envelope (exact cost)
src/session-cost.js          reconstruct cost from a session transcript (per-subagent)
src/pricing.js               per-model $/MTok table (estimate route only)
src/report.js                tables / deltas
references/tokenizers.md     tokenizer landscape + bundled-counter decision (research)
references/optimization-guide.md   how to cut tokens without losing behavior
```

## Status
Working. Shared offline normalizer is **o200k_base** (`gpt-tokenizer`) — exact
for OpenAI, a relative proxy for Claude/Gemini (which have no portable local
tokenizer). Optional `--exact` hits the Claude `count_tokens` / Gemini
`countTokens` APIs. Tokenizer rationale: `references/tokenizers.md`.
