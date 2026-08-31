import { revParse } from "@agentic-kanban/shared/lib/git-service";
import type { PreMergeGateResult, PreMergeGateWorkspace } from "./pre-merge-gate.types.js";

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
  /**
   * The branch tip the gate actually ran against. When present it is checked against the
   * branch's CURRENT tip, which is strictly stronger than the timestamp: a commit pushed
   * after the gate but merged inside the freshness window used to land on proof that
   * described different code. Optional for back-compat — evidence written before this field
   * existed (or by a caller that cannot resolve it) still validates on age alone.
   */
  branchSha?: string;
  /**
   * The base tip the gate ran against. A moved base means the merge RESULT is no longer the
   * thing that was verified, even though the branch is untouched — this is the case a
   * purely time-based check cannot see, and the reason a merge that waited behind another
   * merge must re-gate rather than trust its pre-lock pass.
   */
  baseSha?: string;
}

/** The current branch/base tips to validate content-keyed evidence against. */
export interface MergeGateShas {
  branchSha?: string;
  baseSha?: string;
}

/**
 * Resolve the branch/base tips for a workspace, for stamping or validating evidence.
 * Never throws — an unresolvable ref yields `undefined`, which degrades evidence to the
 * age-only check rather than failing a merge over a diagnostic read.
 */
export async function resolveMergeGateShas(workspace: PreMergeGateWorkspace): Promise<MergeGateShas> {
  if (!workspace.workingDir) return {};
  const branchSha = await revParse(workspace.workingDir, "HEAD").catch(() => undefined);
  const baseSha = workspace.baseBranch
    ? await revParse(workspace.workingDir, workspace.baseBranch).catch(() => undefined)
    : undefined;
  return { branchSha, baseSha };
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
  /** See {@link PreMergeGateResult.unverified} — nothing checked this merge at all (#377). */
  unverified?: boolean;
}

function evidenceIsFresh(evidence: MergeGateEvidence, now: number): boolean {
  const ranAtMs = Date.parse(evidence.ranAt);
  if (Number.isNaN(ranAtMs)) return false;
  const ageMs = now - ranAtMs;
  // Reject future timestamps too (clock skew / fabricated evidence) — anything outside
  // [now - MAX_AGE, now] is not trustworthy proof.
  return ageMs >= 0 && ageMs <= MERGE_GATE_EVIDENCE_MAX_AGE_MS;
}

/**
 * Why content-keying matters more than the clock: the question a merge needs answered is
 * "was THIS code, against THIS base, verified?" — not "was something verified recently".
 * When the evidence names both tips and both still match, the proof describes exactly the
 * state about to be merged and its age is irrelevant, so a long queue wait no longer forces
 * a pointless re-run. When either tip has moved, the proof is void no matter how fresh it is.
 */
function contentMatch(evidence: MergeGateEvidence, current: MergeGateShas | undefined): "match" | "mismatch" | "unknown" {
  if (!current) return "unknown";
  const branchKnown = Boolean(evidence.branchSha && current.branchSha);
  const baseKnown = Boolean(evidence.baseSha && current.baseSha);
  if (!branchKnown && !baseKnown) return "unknown";
  if (branchKnown && evidence.branchSha !== current.branchSha) return "mismatch";
  if (baseKnown && evidence.baseSha !== current.baseSha) return "mismatch";
  // Waiving the age check requires BOTH tips (#239). Branch-only agreement says the code under
  // test is the code being merged, but says nothing about the merge RESULT — and since the gate
  // now runs outside the repo lock, "another merge landed and moved the base" is the common
  // case, not the exotic one. An unpinned base (legacy evidence, a direct workspace, a caller
  // that omitted `baseBranch`) or a base that cannot be resolved at validation time is
  // therefore "unknown": fall back to the age check rather than granting unassessable evidence
  // an unlimited lifetime. Base-only agreement is likewise not a match.
  return branchKnown && baseKnown ? "match" : "unknown";
}

export function evidenceIsValid(evidence: MergeGateEvidence | undefined, now: number, current?: MergeGateShas): boolean {
  if (!evidence || typeof evidence.source !== "string" || !evidence.source.trim()) return false;
  // #642: `stage: "none"` is the gate's own word for "nothing ran" — a docs-only skip, an
  // unconfigured verify_script, a projectless workspace. Honouring it as `already-passed`
  // evidence turns a record of NO verification into a merge permit, and because SHA-pinned
  // evidence deliberately waives the age check (see `contentMatch`), that permit never
  // expires. Reject it and let the gate re-decide: for a genuinely docs-only diff the re-run
  // re-skips in milliseconds, so this costs nothing where the skip was legitimate.
  if (evidence.stage === "none") return false;
  const match = contentMatch(evidence, current);
  // Content says the verified state is gone → reject regardless of age.
  if (match === "mismatch") return false;
  // Content pins the exact branch (and base, when known) → age is not evidence of anything.
  if (match === "match") return true;
  // No usable SHAs on either side → fall back to the legacy age-only check.
  return evidenceIsFresh(evidence, now);
}
