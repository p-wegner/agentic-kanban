# Board run — splitpy (FastAPI + SQLite, Python) — 2026-06-14

First **non-TypeScript** rung of the "drive agents through projects" ladder. Goal: exercise the board's freshly-built per-stack feedback harness (epic #785) on a Python stack, driven hands-off, with the operator changing **board settings only**.

## Outcome
- **16/16 children Done + epic meta #1 driven to Done.** ~45 min wall-clock (13:00–13:35 UTC) from first builder to EPIC COMPLETE.
- **master green on a cold check:** `uv venv && uv pip install -r requirements.txt && uv run python -m pytest -q` → **93 tests pass**.
- App: FastAPI + SQLite expense-splitter (Splitwise-lite) — groups/members/expenses CRUD, balance computation, settle-up suggestions, CSV export, search, input validation, demo-seed, 4 web UIs, health + OpenAPI smoke.

## Setup (subagent, `drive-new-project` skill)
- Project `C:\andrena\splitpy`, board proj `2eb8ce04-cfdd-40ad-a121-e60ca9cabdc2`, defaultBranch `master`.
- **17 tickets, wide fan-out:** epic #1 + 14 feature tickets (#2–#15, all unblocked from the start) + integration #16 (deps #2–#15) + retro #17 (deps #16). Scaffold **committed up-front** so every feature ticket was immediately startable — real WIP=4 parallelism, not a chain.
- **Hot files pre-resolved at scaffold:** auto-discovering routers (`app/main.py`) + models (`app/db.py` globs `create_table()`), per-feature test split (`tests/test_<x>.py`), ownership-marked `static/index.html` sections + per-feature JS stubs, pinned `requirements.txt`. Result: zero append-conflict thrash on shared files (contrast the Space Invaders run's shared-`smoke.test.js` thrash).

## Provider — codex, isolated per-project
Operator directive: **codex default for everything**. Set `codex:default` **only** in `board_strategy_<PID>` providerPolicy → `selectProviderFromStrategy` made every builder launch on codex (gpt-5.5). Global `provider=claude`/`claude_profile=anth`/`default_model=""` left **untouched**, so the agentic-kanban Conductor (claude:anth) was undisturbed and there was no provider contention. All builders confirmed `provider=codex` with live token activity (no credit-death). Codex reads `AGENTS.md` (not CLAUDE.md) — guidance there: uv venv, `python` not python3, **no Playwright/screenshots** (hangs codex), commit when green, file-scope discipline.

## Driven by
In-process **autodrive engine** (`board_autodrive_<PID>=true`, auto_merge + auto_review + auto_merge_in_review, merge_strategy=monitor) — the Conductor is hard-wired to agentic-kanban and can't drive another project. Subagent did SETUP+KICKOFF only; parent session held a resident Monitor watch (`scripts/watch-splitpy.py`) for milestones/stalls and drove the close-out.

## Frictions / escalations
1. **Integration gate stall (manual nudge required).** After all 14 features merged, the unblocked integration #16 would NOT auto-start: the autodrive WIP gate counted **19 stale idle/closed workspaces** (debris from completed tickets) toward the target of 4, so it saw the project as over-capacity. Launched #16 by hand via `POST /api/workspaces` (codex). #17 then auto-started fine once the count freed. → Filed **#815** (WIP gate must count only active/reviewing/fixing) + **#816** (auto-reap stale completed workspace ROWS — also the last barrier to a safe global `merge_queue`). With both, this gate opens itself.
2. **Removed an auto-generated blocking `mypy .` smart-hooks rule** at scaffold (mypy wasn't a dep → would have blocked every builder's commit).
3. **AK dev-board drift (incidental):** stale `packages/shared/dist` vs new `schema/drives.ts` (from epic #799) broke board CLI/MCP until `pnpm --filter @agentic-kanban/shared build`. Running dev server unaffected (resolves shared from src).

## Net
The Python rung worked end-to-end with one manual gate-nudge — and that nudge is now a filed, scoped fix (#815/#816). Per-project codex isolation via the Bullseye providerPolicy is the clean, reusable pattern for multi-provider drives. Next obvious lever for zero-touch: per-project Conductors (#814) so a non-AK project gets an agent-driven orchestrator instead of the deterministic engine + a babysitting watch.
