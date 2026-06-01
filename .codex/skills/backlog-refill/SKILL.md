---
name: backlog-refill
description: When the board backlog is running low, generate an aggressive batch of new well-scoped tickets — with the feature/bugfix mix set by the monitor's REFILL_FOCUS (in objective.md) — so the board always has enough queued to keep the monitor's agent target busy. Use when the monitor sees the backlog dipping below its BACKLOG_FLOOR.
---

# backlog-refill

Keep the board well-fed so the monitor can always keep its `ACTIVE_AGENTS_TARGET` workspaces running. The board should never drain below the monitor's `BACKLOG_FLOOR`. Refill **aggressively and early** — act before the backlog hits the floor, not when it reaches zero.

**Batch size AND focus are set by the monitor, not here.** Create enough tickets to bring the backlog back **above `BACKLOG_FLOOR`** (defined in `scripts/board-monitor/objective.md` — the single source for these numbers). When in doubt, overshoot the floor by a few so the next refill isn't needed immediately.

**Honor the monitor's `REFILL_FOCUS` (in `objective.md`):**

- **`REFILL_FOCUS = bugfix-only`** — create **ONLY** tickets for real, reproducible bugs. Draw exclusively from the **Bug hunting** source below; do **not** create feature, enhancement, or speculative quality tickets. Every ticket must name a concrete, verifiable defect with repro steps. If you genuinely cannot find enough real bugs to reach the floor, create fewer and say so in the output — never pad with features.
- **`REFILL_FOCUS = balanced`** — use the feature-weighted mix: a majority of **substantial feature** tickets plus at least one **quality** ticket. Favor bigger, more ambitious features (split an over-large one into an epic + its first 2–3 implementable children rather than dropping it). Rotate which sub-area you draw from each time so coverage spreads over runs.

## Feature sources (rotate across refills — lean ambitious)
- **Feature gaps** — `$ui-explorer`: compare the running UI against `docs/prd/01-features-catalog.md` and surface a missing capability.
- **PRD scope** — unfinished items in `docs/prd/05-mvp-scope.md` / the PRD.
- **Competitor gaps** — `docs/competitors/` (what vibe-kanban / cline-kanban have that we don't and should).
- **User-value enhancements** — a concrete UX or workflow improvement that makes an existing flow materially better.
- **New surfaces** — an entirely new view, panel, integration, or workflow that opens up a capability the board doesn't have yet. Think big here.

## Quality sources (rotate across refills)
- **Architecture** — run `$architecture-improvement` for a prioritized list; pick the single highest-value item.
- **E2E gaps** — `$e2e-author`: find an untested or under-tested user flow worth covering.
- **Bug hunting** — review recent merged diffs, `docs/learnings/`, and server error logs for a *real, reproducible* bug (not speculation).
- **Performance / refactor** — a concrete hotspot or a duplication/complexity smell flagged by scope-guard.
- **Dependency hygiene** — `$dependency-analyzer`.
- **UI/UX** — `$ui-review` findings.

## Rules
1. **Real, specific, scoped tickets.** Title + description that an agent could pick up and implement in one focused workspace. No vague "improve X" — concrete acceptance criteria, following `CLAUDE.md` scope-guard. Bigger features are encouraged, but each individual ticket must still be implementable in one workspace (split ambitious work into linked tickets instead of writing one unimplementable mega-ticket).
2. **No duplicates.** `list_issues` first; skip anything already open (or recently Done) that overlaps.
3. **Create via the board.** Use `mcp__agentic-kanban__create_issue` (title, description, priority, type). Set priority honestly (quality debt is usually medium; a real bug can be high; flagship features can be high).
4. **Tag them.** Add a `backlog-refill` tag (create it once via `create_tag` if missing) so auto-generated tickets are traceable and you can audit the mix later.
5. **Refill above the floor.** Create enough tickets to bring the backlog back above the monitor's `BACKLOG_FLOOR` (plus a small buffer), so the agent target stays fed without re-refilling every cycle. The number lives in `objective.md`, not here.
6. **Stay in scope.** You are *generating work*, not doing it. Create the tickets and stop; the monitor's normal loop will pull and start them through board workspaces.

## Output
Report the tickets created (numbers + titles) and note which axis each one served (feature / quality), so the mix is visible over time.
