// Shared shapes for the pre-merge gate. They live apart from both the gate RUNNER
// (pre-merge-gate.service.ts) and the gate DECISION token (merge-gate-token.ts) so that
// neither has to import the other — see the no-circular arch rule.
import type { Database } from "../db/index.js";

/** The workspace fields the pre-merge gate needs. A thin shape so any caller (exit-workflow's
 *  full WorkspaceRow, the monitor's WorkspaceCandidate) can satisfy it. */
export interface PreMergeGateWorkspace {
  id: string;
  workingDir: string | null;
  /**
   * The branch this workspace merges into. Optional (older callers omit it) — when absent,
   * the docs-only smoke skip (#198) simply can't be evaluated and the smoke gate runs as
   * before; this never widens what the gate blocks, only what it can additionally skip.
   */
  baseBranch?: string | null;
  /**
   * The workspaces whose deferred dependency installs this gate must clear, when that is not
   * simply `[id]`.
   *
   * The merge train gates the TREE that lands, so it calls this gate with a SYNTHETIC id
   * (`train:<label>`) that matches no `repos` row — which silently turned the #628 install
   * check into a no-op for every member of the train: `rows = []` → nothing blocking → land.
   * Two workspaces each individually withheld for a running install could therefore both land
   * via the train, which is exactly the "merged code built against missing deps" this check
   * exists to prevent. A caller gating something other than one real workspace must name the
   * real workspaces here.
   */
  memberWorkspaceIds?: string[];
}

export interface PreMergeGateResult {
  /** True when the gate approves the merge (passed, or there was nothing configured to check). */
  passed: boolean;
  /** True when no gate applied at all (no verify_script, not a web project) — a clean no-op. */
  skipped: boolean;
  /** Which gate decided the outcome, for logging/diagnostics. */
  stage: "verify" | "smoke" | "none";
  /** Human-readable outcome, suitable for a board comment / log line. */
  message: string;
  /**
   * True when the gate's verdict came from a wall-clock kill, not a completed run
   * (#192). A timed-out verify_script is inconclusive/retryable, NOT proof the code is
   * broken — callers should avoid treating it the same as a genuine red gate (e.g. when
   * deciding whether to surface a "fix the failing build" nudge to an autonomous monitor).
   */
  timedOut?: boolean;
  /**
   * True when this merge was verified by NOTHING because the project has nothing configured to
   * verify with (#377) — distinct from `skipped`, which also covers the deliberate docs-only skip of
   * a project that DOES have a gate.
   *
   * MEASURED motivation: an autonomous fix loop merged 8 tickets into a project that had no
   * `verify_script` pref and an all-null stack profile, one of them carrying a test that could never
   * pass. Master went from 38/38 green to 40 tests with 1 permanently failing and **nothing said
   * anything**, because "no gate configured" and "gate passed" were both reported as `passed: true`
   * with no visible difference. This flag is what makes that state sayable; callers surface it.
   */
  unverified?: boolean;
}
