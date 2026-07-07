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

// ---------------------------------------------------------------------------
// Merge-gate DECISION token (#943 / arch-review §1.2)
// ---------------------------------------------------------------------------
//
// The gate DECISION — "run the gate now", "the gate already passed this cycle so
// trust the proof", or "deliberately merge without gating" — used to be encoded as a
// single opaque `skipPreMergeGate: boolean` threaded into `doMerge`, and re-implemented
// (or silently absent) in every other merge trigger path. That made "no gate" an
// invisible default and let the monitor's `skipPreMergeGate: true` assert a gate ran
// with nothing to back it (the acknowledged TOCTOU-by-boolean, #943).
//
// A single OWNER (`resolveMergeGate`) now makes that decision for every trigger path,
// driven by an explicit token the caller passes IN:
//   - `run-gate`            → run the verify/smoke gate here and now.
//   - `already-passed`      → the caller ran the gate this cycle; it must hand over
//                             PROOF (timestamp + stage + source), not a bare boolean.
//                             Stale or malformed evidence is REJECTED and the gate
//                             re-runs — closing the TOCTOU-by-boolean shape.
//   - `skip-explicit`       → merge WITHOUT gating, for a documented reason. Makes
//                             every ungated merge a visible, auditable choice.

/** Evidence that the verify/smoke pre-merge gate already ran and PASSED for this worktree state. */
export interface MergeGateEvidence {
  /** ISO timestamp when the gate ran and passed — used for staleness detection. */
  ranAt: string;
  /** Which gate stage produced the pass (verify/smoke/none). */
  stage: PreMergeGateResult["stage"];
  /** Which path ran the gate (for logs/diagnostics), e.g. "monitor-cycle", "review-exit". */
  source: string;
}

/**
 * Explicit gate-decision token passed by a merge trigger into the merge executor.
 * Replaces the old opaque `skipPreMergeGate: boolean` (#943).
 */
export type MergeGateToken =
  | { kind: "run-gate" }
  | { kind: "already-passed"; evidence: MergeGateEvidence }
  | { kind: "skip-explicit"; reason: string };

/** Age past which `already-passed` evidence is treated as stale and the gate re-runs. */
export const MERGE_GATE_EVIDENCE_MAX_AGE_MS = 15 * 60 * 1000;

/** The default token: run the gate now. */
export const RUN_GATE: MergeGateToken = { kind: "run-gate" };

/** Construct an `already-passed` token carrying proof the gate ran and passed. */
export function gateAlreadyPassed(evidence: MergeGateEvidence): MergeGateToken {
  return { kind: "already-passed", evidence };
}

/** Construct a `skip-explicit` token: deliberately merge WITHOUT gating, with a documented reason. */
export function gateSkipExplicit(reason: string): MergeGateToken {
  return { kind: "skip-explicit", reason };
}

/** Outcome of resolving a {@link MergeGateToken} against the current worktree/project state. */
export interface ResolvedMergeGate {
  /** Whether the merge may proceed. */
  passed: boolean;
  /** True when the gate actually RAN this time (false for already-passed / skip-explicit). */
  ran: boolean;
  /** Which gate stage decided the outcome. */
  stage: PreMergeGateResult["stage"];
  /** Human-readable outcome, suitable for a board comment / log line. */
  message: string;
  /** How the decision was reached (for logs/tests). */
  decision: "run-gate" | "already-passed" | "skip-explicit" | "run-gate-stale-evidence";
}

function evidenceIsFresh(evidence: MergeGateEvidence, now: number): boolean {
  const ranAtMs = Date.parse(evidence.ranAt);
  if (Number.isNaN(ranAtMs)) return false;
  const ageMs = now - ranAtMs;
  // Reject future timestamps too (clock skew / fabricated evidence) — anything outside
  // [now - MAX_AGE, now] is not trustworthy proof.
  return ageMs >= 0 && ageMs <= MERGE_GATE_EVIDENCE_MAX_AGE_MS;
}

function evidenceIsValid(evidence: MergeGateEvidence | undefined, now: number): boolean {
  if (!evidence || typeof evidence.source !== "string" || !evidence.source.trim()) return false;
  return evidenceIsFresh(evidence, now);
}

async function runGateAsResolved(
  workspace: PreMergeGateWorkspace,
  projectId: string | null,
  database: Database,
): Promise<Omit<ResolvedMergeGate, "decision">> {
  // No project → nothing to look up a gate config against; a clean no-op (mirrors the
  // pre-refactor `if (project && ...)` guard in doMerge).
  if (!projectId) {
    return { passed: true, ran: false, stage: "none", message: "no project — no pre-merge gate applies" };
  }
  const gate = await runPreMergeGate(workspace, projectId, database);
  return { passed: gate.passed, ran: !gate.skipped, stage: gate.stage, message: gate.message };
}

/**
 * Single OWNER of the pre-merge gate DECISION for every merge trigger path.
 *
 * Resolves the caller's {@link MergeGateToken} into whether the merge may proceed,
 * running the shared {@link runPreMergeGate} only when the token says to (or when an
 * `already-passed` token's evidence is stale/absent — the fail-safe that closes the
 * TOCTOU-by-boolean window). `skip-explicit` and valid `already-passed` tokens return
 * `passed: true` WITHOUT running an (expensive) build/boot again.
 */
export async function resolveMergeGate(args: {
  token: MergeGateToken;
  workspace: PreMergeGateWorkspace;
  projectId: string | null;
  database: Database;
  /** Injectable clock for staleness tests; defaults to Date.now(). */
  now?: number;
}): Promise<ResolvedMergeGate> {
  const { token, workspace, projectId, database } = args;
  const now = args.now ?? Date.now();

  if (token.kind === "skip-explicit") {
    return { passed: true, ran: false, stage: "none", message: `pre-merge gate skipped (explicit): ${token.reason}`, decision: "skip-explicit" };
  }

  if (token.kind === "already-passed") {
    if (evidenceIsValid(token.evidence, now)) {
      return {
        passed: true,
        ran: false,
        stage: token.evidence.stage,
        message: `pre-merge gate already passed (${token.evidence.source}, stage ${token.evidence.stage}, ran ${token.evidence.ranAt})`,
        decision: "already-passed",
      };
    }
    // Stale/absent/fabricated proof → do NOT trust it; run the gate now (closes #943 TOCTOU).
    const result = await runGateAsResolved(workspace, projectId, database);
    return { ...result, decision: "run-gate-stale-evidence" };
  }

  const result = await runGateAsResolved(workspace, projectId, database);
  return { ...result, decision: "run-gate" };
}
