import { runSetupScript } from "@agentic-kanban/shared/lib/setup-script";
import { runSmokeCheck } from "@agentic-kanban/shared/lib/smoke-check";
import type { Database } from "../db/index.js";
import { getPreference } from "../repositories/preferences.repository.js";
import { buildSmokeCheck, getStackProfile, verifyScriptPrefKey } from "./stack-profile.service.js";
import { runUnderBuildGate } from "./jvm-build-gate.js";

/** The workspace fields the pre-merge gate needs. A thin shape so any caller (exit-workflow's
 *  full WorkspaceRow, the monitor's WorkspaceCandidate) can satisfy it. */
export interface PreMergeGateWorkspace {
  id: string;
  workingDir: string | null;
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
}

/**
 * The shared #531 verify_script + #791 boot/render smoke quality gate (#821).
 *
 * Runs the project's configured pre-merge checks against a workspace's worktree and returns whether
 * the merge should proceed. This is the single source of truth for the gate; both the review-exit
 * handler (exit-workflow.ts) and the monitor's `auto_merge_in_review` path call it so neither can
 * land unverified/un-rendered code. (Before this extraction the gate lived only in exit-workflow, so
 * the monitor's auto-merge-of-not-ready In-Review workspaces bypassed it entirely.)
 *
 * Contract:
 *  - `verify_script_<projectId>` set → run it in the worktree; a non-zero exit FAILS the gate.
 *  - web project (stack profile `isWeb` + dev command + health URL) → boot + render smoke check;
 *    a failed boot/response FAILS the gate. A harness ERROR (not a failed boot) is NON-FATAL — it
 *    must not block an otherwise-passing merge, so it is swallowed and the gate continues.
 *  - neither configured → `skipped: true, passed: true` (a pure no-op for library/CLI projects).
 *  - a CONFIGURED gate that cannot run because the workspace has no worktree → FAILS the gate
 *    (fail-closed; never approve work we were told to verify but couldn't, mirrors #826).
 *
 * Both heavy invocations run under the build-concurrency gate (#823) so parallel pre-merge checks
 * on a JVM stack don't spawn a daemon storm that starves the backend.
 */
export async function runPreMergeGate(
  workspace: PreMergeGateWorkspace,
  projectId: string,
  database: Database,
): Promise<PreMergeGateResult> {
  // ---- #531 verify_script gate -------------------------------------------------------------
  // A read error here means we can't tell whether a gate is configured — treat as "no verify gate"
  // (never block a merge on a gate-DETECTION error; fail-closed applies only to a CONFIGURED gate
  // that can't RUN). Mirrors projectHasMergeGate's defensive catch.
  const verifyScript = await getPreference(verifyScriptPrefKey(projectId), database).catch(() => null);
  const verifyConfigured = Boolean(verifyScript && verifyScript.trim());
  if (verifyConfigured && !workspace.workingDir) {
    // Fail-closed: a gate we were told to run can't run without a worktree (#826).
    return { passed: false, skipped: false, stage: "verify", message: "verify_script configured but workspace has no worktree — cannot verify" };
  }
  if (verifyConfigured && workspace.workingDir) {
    const result = await runUnderBuildGate(() =>
      runSetupScript(workspace.workingDir!, verifyScript!).catch((e) => ({ exitCode: 1, stdout: "", stderr: String(e) })),
    );
    if (result.exitCode !== 0) {
      return {
        passed: false,
        skipped: false,
        stage: "verify",
        message: `verify_script failed (exit ${result.exitCode}): ${(result.stderr || result.stdout || "").slice(0, 300)}`,
      };
    }
  }

  // ---- #791 boot/render smoke gate ---------------------------------------------------------
  // Profile load needs no worktree, so detect "gate applies" before checking workingDir.
  let smokeApplies = false;
  try {
    const profile = await getStackProfile(projectId, database);
    const smokeCheck = buildSmokeCheck(profile);
    if (smokeCheck) {
      smokeApplies = true;
      if (!workspace.workingDir) {
        // Fail-closed: smoke (UI) gate applies but can't run without a worktree (#826).
        return { passed: false, skipped: false, stage: "smoke", message: "smoke/UI gate applies (web project) but workspace has no worktree — cannot verify" };
      }
      const smoke = await runUnderBuildGate(() => runSmokeCheck(workspace.workingDir!, smokeCheck));
      if (!smoke.passed) {
        return { passed: false, skipped: false, stage: "smoke", message: `smoke check failed: ${smoke.message}` };
      }
    }
  } catch (smokeErr) {
    // NON-FATAL: a harness error (not a failed boot) must not block an otherwise-passing merge.
    // Treat as if the smoke gate passed and fall through. (Matches exit-workflow's behavior.)
    console.warn(`[pre-merge-gate] smoke check errored (non-fatal) for workspace ${workspace.id}:`, smokeErr instanceof Error ? smokeErr.message : String(smokeErr));
  }

  const ranSomething = verifyConfigured || smokeApplies;
  return {
    passed: true,
    skipped: !ranSomething,
    stage: ranSomething ? (verifyConfigured ? "verify" : "smoke") : "none",
    message: ranSomething ? "pre-merge gate passed" : "no pre-merge gate configured",
  };
}
