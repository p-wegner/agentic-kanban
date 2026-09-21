import type { MergeGateEvidence, MergeGateShas } from "./merge-gate-token.js";

/**
 * #936 — SAY SO, AND SAY *WHAT MOVED*. A stale `already-passed` token's evidence can be
 * rejected for two different reasons — the branch tip moved, the base tip moved, or the
 * lock wait outlived `MERGE_GATE_EVIDENCE_MAX_AGE_MS` with no SHAs to pin against. A message
 * that names the branch sha on both sides — because only the base moved — reads as a no-op
 * discard, so the operator can't tell why a green pre-lock gate cost a second full run (#1220).
 */
export function buildStaleVerdictReason(evidence: MergeGateEvidence, currentShas: MergeGateShas): string {
  // #642/#1220 — `stage: "none"` is rejected unconditionally by `evidenceIsValid`, even when
  // both SHAs still match. Falling through to the "aged past MAX_AGE" wording below would be
  // an actively false claim in that case (see merge-gate-evidence-content-key.test.ts's
  // "REJECTS stage:'none' evidence however well its SHAs match" case) — nothing timed out,
  // nothing moved; the evidence never described a completed run.
  if (evidence.stage === "none") {
    return `evidence stage was "none" (nothing ran/was verified), so it cannot stand in for a pass`;
  }
  const evidenceBranch = evidence.branchSha?.slice(0, 8) ?? "none recorded";
  const currentBranch = currentShas.branchSha?.slice(0, 8) ?? "unknown";
  const evidenceBase = evidence.baseSha?.slice(0, 8) ?? "none recorded";
  const currentBase = currentShas.baseSha?.slice(0, 8) ?? "unknown";
  const branchMoved = Boolean(
    evidence.branchSha && currentShas.branchSha && evidence.branchSha !== currentShas.branchSha,
  );
  const baseMoved = Boolean(
    evidence.baseSha && currentShas.baseSha && evidence.baseSha !== currentShas.baseSha,
  );
  const changedDimensions: string[] = [];
  if (branchMoved) changedDimensions.push(`branch ${evidenceBranch} -> ${currentBranch}`);
  if (baseMoved) changedDimensions.push(`base ${evidenceBase} -> ${currentBase}`);
  return changedDimensions.length > 0
    ? changedDimensions.join(", ")
    : `no SHA to pin against (evidence branch ${evidenceBranch}, base ${evidenceBase}) — aged past `
      + `MERGE_GATE_EVIDENCE_MAX_AGE_MS`;
}
