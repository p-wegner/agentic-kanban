# Aggregate fleet tools — across MANY sessions

These standalone fan-out scripts answer time-scoped questions across the whole
`~/.claude/projects` / `~/.codex/sessions` tree. They stat-filter by mtime FIRST,
then parse only in-window files (no N+1, no looping the per-session analyzers).
For a server-side friction roll-up instead, prefer the **`fleet-analysis`** skill.

## Token sinks — "what burned the most tokens in the last N days"

For aggregate token/cost questions across MANY sessions, **don't loop the per-session analyzers** and don't hand-roll a `find -mtime` scan (it stalls over the ~4700-file `~/.claude/projects` tree). Use `token-sinks.mjs` — it stat-filters by mtime FIRST, parses only the in-window files, sums per-turn usage, and ranks by estimated USD cost (cache-read priced at ~0.1x, cache-write ~1.25x, so the cost ranking is the *true* sink ranking — raw token counts are ~90% cheap cache-read).

```powershell
node scripts/token-sinks.mjs                  # last 7d, by session, ranked by cost
node scripts/token-sinks.mjs --by project     # group by cwd/project  (also: day | model | provider | session)
node scripts/token-sinks.mjs --days 14 --top 30
node scripts/token-sinks.mjs --provider claude --sort tokens   # claude | codex | all ; cost | tokens | output
node scripts/token-sinks.mjs --json           # machine-readable {totals, rows}
```

Covers Claude (per-assistant-turn `usage`) + Codex (cumulative `token_count`). Caveats: Codex tokens are counted but **not costed** (different provider/pricing → shows $0.00); non-Anthropic models routed through Claude Code (e.g. `glm-5.1`) fall back to **opus pricing**, so their cost is an over-estimate — use `--by model` to spot these. Pricing constants live at the top of the script; refresh from the `claude-api` skill if they drift.

## Failed tool calls — "which tools fail most / what are agents fighting"

`tool-failures.mjs` is the failure-analysis sibling of `token-sinks.mjs` (same stat-filter-then-parse fan-out). It ranks failed tool calls fleet-wide and clusters the actual error messages — no looping per-session analyzers, no friction-backfill dependency.

```powershell
node scripts/tool-failures.mjs                  # last 7d, by tool, ranked by failure count
node scripts/tool-failures.mjs --by error       # cluster failures by normalized error signature (best for root-causing)
node scripts/tool-failures.mjs --by project     # tool (default) | project | error | day
node scripts/tool-failures.mjs --sort rate --min 15   # highest failure RATE among tools with >=15 calls
node scripts/tool-failures.mjs --provider codex --days 14
node scripts/tool-failures.mjs --json
```

Failure detection: Claude = a `tool_result` block with `is_error:true` (mapped to its tool via `tool_use_id`); Codex = a `function_call_output` whose `output` shows a nonzero `Exit code: N` (mapped via `call_id`). `--by error` normalizes paths/numbers/quotes into a signature so the same failure clusters. Baseline (last 7d, 2026-06-08): ~7% of ~47.6K calls fail; **PowerShell is the worst by far** (~15%, matches the project CLAUDE.md note), then codex `shell_command` (~10%); dominant clusters are vitest "No test files found" / UNRESOLVED_IMPORT in worktrees, `Read`/`Write`/`Grep` ordering+path errors, and PS quoting/`Invoke-RestMethod 404`s.

## User prompts — "what did I ask the agents yesterday / on date X"

For "list all of my prompts for a day (or rolling window)" across MANY sessions, **don't loop the per-session parsers** — use `user-prompts.mjs`. Same stat-filter-then-parse fan-out as `token-sinks.mjs`, but it extracts the REAL *human-typed* prompts and filters out everything that merely lands in `type:"user"` entries: tool_results, sidechain/subagent turns, meta entries, harness `<task-notification>`/`<bash-stdout>` echoes, `[SESSION HANDOFF]`, the Codex board-monitor objective, internal LLM utility calls (file-prediction, voice-note→ticket), and bare UI slash commands (`/clear`, `/model`). Date scoping uses each ENTRY's own timestamp in LOCAL time (a session can span midnight); mtime is only the cheap pre-filter. `<bash-input>` is unwrapped to `! cmd`; slash commands with args render as `/cmd args`.

```powershell
node scripts/user-prompts.mjs                  # yesterday (local), all providers, human prompts only
node scripts/user-prompts.mjs --date 2026-06-10
node scripts/user-prompts.mjs --today
node scripts/user-prompts.mjs --days 3         # rolling: last N days incl. today
node scripts/user-prompts.mjs --provider claude   # claude | codex | all
node scripts/user-prompts.mjs --all            # ALSO show automated/agent-launch prompts (tagged [automated]/[noise])
node scripts/user-prompts.mjs --tree           # hierarchical Project → Day → Chat grouping (projects sorted by volume)
node scripts/user-prompts.mjs --days 7 --provider claude --tree   # e.g. weekly per-project/day/chat review
node scripts/user-prompts.mjs --full           # don't truncate prompt text
node scripts/user-prompts.mjs --json
```

Default output is a flat chronological list grouped by session (`HH:MM  <prompt>`). `--tree` instead nests **Project → Day → Chat**, projects ordered by prompt volume, with per-node counts — the right view for "what did I work on across projects this week". For a quick at-a-glance matrix, pipe `--json` and tally a project×day grid. Covers Claude + Codex; Copilot prompts live in `events.jsonl` `user.message` events — not yet wired in (add if needed). Caveat: a builder-launch ticket body without the workflow preamble can slip through as `human`, so worktree (`*-worktrees-feature-ak-*`) sessions may show one stray launch prompt.
