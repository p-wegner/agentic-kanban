// @gate:always-run
/**
 * #543 ratchet — the FINALIZE side of the session-exit state machine has ONE implementation.
 *
 * This reads sibling source files rather than importing them, so `vitest related` cannot see
 * that it depends on them; hence the always-run marker.
 *
 * Why a source scan and not just behaviour tests: the defect class here was never a wrong
 * answer, it was a MISSING one. `classifySessionExit` was shared (#910) but each caller kept
 * its own finalize, and the copies drifted silently in three places at once — the external
 * launch-failure path never ran `applyAuthFailureRecovery` (#430), the external completed
 * path never cleared the profile's failure streak, and every external failure was recorded
 * with no profile name, i.e. under a key the breaker does not read. None of those had a
 * failing test; each was simply absent. A second copy re-appearing is the thing to detect,
 * and a behavioural test for a behaviour nobody wrote cannot detect it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SESSION_MANAGER = join(import.meta.dirname, "..", "services", "session-manager");
const read = (f: string) => readFileSync(join(SESSION_MANAGER, f), "utf8");

/**
 * The moves that make a terminal exit route "finalized". Each one is a place the two copies
 * actually diverged, so each is a place a THIRD copy would diverge again.
 */
const FINALIZE_MOVES = [
  // The #430 breaker pair — the external path had neither.
  "applyAuthFailureRecovery",
  "recordAgentProfileLaunchSuccess",
  // The per-route stats builders and the butler text that named a duration one copy dropped.
  "buildCodexUsageLimitStats",
  "buildClaudeUsageLimitStats",
  "buildZeroOutputLaunchFailureStats",
  "buildModelErrorLaunchFailureStats",
  "buildStaleResumeLaunchFailureStats",
  "launchFailureButlerText",
];

describe("#543: session-exit finalize is single-source", () => {
  const lifecycle = read("session-lifecycle.ts");

  it.each(FINALIZE_MOVES)("session-lifecycle.ts does not re-implement %s", (symbol) => {
    expect(lifecycle).not.toContain(symbol);
  });

  it("exit-finalize.ts owns all of them", () => {
    const finalize = read("exit-finalize.ts");
    for (const symbol of FINALIZE_MOVES) expect(finalize).toContain(symbol);
  });

  it("both exit paths go through the shared finalize", () => {
    // The live path (`handleExitEvent`) and the reattached path (`notifyExternalExit`) live in
    // the same file, so the check is that each shared entry point is reached from BOTH — two
    // call sites for the routes both paths handle.
    for (const fn of ["finalizeUsageLimitRoute", "finalizeLaunchFailureRoute", "finalizeCompletedRoute"]) {
      const calls = lifecycle.split(`${fn}(`).length - 1;
      expect(calls, `${fn} should be called by the live AND the external path`).toBeGreaterThanOrEqual(2);
    }
  });

  it("the launch-THROW path is deliberately not routed through it", () => {
    // `startSession`'s catch records a profile failure for a spawn that never produced an exit
    // event at all. That is not a terminal ROUTE — there is no `classifySessionExit` result to
    // finalize — so it keeps its own record call, and this test says so rather than letting a
    // future reader "fix" the inconsistency.
    expect(lifecycle).toContain("recordAgentProfileLaunchFailure");
    expect(lifecycle).not.toContain("recordAgentProfileLaunchFailure(db, {\n        provider: lifecycleProviderName(provider, profile),\n        profileName: profile?.name,\n        summary: stats.failureReason");
  });
});
