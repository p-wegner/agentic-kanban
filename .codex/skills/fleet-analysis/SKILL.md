---
name: fleet-analysis
description: Time-scoped, fleet-level analysis of MANY agent sessions (Claude/Codex/Copilot) to find COMPOUNDING-ENGINEERING improvements — skills, hooks, helper scripts, deterministic board changes, CLAUDE.md edits. Use for "analyze the last 48h of sessions", "which tools fail most", "what are agents wasting tokens on", "where can we compound". Distinct from session-inspector (one session) and learning-step (one session → one fix).
argument-hint: "[--hours 48] [--project <id>]"
---

# Fleet Analysis — Many Sessions → Systemic Improvements

You analyze the **whole fleet** of recent agent sessions to find changes that pay off across *every future session*: agent skills, hooks, helper scripts, deterministic board behavior, and CLAUDE.md/memory edits. You think in **token / tool-call / turn / runtime / failed-tool-call** terms, scoped to a time window (default last 48h).

This is the aggregate counterpart to its siblings:
- **session-inspector** — debug ONE session ("why did it stop").
- **learning-step** — friction in ONE session → one targeted fix.
- **fleet-analysis** (this) — friction across N sessions in a window → a *ranked* set of systemic, compounding fixes. Hands the top picks to `learning-step` to apply.

## Step 1 — Pull the friction backbone (ONE call)

The server aggregates friction across the window for you. Do **not** start by parsing transcripts or looping `session recent` + `/summary` — that's N+1 and capped.

```powershell
$pid_ = "<active project id>"   # resolve live: GET /api/projects, or get_context
$hours = 48
$i = Invoke-RestMethod "http://127.0.0.1:$($env:KANBAN_SERVER_PORT ?? 3001)/api/insights?projectId=$pid_&hours=$hours"
$i.friction | ConvertTo-Json -Depth 6
```

The `friction` block gives you, across the window:
- `coverage` — fraction of sessions with persisted friction stats. **If < ~0.8, backfill first** (Step 1a), else your picture is partial.
- `totalToolCalls`, `failedToolCalls`, `failPct`, `errorTotal`
- `byTool[]` — `{ tool, calls, failed, failPct }`, sorted worst-first. **This is your primary lead list.**
- `topRepeatedCommands[]` — `{ command, count, sessions }`. Commands repeated *within* sessions and *across* sessions — wasted-turn / allowlist / helper-script candidates.
- `worstSkills[]` — `{ skillName, successRate, turnsPerSuccess, failedToolCalls }`.

Also pull the cost/throughput axes from the same response: `byProviderProfile`, `byModel`, `byIssueType`, `topExpensive`, `timeSeries`, `totals`.

> **MCP / Butler shortcut:** `mcp__agentic-kanban__get_fleet_friction { hours }` returns the same byTool / topRepeatedCommands / totals without the URL plumbing. CLI snapshot: see the insights endpoint above.

### Step 1a — Backfill if coverage is low

Friction stats are persisted at session exit going forward; historical sessions need a one-time backfill (cheap — reads stored messages, not transcripts):

```bash
pnpm cli -- session backfill-friction --hours 48      # from the MAIN checkout
```

Then re-pull Step 1. (Use `--all` to backfill everything, `--force` to recompute.)

## Step 2 — Rank leads by compounding payoff

For each `byTool` row and each `topRepeatedCommands` entry, estimate the **fleet-wide** waste, not the per-session waste — that's what makes a fix compound:

- **Failed tool calls**: `failed × (retries + recovery turns)`, weighted by how many sessions it spans. A tool failing 14% across 1700 calls dwarfs one failing 67% across 3.
- **Repeated commands**: `(count − sessions)` ≈ avoidable re-runs (the first run per session is often legitimate). High `count` + high `sessions` = systemic, not one rogue session.
- **Worst skills / providers**: low `successRate` or high `turnsPerSuccess` at meaningful `sessionCount`.

Sort leads by estimated total tokens/turns saved per week. Keep the top 5–8.

## Step 3 — Drill into exemplars (root cause)

A leaderboard says *what*; you need *why*. For each top lead, open 2–3 exemplar sessions and read what actually happened — use session-inspector patterns and the per-provider analyzers (each reports tool failures + repeated commands):

```powershell
node scripts/analyze-claude-session.mjs --latest          # or <path>, --list [--worktrees], --json
node scripts/analyze-codex-session.mjs   --latest
node scripts/analyze-copilot-session.mjs --latest
```

To find exemplars for a failing tool, list recent sessions and inspect those with that provider/tool. Read the failing tool_result text — the *error message* usually names the fix (wrong flag, missing env, Windows quoting, `localhost` vs `127.0.0.1`, `pnpm cli` in a worktree, etc.). Cross-check against the "Known Flaky Test Suites" and pitfalls in CLAUDE.md / memory before calling something new.

## Step 4 — Classify each finding into a compounding lever

| Lever | When | Example signal |
|---|---|---|
| **Helper script** (`scripts/*.mjs`) | Same multi-step command sequence repeated across many sessions | `topRepeatedCommands` shows the same `git diff … \| …` chain in 9 sessions |
| **Permission allowlist** (`.claude/settings.json`) | Read-only command re-run constantly, prompting each time | `git status`, `Get-ChildItem`, `rg` repeated 200×+ |
| **Hook** (`.claude/hooks/`) | A failure mode can be mechanically prevented/redirected | tool fails the same way repeatedly; a PreToolUse guard could catch it |
| **CLAUDE.md / memory** | Knowledge gap — agents discover a fact the hard way | high `failPct` on a tool with a known idiom (PowerShell quoting, worktree CLI) |
| **Skill edit** (`.claude/skills/*/SKILL.md`) | A documented workflow is missing a step that causes friction | review/launch sessions repeat the same wrong first move |
| **Deterministic board change** (server/CLI/MCP) | A missing tool/endpoint forces agents into brittle manual work | agents hand-roll what a CLI/MCP command should do |

Prefer the **most deterministic** lever that fixes it (hook/allowlist/script > prose). Never weaken an existing hook.

## Step 5 — Output: ranked compounding-improvement report

```
## Fleet Analysis — last <N>h  (<sessionsWithFriction>/<total> sessions, <coverage>% coverage)

**Fleet totals**: <toolCalls> tool calls, <failed> failed (<failPct>%), <errors> errors, $<cost>, <tokens> tokens
**Worst tools**: <tool> <failPct>% (<failed>/<calls>), …
**Hotspots**: <provider/profile or model with worst success/turns>

### IMP-1: <title>   ⟶ est. ~<X> failed-calls / ~<Y>k tokens per week
- **Evidence**: <leaderboard number> + <1-2 exemplar quotes w/ session ids>
- **Root cause**: <why it happens>
- **Lever**: <helper-script | allowlist | hook | CLAUDE.md | skill | board-change>
- **Change**: <concretely what to add/edit/where>
- **Confidence**: low/med/high   **Effort**: S/M/L

### IMP-2 … (top 5–8)

### Skill-attribution caveat
<note worstSkills coverage; most launches are "No Skill" — lean on provider/triggerType/byTool>

### Hand-off
- Apply IMP-1, IMP-3 now via `learning-step` (deterministic, low-risk).
- File IMP-2 (board change) as a kanban ticket via mcp__agentic-kanban__create_issue.
```

## Step 6 — Apply / hand off

- **Docs/CLAUDE.md/memory/allowlist/skill edits**: hand to `learning-step` (it owns the apply + verify-commit discipline), or apply directly if trivial and you commit + verify the SHA.
- **Helper scripts / board changes**: implement if small; otherwise create a kanban ticket so it flows through the board.
- Always **quantify the win** ("saves ~X failed calls / ~Yk tokens per week") so the change is justified and re-measurable next window.

## Quality gates (same bar as learning-step)

Non-obvious · project-specific · actionable · non-duplicative (check CLAUDE.md + memory first) · not already fixed on this branch. A short report of 3 real, quantified, compounding fixes beats a long list of generic advice. Re-run next window to confirm the metric actually moved.
