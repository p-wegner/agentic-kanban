---
name: flaky-test-triage
description: Classify a failing test as known-flaky vs real regression, then re-run with the right strategy instead of debugging flakes or wrongly dismissing real failures
argument-hint: "[test file or test name that failed]"
---

# flaky-test-triage

A failing test is either a **known false failure** (flaky — re-run, don't debug) or a **real regression** (investigate the root cause). Misjudging either way wastes time. Follow this decision procedure.

## Step 1 — IDENTIFY

Pin down exactly what failed and what you changed:

- Which **test file** and which **test name(s)** failed.
- Which **source files you changed**:
  ```bash
  git diff --name-only HEAD
  ```

The intersection of "what failed" and "what I touched" drives the classification.

## Step 2 — CLASSIFY against the Known Flaky Test Suites table

**Rule:** If the failing test is in the table below **AND** you did **NOT** touch the relevant source file(s) for that suite → treat it as a **FALSE failure**. Re-run; do not debug.

Conversely: if you **did** touch the relevant source, or the test is **NOT** in the table → go to Step 3 (treat as REAL).

> Special-case rule from CLAUDE.md: **Only run `git.service.test.ts` when touching `packages/shared/src/lib/git-service.ts`.** It uses real filesystem + git operations and hits Windows file-locking on temp dirs — it is expected to be flaky otherwise.

### Known Flaky Test Suites

| File | Test(s) | Root Cause | Workaround |
|------|---------|-----------|-----------|
| `packages/e2e/tests/ui/board.test.ts` | "edit issue from detail panel" | Race: Edit panel open timing + `.first()` selector ambiguity + 10 s hard timeout | Re-run; increase timeout; use specific aria/placeholder selectors |
| `packages/e2e/tests/ui/board.test.ts` | "drag issue between columns" | `page.waitForTimeout(1000)` fixed sleep before verifying drop target | Re-run; replace with `waitForFunction()` checking board state |
| `packages/e2e/tests/ui/workspace.test.ts` | "View Diff button", "Merge button" | Backdrop close uses `waitForTimeout(300)`; setup retry uses fixed 500 ms delays; setup failure silently skips | Re-run; replace fixed sleeps with `await expect(backdrop).toBeHidden()` |
| `packages/e2e/tests/ui/session-history.test.ts` | Multiple | 2 s hard sleep waiting for session completion (`setTimeout(resolve, 2000)`) | Re-run; replace with polling loop checking session `exit_code` |
| `packages/e2e/tests/ui/workspace-chat.test.ts` | Multiple | Many fixed 500 ms–1 s delays + `test.skip()` on setup failure silently hides errors | Re-run; add exponential-backoff helper; log skip reasons |
| `packages/e2e/tests/api/board-events.test.ts` | WebSocket event tests | Race: no wait for `readyState === 1`; 500 ms fixed delay before create; no timeout wrapper on WS promise | Re-run; wrap WS promise in `Promise.race()` with 5 s timeout |
| `packages/e2e/tests/ui/board-realtime.test.ts` | "board updates when issue created via API" | `projects[0]` access without validating array is non-empty | Re-run; use `getE2EProjectId()` helper instead |
| `packages/e2e/tests/ui/all-workspaces-panel.test.ts` | Multiple | Multiple `waitForTimeout(300)` calls + active-project state dependency across runs | Re-run; replace sleeps with condition-based waits |
| `packages/e2e/tests/api/workspace-lifecycle.test.ts` | Multiple | `projects[0]` without validation; state from prior run can leak | Re-run; use `getE2EProjectId()` helper |
| `packages/server/src/__tests__/git.service.test.ts` | All | Real filesystem + git operations; Windows file-locking on temp dirs; no per-test timeout | **Only run when touching `packages/shared/src/lib/git-service.ts`**; add `test.setTimeout(30000)` |

If FALSE → skip to **Step 4 (re-run)**.

## Step 3 — REAL failure: investigate the root cause

You reach here if you touched the relevant source, or the test isn't in the table.

- **Never dismiss a failure as "pre-existing" without investigating the root cause.** Common real causes:
  - **Data accumulation** — hardcoded titles/IDs collide across runs; missing `afterAll`/`afterEach` cleanup leaks state.
  - **Race condition** — fixed sleeps that are too short under load; no wait for a ready/condition state.
  - **API change** — the source you changed altered a contract the test relied on.
- Fix it if straightforward; document it if not.

## Step 4 — RE-RUN with the right strategy

**Unit tests** — prefer targeted runs over the full suite (vitest v4 uses `related` as subcommand):
```bash
# Run only tests covering the files you changed
pnpm --filter agentic-kanban exec vitest related $(git diff --name-only HEAD)
# Or name specific source files:
pnpm --filter agentic-kanban exec vitest related packages/server/src/services/foo.service.ts
```
Use the **full suite** (`pnpm --filter agentic-kanban test`) only before committing or for cross-cutting changes.

**E2E tests** — re-run the specific test, not the whole suite:
```bash
pnpm test:e2e -- packages/e2e/tests/ui/board.test.ts -g "edit issue from detail panel"
```
- **Always use `127.0.0.1`, never `localhost`** — on Windows `localhost` resolves to `::1` (IPv6) while the server listens on `127.0.0.1`, causing silent ECONNREFUSED.
- **Use worktree ports from env vars**, never hardcode 3001/5173: `$env:KANBAN_SERVER_PORT` / `$env:KANBAN_CLIENT_PORT`.
- Do **not** run `playwright install` — browsers are pre-installed; the config auto-detects the binary.

## Step 5 — Recurring flake recurs with a known root cause

If a flake keeps recurring and you've identified the underlying anti-pattern, recommend the fix. Recurring root causes → fixes:

| Anti-pattern | Fix |
|---|---|
| `page.waitForTimeout()` / `setTimeout(r, N)` fixed sleeps | Replace with explicit condition waits (`waitForFunction`, `await expect(...).toBeHidden()`) or retry loops |
| `.first()` on broad selectors | Use `[aria-label]`, `[placeholder]`, or scoped parent locators |
| `projects[0]` array access | Use `getE2EProjectId()` (reads active-project preference) |
| `test.skip()` on flaky setup | Use retry loops (3 attempts, 500 ms–1 s delays); log the reason instead of silently skipping |
| Hardcoded issue/task titles | Append `Date.now()` suffix so each run is unique |
| No `afterAll`/`afterEach` cleanup | Add `test.afterAll` to delete created data and reset preferences |

**Scope discipline:** if fixing the flake is out of scope for your current task, **create a kanban ticket instead of fixing inline** — `mcp__agentic-kanban__create_issue` (or `pnpm cli -- issue create`). Don't expand scope while triaging.

**DB safety:** never delete or wipe `kanban.db` during E2E cleanup. Delete test issues/workspaces via MCP tools or the API — never `pnpm db:reset`.
