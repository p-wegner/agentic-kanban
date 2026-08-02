/**
 * Shared per-test budgets for the suites whose cost is dominated by real `git` spawns,
 * temp-repo setup, and filesystem work rather than by the code under test.
 *
 * #206 raised the vitest CONFIG default (20s → 60s) because `pnpm test:mine` doubles as the
 * merge `verify_script`: when the budget measures machine load instead of correctness, master
 * goes red and every merge board-wide is withheld — including diffs that touch none of it.
 * That fix could not reach tests that pass their own `{ timeout: N }`, which override the
 * config. A follow-up run on a loaded machine still showed 21 server failures, 20 of them
 * timeouts and 12 of those in exactly these hand-set 30s budgets.
 *
 * Raising these is not hiding a hang: a genuine hang never completes, so it still trips the
 * (larger) budget. It only stops a slow machine from being reported as a broken codebase.
 * Override with VITEST_GIT_HEAVY_TIMEOUT on a dedicated runner that wants a tighter bound.
 */
export const GIT_HEAVY_TEST_TIMEOUT_MS = Number(process.env.VITEST_GIT_HEAVY_TIMEOUT) || 90_000;
