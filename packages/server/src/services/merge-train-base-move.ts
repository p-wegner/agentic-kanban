/**
 * What a lone train attempt does when the base moved during its gate (#1601), moved out of
 * `merge-train.service.ts` (god-module ceiling and `runTrainAttempt`'s branch budget).
 *
 * - verdict-neutral or guards-only move that re-assembles cleanly: land the re-assembled tree;
 * - any other move: re-gate on the new base, at most `MAX_BASE_MOVE_REGATES` times;
 * - past that cap: land the original assembly, which `landMergeTrain` refuses as before.
 */
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { isGuardsOnlyDiff } from "@agentic-kanban/shared";
import { assessBaseMove, readBaseMoveFiles } from "./base-move-relevance.js";
import { assembleMergeTrain, assertTrainPreservesAncestry, type ConflictCluster, type TrainAssemblyResult } from "./merge-train-assembly.js";

type AssembledTrain = TrainAssemblyResult & { conflictClusters: ConflictCluster[] };

/** #1601 — re-gates allowed per attempt when the base moves by gate inputs during the gate. */
export const MAX_BASE_MOVE_REGATES = 2;

export type BaseMoveOutcome =
  | { kind: "land"; asm: AssembledTrain; note?: string }
  | { kind: "regate"; asm?: undefined; note?: undefined }
  | { kind: "refuse"; asm?: undefined; note?: undefined };

/** Decide, and log, what to do with a green gate whose base moved under it. */
export async function resolveBaseMoveDuringGate(args: {
  repoPath: string; baseBranch: string; asm: AssembledTrain; currentBase: string; label: string; regateDepth: number;
}): Promise<BaseMoveOutcome> {
  const neutral = await reassembleAfterNeutralBaseMove(args);
  if (neutral) return { kind: "land", asm: neutral.asm, ...(neutral.guardsOnlyNote ? { note: neutral.guardsOnlyNote } : {}) };
  if (args.regateDepth >= MAX_BASE_MOVE_REGATES) return { kind: "refuse" };
  console.log(
    `[merge-train] ${args.label}: base '${args.baseBranch}' moved ${args.asm.baseSha.slice(0, 8)}..${args.currentBase.slice(0, 8)} ` +
      `during the gate and the move is not verdict-neutral; re-gating on the new base (not red)`,
  );
  return { kind: "regate" };
}

/** The landing commit's evidence; a guards-only base move is named in the gate message. */
export function landingEvidence<E extends object>(args: { trainId: string | undefined; gateMessage: string; landNote: string; commitEvidence: E }): E | { evidence: { trainId: string; gateRuns: number; gateMessage: string } } {
  if (!args.landNote || !args.trainId) return args.commitEvidence;
  return { evidence: { trainId: args.trainId, gateRuns: 1, gateMessage: `${args.gateMessage}; ${args.landNote}` } };
}

/**
 * The base moved during a lone attempt's gate. When {@link assessBaseMove} judges the move
 * verdict-neutral (e.g. only a Bullseye sync of `scripts/board-monitor/objective.md`), re-assemble
 * the SAME gated members onto the current base without a re-gate and return that assembly to land.
 * Returns null — the caller then lands the original assembly and `landMergeTrain` refuses, exactly
 * as before — on a relevant move, any git failure, or when re-assembly drops a member.
 */
async function reassembleAfterNeutralBaseMove(args: {
  repoPath: string;
  baseBranch: string;
  asm: AssembledTrain;
  currentBase: string;
  label: string;
}): Promise<{ asm: AssembledTrain; guardsOnlyNote?: string } | null> {
  const { repoPath, baseBranch, asm, currentBase, label } = args;
  try {
    const assessment = await assessBaseMove({ cwd: repoPath, baseBefore: asm.baseSha, baseAfter: currentBase, branchSha: asm.trainSha });
    // #1601: a base delta of docs/config-only files (`isGuardsOnlyDiff`) cannot change a code
    // verdict either, whether or not it is on the narrower neutral allowlist. The clean-merge
    // check below still applies, so a file the train also touches drops out as before.
    let guardsOnlyNote: string | undefined;
    if (!assessment.keep) {
      const moved = assessment.movedPaths ?? (await readBaseMoveFiles(repoPath, asm.baseSha, currentBase));
      if (!moved || !isGuardsOnlyDiff(moved)) return null;
      guardsOnlyNote = `base moved ${asm.baseSha.slice(0, 8)}..${currentBase.slice(0, 8)} by guards-only files (${moved.slice(0, 5).join(", ")}); landed without a re-gate`;
    }
    const rebased = await assembleMergeTrain({ repoPath, baseBranch, members: asm.included, label: `${label}-rebased` });
    const clean = rebased.trainSha !== null && rebased.dropped.length === 0 && rebased.included.length === asm.included.length;
    if (!clean || rebased.baseSha !== currentBase) {
      await deleteTrainRef(repoPath, rebased.trainRef);
      return null;
    }
    await assertTrainPreservesAncestry(repoPath, rebased.trainRef, rebased.included, baseBranch);
    console.log(
      `[merge-train] ${label}: base moved ${asm.baseSha.slice(0, 8)}..${currentBase.slice(0, 8)} during the gate; ` +
        `landing without a re-gate because ${guardsOnlyNote ?? assessment.reason}`,
    );
    return { asm: rebased, ...(guardsOnlyNote ? { guardsOnlyNote } : {}) };
  } catch (err) {
    console.warn(`[merge-train] ${label}: base-move assessment failed, refusing as before: ${errorMessage(err).slice(0, 200)}`);
    return null;
  }
}
/** Delete a train ref once its members have been stamped. Best-effort: a leftover ref is harmless. */
export async function deleteTrainRef(repoPath: string, trainRef: string): Promise<void> {
  try {
    await gitExec(["branch", "-D", trainRef], { cwd: repoPath });
  } catch {
    // Best-effort.
  }
}
