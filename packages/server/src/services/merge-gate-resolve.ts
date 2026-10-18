// Single owner of the pre-merge gate DECISION, split out of pre-merge-gate.service.ts (#1605); re-exported there.
import type { PreMergeGateResult } from "./pre-merge-gate.types.js";
import type { Database } from "../db/index.js";
import type { PreMergeGateWorkspace } from "./pre-merge-gate.types.js";
import { buildStaleVerdictReason } from "./merge-gate-verdict-reason.js";
import { evidenceIsValid, resolveMergeGateShas, type MergeGateShas, type MergeGateToken, type ResolvedMergeGate } from "./merge-gate-token.js";



type RunGate = (workspace: PreMergeGateWorkspace, projectId: string, database: Database) => Promise<PreMergeGateResult>;

async function runGateAsResolved(
  runPreMergeGate: RunGate,
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
  return {
    passed: gate.passed,
    ran: !gate.skipped,
    stage: gate.stage,
    message: gate.message,
    ...(gate.unverified ? { unverified: true } : {}),
    // #1057 — a HELD gate must stay distinguishable from a red one all the way out to the
    // caller: it did not run, so "the gate failed" would be a false claim about the diff.
    ...(gate.held ? { held: true } : {}),
    ...(gate.impactSelection !== undefined ? { impactSelection: gate.impactSelection } : {}),
  };
}

/**
 * Single OWNER of the pre-merge gate DECISION for every merge trigger path.
 *
 * Resolves the caller's {@link MergeGateToken} into whether the merge may proceed,
 * running the shared `runPreMergeGate` (injected by `pre-merge-gate.service.ts`, which re-exports this as `resolveMergeGate`; injected to avoid an import cycle) only when the token says to (or when an
 * `already-passed` token's evidence is stale/absent — the fail-safe that closes the
 * TOCTOU-by-boolean window). `skip-explicit` and valid `already-passed` tokens return
 * `passed: true` WITHOUT running an (expensive) build/boot again.
 */
export async function resolveMergeGateWith(runPreMergeGate: RunGate, args: {
  token: MergeGateToken;
  workspace: PreMergeGateWorkspace;
  projectId: string | null;
  database: Database;
  /** Injectable clock for staleness tests; defaults to Date.now(). */
  now?: number;
  /**
   * Injectable current branch/base tips for content-keyed evidence validation; defaults to
   * reading them from the worktree. Pass this in tests instead of building a real repo.
   */
  currentShas?: MergeGateShas;
}): Promise<ResolvedMergeGate> {
  const { token, workspace, projectId, database } = args;
  const now = args.now ?? Date.now();

  if (token.kind === "skip-explicit") {
    return { passed: true, ran: false, stage: "none", message: `pre-merge gate skipped (explicit): ${token.reason}`, decision: "skip-explicit" };
  }

  if (token.kind === "already-passed") {
    // Resolve the CURRENT tips so the evidence can be checked against the state actually
    // about to merge. `args.currentShas` lets tests pin this without a real repo.
    const currentShas = args.currentShas ?? (await resolveMergeGateShas(workspace));
    if (evidenceIsValid(token.evidence, now, currentShas)) {
      return {
        passed: true,
        ran: false,
        stage: token.evidence.stage,
        message: `pre-merge gate already passed (${token.evidence.source}, stage ${token.evidence.stage}, ran ${token.evidence.ranAt}`
          + `${token.evidence.branchSha ? `, branch ${token.evidence.branchSha.slice(0, 8)}` : ""}`
          + `${token.evidence.baseSha ? `, base ${token.evidence.baseSha.slice(0, 8)}` : ""})`,
        decision: "already-passed",
      };
    }
    // Stale/absent/fabricated proof → do NOT trust it; run the gate now (closes #943 TOCTOU).
    // #936/#1220 — the discard reason names WHAT MOVED (branch/base/neither), built in its
    // own module (see merge-gate-verdict-reason.ts for why the message matters).
    const reason = buildStaleVerdictReason(token.evidence, currentShas);
    console.warn(
      `[merge-gate] workspace ${workspace.id}: DISCARDING an already-passed verdict from `
        + `${token.evidence.source} (stage ${token.evidence.stage}, ran ${token.evidence.ranAt}) — `
        + `${reason} — so the gate is being re-run in full (#936).`,
    );
    const result = await runGateAsResolved(runPreMergeGate, workspace, projectId, database);
    return { ...result, decision: "run-gate-stale-evidence" };
  }

  const result = await runGateAsResolved(runPreMergeGate, workspace, projectId, database);
  return { ...result, decision: "run-gate" };
}
