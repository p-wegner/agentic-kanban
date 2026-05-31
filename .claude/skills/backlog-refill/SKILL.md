---
name: backlog-refill
description: When the board backlog is nearly empty, generate a small, balanced batch of new well-scoped tickets — an intelligent mix of quality-improving and feature-adding work — so the board never starves. Use when the monitor sees the backlog running low.
---

# backlog-refill

Keep the board from starving. When the backlog is **nearly empty** (act before it hits zero), create a **small batch of ~2 new tickets** that balances two axes:

- **Quality** — harden/clean what already exists.
- **Feature** — add new user value.

**Every refill: at least one quality ticket AND at least one feature ticket. Rotate which sub-area you draw from each time, so coverage spreads over runs instead of repeating the same theme.**

## Quality sources (rotate across refills)
- **Architecture** — run `$architecture-improvement` for a prioritized list; pick the single highest-value item.
- **E2E gaps** — `$e2e-author`: find an untested or under-tested user flow worth covering.
- **Bug hunting** — review recent merged diffs, `docs/learnings/`, and server error logs for a *real, reproducible* bug (not speculation).
- **Performance / refactor** — a concrete hotspot or a duplication/complexity smell flagged by scope-guard.
- **Dependency hygiene** — `$dependency-analyzer`.
- **UI/UX** — `$ui-review` findings.

## Feature sources (rotate across refills)
- **Feature gaps** — `$ui-explorer`: compare the running UI against `docs/prd/01-features-catalog.md` and surface a missing capability.
- **PRD scope** — unfinished items in `docs/prd/05-mvp-scope.md` / the PRD.
- **Competitor gaps** — `docs/competitors/` (what vibe-kanban / cline-kanban have that we don't and should).
- **User-value enhancements** — a concrete UX or workflow improvement that makes an existing flow materially better.

## Rules
1. **Real, specific, scoped tickets.** Title + description that an agent could pick up and implement in one focused workspace. No vague "improve X" — concrete acceptance criteria, following `CLAUDE.md` scope-guard. Prefer small over sweeping.
2. **No duplicates.** `list_issues` first; skip anything already open (or recently Done) that overlaps.
3. **Create via the board.** Use `mcp__agentic-kanban__create_issue` (title, description, priority, type). Set priority honestly (quality debt is usually medium; a real bug can be high).
4. **Tag them.** Add a `backlog-refill` tag (create it once via `create_tag` if missing) so auto-generated tickets are traceable and you can audit the mix later.
5. **Don't flood.** ~2 tickets per refill. This fires when the backlog is *low*, to keep one or two items always queued — not to dump a sprint.
6. **Stay in scope.** You are *generating work*, not doing it. Create the tickets and stop; the monitor's normal loop will pull and start them through board workspaces.

## Output
Report the tickets created (numbers + titles) and note which axis each one served, so the mix is visible over time.
