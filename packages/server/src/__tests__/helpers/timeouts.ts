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
/**
 * #680 raised this from 90s. A full `pnpm test:mine` on master (16 CPU / 30 GB, ~33 min) failed
 * 10 suites / 10 tests with exit 1 and ZERO confirmed code regressions — every one passed in
 * isolation. The budgets were measuring contention: `merge-overlap-cluster-landing` blew a 60s
 * budget in a suite that took 259s, and `workspace-merge-multirepo-retry` blew 120s in a suite
 * that took 306s. A 90s per-test budget cannot survive that, and a gate whose red is usually
 * noise trains its operators to ignore red — which is exactly what happened during the
 * 189-commit wave this ticket came out of.
 */
export const GIT_HEAVY_TEST_TIMEOUT_MS = Number(process.env.VITEST_GIT_HEAVY_TIMEOUT) || 240_000;
