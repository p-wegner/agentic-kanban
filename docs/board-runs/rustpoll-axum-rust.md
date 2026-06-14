# Board run — rustpoll (axum + Rust) — 2026-06-14

Rust half of the **compiled-language rung** (Go + Rust driven concurrently). Goal: exercise the per-stack harness on Rust, hands-off, **all board agents on codex:default**, with the operator changing board settings only. Orchestrated by a subagent given minimal instructions (it chose the app, tickets, and scopes from the `drive-new-project` skill).

## Outcome
- **20/20 children Done + epic meta #1 driven to Done.** ~40 min (14:28–15:08 UTC) from first builder to EPIC COMPLETE.
- **master green on a cold check:** `cargo build --locked && cargo test` → **76 tests pass, 0 fail** (74 unit + integration + smoke).
- App: `rustpoll` — axum HTTP polls & voting service with real, unit-testable tabulation logic: plurality, instant-runoff (IRV), Borda, Condorcet (with cycle detection), approval; ballot validation, turnout stats, token-bucket rate-limit, CSV export, search, `/health` + OpenAPI smoke.

## Shape
- **21 tickets:** epic #1 + 18 feature tickets (#2–#19, each owns one `src/features/<name>.rs` with its own `#[cfg(test)] mod tests`) + integration #20 (`tests/integration.rs`) + retro #21. **18-wide fan-out** (all features unblocked from a committed scaffold) — not a chain.
- **Hot files pre-resolved at scaffold:** `src/features/mod.rs` registry + route-merges (ownership-marked, no ticket edits it), `Cargo.toml`/`Cargo.lock` pre-pinned, `tests/smoke.rs` shell-owned. Zero append-conflict thrash.

## Provider — codex, isolated per-project
`codex:default` set **only** in `board_strategy_<PID>` providerPolicy → every builder + review session ran on codex (no global change; agentic-kanban's claude:anth Conductor untouched). WIP=3 (modest, to share codex with the concurrent Go drive). All builders confirmed `provider=codex`, live tokens, no credit-death. AGENTS.md carried codex guidance (run `cargo build --locked && cargo test`, file-scope, no Playwright/screenshots).

## Driven by
In-process autodrive engine + a parent-session Monitor watch (`scripts/watch-drive.py`). Subagent did setup+kickoff and returned; parent drove close-out.

## Frictions
- **Integration gate opened on its own** (unlike splitpy and the sibling Go drive) — the stale-completed-workspace WIP overcount (#815) didn't accumulate enough on rustpoll to block #20. Confirms #815 is *intermittent*, debris-dependent — still worth fixing so it never bites.
- Ran concurrently with the goshrink Go drive (~6 codex builders combined) with no provider contention and no quota stall — a good stress test of codex-for-all across two simultaneous drives.

## Net
Rust compiled cleanly through the harness end-to-end with **zero manual intervention**. The per-project codex isolation pattern held under concurrent load. Companion run: `goshrink-go-stdlib.md`.
