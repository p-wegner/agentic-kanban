---
name: backlog-refill
description: When the board backlog is running low, generate an aggressive batch of new well-scoped tickets — weighted toward substantial features, with some quality/hardening work mixed in — so the board always has enough queued to keep 3 agents busy. Use when the monitor sees the backlog dipping below ~5 items.
---

# backlog-refill

Keep the board well-fed so **3 agents can always be running**. The board should never drain to the point where the monitor can't keep 3 concurrent workspaces in progress. Refill **aggressively and early** — act when the backlog falls **below ~5 items**, not when it hits zero.

Each refill creates a batch of **at least 5 new tickets**, weighted toward **substantial features** with some quality/hardening work mixed in:

- **Feature (the majority)** — new user value. Favor **bigger, more ambitious features** — meaty capabilities that meaningfully expand the product, not trivial tweaks. An ambitious feature that's too large for one workspace should be split into a small set of linked tickets (an epic + its first 2–3 implementable children) rather than dropped.
- **Quality (at least one per batch)** — harden/clean what already exists.

**Every refill: a majority of feature tickets AND at least one quality ticket. Rotate which sub-area you draw from each time, so coverage spreads over runs instead of repeating the same theme.**

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
5. **Refill to a buffer.** At least 5 tickets per refill — enough that, after the monitor pulls up to 3 into progress, a healthy queue still remains. This keeps 3 agents fed without re-refilling every cycle.
6. **Stay in scope.** You are *generating work*, not doing it. Create the tickets and stop; the monitor's normal loop will pull and start them through board workspaces.

## Output
Report the tickets created (numbers + titles) and note which axis each one served (feature / quality), so the mix is visible over time.
