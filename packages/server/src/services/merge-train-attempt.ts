// One assemble -> gate -> land -> close attempt, split out of merge-train.service.ts (#1605); the
// service re-exports deleteTrainRef. Types come from the service (type-only: no runtime cycle).
import { revParse } from "@agentic-kanban/shared/lib/git-service";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { MergeTrainAttemptDto, MergeTrainAttemptVerdict } from "@agentic-kanban/shared/types";
import { assessBaseMove } from "./base-move-relevance.js";
import {
  assembleMergeTrain, assertTrainPreservesAncestry, dedupeConflictClusters, formatTrainLabel, parentTrainLabel, trainDateStamp, trainRefName,
  type ConflictCluster, type TrainAssemblyResult, type TrainMember,
} from "./merge-train-assembly.js";
import { combineHeldBackRegate, decideAttributedOwners, decideSuiteOwnerShortcut, formatSuiteOwnerReason } from "./merge-train-suite-owner.js";
import { landMergeTrain } from "./merge-train-land.js";
import type { OnTrainDropped, TrainGate, TrainRunResult } from "./merge-train.service.js";

/**
 * #1277: after a green gate that went through a fix agent, the train ref's tip IS the fixed tree —
 * make that the sha the landing verifies against. True when it did.
 */
function adoptFixedTrainTip(asm: { trainSha: string | null }, gate: Awaited<ReturnType<TrainGate>>): boolean {
  const fixed = gate.passed ? gate.agentFix?.fixedTrainSha : undefined;
  if (fixed) asm.trainSha = fixed;
  return !!fixed;
}

/** Hand each attempt row to the caller's persistence port, in order. Best-effort: a throw is logged (#1189). */
async function persistAttempts(records: MergeTrainAttemptDto[], onAttempt?: (attempt: MergeTrainAttemptDto) => Promise<void>): Promise<void> {
  if (!onAttempt) return;
  for (const r of records) {
    try {
      await onAttempt(r);
    } catch (err) {
      console.warn(`[merge-train] could not record attempt ${r.label} (non-fatal): ${errorMessage(err).slice(0, 200)}`);
    }
  }
}

/** ONE assemble → gate → land → close cycle. The bisect driver above composes these. */
export async function runTrainAttempt(args: {
  repoPath: string;
  baseBranch: string;
  members: TrainMember[];
  label: string;
  trainId?: string;
  runGate: TrainGate;
  closeMember: (workspaceId: string) => Promise<void>;
  shouldLand?: () => Promise<string | null>;
  isEnvironmentFailure: (message: string) => boolean;
  onAttempt?: (attempt: MergeTrainAttemptDto) => Promise<void>;
  onDropped?: OnTrainDropped;
  /**
   * #1193 — resolved once it is this attempt's turn to LAND (a no-op when absent, i.e. every
   * caller before #1193). Awaited only immediately before `landMergeTrain`, never before
   * assembly or the gate, so two concurrently-gated halves still verify at the same time —
   * only the git-level landing is serialized.
   */
  waitForLandTurn?: Promise<void>;
  /** #1203 — see `runMergeTrain`'s doc comment; only read here to classify a killed gate. */
  signal?: AbortSignal;
  assemble?: typeof assembleMergeTrain; // #1572
}): Promise<TrainRunResult> {
  const { repoPath, baseBranch, members, label, trainId, runGate, closeMember } = args;

  const asm = await (args.assemble ?? assembleMergeTrain)({ repoPath, baseBranch, members, label });
  if (asm.dropped.length > 0 && args.onDropped) {
    await args.onDropped(asm.dropped, { trainRef: asm.trainRef, tipSha: asm.baseSha })
      .catch((err) => console.warn(`[merge-train] ${label}: send-back of dropped members failed (non-fatal): ${errorMessage(err).slice(0, 200)}`));
  }
  const closeFailures: TrainRunResult["closeFailures"] = [];
  let gateStartedAt: string | null = null;
  let gateFinishedAt: string | null = null;
  /** #1277: the fix-agent row this attempt's gate produced, if one ran; persisted beside this node. */
  let agentFixAttempt: MergeTrainAttemptDto | null = null;

  /**
   * #1189: stamp this attempt as one node of the bisect tree and hand it to `onAttempt`
   * BEFORE returning, so the caller can persist it while the driver is still deciding whether
   * to split. Each exit below goes through here; a THROW (base moved, ancestry violation) does
   * not, and the whole train throws with it — there is no verdict to record for that.
   */
  async function finish(result: Omit<TrainRunResult, "attempts" | "conflictClusters">, verdict: MergeTrainAttemptVerdict): Promise<TrainRunResult> {
    const failure = result.landRefused ?? result.gateFailure;
    const record: MergeTrainAttemptDto = {
      label,
      members: members.map((m) => m.workspaceId),
      included: asm.included.map((m) => m.workspaceId),
      // #1193: `result.dropped` (not `asm.dropped`) so a member dropped during the speculative
      // re-assembly after a base move (see below) is still visible on this attempt's node.
      dropped: result.dropped.map((d) => ({
        workspaceId: d.member.workspaceId,
        reason: d.reason,
        ...(d.deferred ? { deferred: true as const } : {}),
      })),
      gateStartedAt,
      gateFinishedAt,
      gateRuns: result.gateRuns > 0 ? 1 : 0,
      verdict,
      ...(verdict !== "landed" && failure ? { failureHead: failure.slice(0, 300) } : {}),
      ...(result.mergeSha ? { mergeSha: result.mergeSha } : {}),
      ...(result.sided.length > 0 ? { sided: result.sided.map((s) => ({ workspaceId: s.member.workspaceId, reason: s.reason.slice(0, 300) })) } : {}),
    };
    // #1277: the fix agent's own row first (it happened first), and its re-gate counts as a run.
    const records = [agentFixAttempt, record].filter((r): r is MergeTrainAttemptDto => r !== null);
    await persistAttempts(records, args.onAttempt);
    return { ...result, gateRuns: result.gateRuns + (agentFixAttempt?.gateRuns ?? 0), attempts: records, conflictClusters: asm.conflictClusters };
  }

  // The train ref is scratch state, so its cleanup belongs in a `finally` rather than at each
  // of the three exits. `deleteTrainRef` used to be called on assembly-empty, gate-fail and
  // success — but a THROW from `assertTrainPreservesAncestry` or `landMergeTrain` (base moved
  // under us, ancestry violation) skipped all three, so every failed train left a
  // `refs/kanban/train/q…` branch behind and they accumulated for the life of the repo.
  // `deleteTrainRef` is itself best-effort and never throws, so it cannot mask a real error.
  let neutralRef: string | null = null;
  try {
    if (asm.included.length === 0 || !asm.trainSha) {
      return await finish({ trainRef: asm.trainRef, landed: [], dropped: asm.dropped, closeFailures, gateRejected: [], sided: [], gateRuns: 0, gateFailure: "no members could be assembled onto the train" }, "assembly_empty");
    }

    // Cheap insurance before spending a gate on it: if assembly somehow produced a train that
    // does not contain a member's tip, everything downstream would be wrong.
    await assertTrainPreservesAncestry(repoPath, asm.trainRef, asm.included, baseBranch);

    // #676: hand the gate the members actually INCLUDED in the assembled tree, not the ones
    // requested. A member dropped during assembly (conflict) is not landing, so keying the
    // deferred-install check on the requested set would block the train on a workspace whose
    // code is not in it.
    gateStartedAt = new Date().toISOString();
    const gate = await runGate({ trainRef: asm.trainRef, trainSha: asm.trainSha, included: asm.included, label });
    gateFinishedAt = new Date().toISOString();
    // #1277: the fix agent ran inside the gate's worktree. On a green re-gate the train ref now
    // carries its commits, so THAT tip is what was verified and what lands.
    agentFixAttempt = gate.agentFix?.attempt ?? null;
    const fixLanded = adoptFixedTrainTip(asm, gate);
    if (!gate.passed) {
      // #1203: the gate itself was killed by the SAME signal a cancel aborts (`runGate`'s own
      // closure passes it into `runSetupScript`) — this failure is the cancel, not a verdict
      // about the code, so it must not be bisected or attributed to any member.
      if (args.signal?.aborted) {
        return await finish({ trainRef: asm.trainRef, landed: [], dropped: asm.dropped, closeFailures, gateRejected: [], sided: [], gateRuns: 1, gateFailure: gate.message, cancelled: true }, "red");
      }
      // #1413: an inconclusive gate is neither red nor attributable; leaf kind `env_failure`
      // (the train's own trouble) and the flag tells the driver and the caller not to treat it as red.
      if (gate.inconclusive) {
        return await finish({ trainRef: asm.trainRef, landed: [], dropped: asm.dropped, closeFailures, gateRejected: [], sided: [], gateRuns: 1, gateFailure: gate.message, inconclusive: true }, "env_failure");
      }
      // #1154/#1189: an environment failure is the train's, not a member's — its own leaf kind.
      const verdict: MergeTrainAttemptVerdict = args.isEnvironmentFailure(gate.message) ? "env_failure" : "red";
      return await finish({
        trainRef: asm.trainRef, landed: [], dropped: asm.dropped, closeFailures, gateRejected: [], sided: [], gateRuns: 1, gateFailure: gate.message,
        ...(gate.failedSuites && gate.failedSuites.length > 0 ? { failedSuites: gate.failedSuites } : {}),
      }, verdict);
    }

    // #1193: wait for an earlier concurrently-gated half to finish its own landing (or decide
    // not to land) before this one so much as re-reads the row — the base only moves under a
    // half that has already had its turn, which is what keeps the #1181 check below and
    // `landMergeTrain`'s base-moved refusal meaningful.
    if (args.waitForLandTurn) await args.waitForLandTurn;

    // #1181: last look before the base changes — a row abandoned during the gate must not land.
    const landRefused = args.shouldLand ? await args.shouldLand() : null;
    if (landRefused) {
      return await finish({ trainRef: asm.trainRef, landed: [], dropped: asm.dropped, closeFailures, gateRejected: [], sided: [], gateRuns: 1, gateFailure: landRefused, landRefused }, "land_refused");
    }

    // #1194: a train review may have attributed a blocking finding to specific members. The
    // assembled ref that was just gated still carries their commits, so it cannot be landed
    // as-is — it must be re-assembled WITHOUT them onto a fresh ref before landing. No re-gate:
    // the combined tree already proved out, and removing a branch's changes is not something
    // the gate needs to re-verify — re-gating would cost exactly the "review once" thrift this
    // feature exists for.
    const sidedIds = new Set((gate.sided ?? []).map((s) => s.workspaceId));
    const sidedMembers: TrainRunResult["sided"] = asm.included
      .filter((m) => sidedIds.has(m.workspaceId))
      .map((member) => ({ member, reason: gate.sided!.find((s) => s.workspaceId === member.workspaceId)!.reason }));
    // #1190: the self-describing landing commit (subject names the parent train + members, body
    // carries the gate evidence, `Merge-Train:` trailer names the row). Same for every landing
    // path below, since each of them lands the same gated evidence.
    const commitEvidence = trainId ? { evidence: { trainId, gateRuns: 1, gateMessage: gate.message } } : {};

    // #1277: a sided member is landed by re-assembling WITHOUT it, which would discard the fix
    // agent's commits. Nothing verified would land, so this is red; the fallback decides what next.
    if (fixLanded && sidedIds.size > 0) {
      return await finish({
        trainRef: asm.trainRef, landed: [], dropped: asm.dropped, closeFailures, gateRejected: [], sided: [], gateRuns: 1,
        gateFailure: "the train review sided member(s) after the fix agent's change; re-assembling without them would discard the fix",
      }, "red");
    }

    if (sidedIds.size === 0) {
      // #1193: when this attempt was coordinated as part of a concurrent bisect split (it was
      // handed a `waitForLandTurn`), an earlier sibling landing while we waited is an EXPECTED,
      // self-inflicted base move, not the external interference `landMergeTrain`'s throw exists
      // to catch — so speculatively recover from it rather than let the whole train throw.
      // Outside that (no `waitForLandTurn`: a lone attempt, or the ordinary sequential path,
      // where `assembleMergeTrain` always runs against the freshly-current base already), a base
      // move is exactly the anomaly it always was, and falls through to `landMergeTrain`'s own
      // check unchanged.
      //
      // The gate verified `asm.trainSha` (the base sha AT GATE TIME plus these members), not the
      // tree a --no-ff merge into the NEW base would produce, so recovering means re-assembling
      // the SAME already-gated members onto the CURRENT base — deliberately no re-gate, since
      // gating a second time would erase exactly the wall-clock saving this feature exists for —
      // and landing THAT. This is the "speculative" half of speculative bisect: a member that no
      // longer assembles cleanly (a genuine conflict with what just landed) is dropped exactly as
      // an ordinary assembly conflict, falling back to the per-ticket path, rather than landed
      // unverified. (The sided path below re-assembles onto the current base anyway, so it
      // needs no such recovery.)
      let landAsm = asm;
      const additionalDropped: TrainRunResult["dropped"] = [];
      const currentBase = await revParse(repoPath, baseBranch);
      // #1277: never for a fixed tree — re-assembling the members would drop the agent's commits
      // and land the very red tree the fix was for. A base move then refuses in `landMergeTrain`.
      if (!args.waitForLandTurn && !fixLanded && currentBase !== asm.baseSha) {
        // A lone attempt whose base moved during the gate: keep the verdict only when the move
        // was verdict-neutral (base-move-relevance.ts); otherwise `landMergeTrain` refuses.
        const neutral = await reassembleAfterNeutralBaseMove({ repoPath, baseBranch, asm, currentBase, label });
        if (neutral) {
          neutralRef = neutral.trainRef;
          landAsm = neutral;
        }
      }
      if (args.waitForLandTurn && currentBase !== asm.baseSha) {
        landAsm = await assembleMergeTrain({ repoPath, baseBranch, members: asm.included, label });
        additionalDropped.push(...landAsm.dropped);
        if (landAsm.included.length === 0 || !landAsm.trainSha) {
          return await finish(
            {
              trainRef: landAsm.trainRef,
              landed: [],
              dropped: [...asm.dropped, ...additionalDropped],
              closeFailures,
              gateRejected: [],
              sided: [],
              gateRuns: 1,
              gateFailure: "base moved after gating and no member could be re-assembled onto the new base",
            },
            "assembly_empty",
          );
        }
        await assertTrainPreservesAncestry(repoPath, landAsm.trainRef, landAsm.included, baseBranch);
      }

      const { mergeSha } = await landMergeTrain({
        repoPath,
        baseBranch,
        trainRef: landAsm.trainRef,
        // Guaranteed non-null: either `asm.trainSha` (checked at the top of this function) when
        // the base never moved, or `landAsm.trainSha` (checked just above) when it did.
        trainSha: landAsm.trainSha!,
        baseSha: landAsm.baseSha,
        included: landAsm.included,
        label,
        ...commitEvidence,
      });
      // Bookkeeping AFTER the work is safely on the base. A failure here leaves a member merged
      // but not marked — recoverable by the existing done-unmerged/already-merged reconcilers,
      // and reported rather than swallowed.
      for (const member of landAsm.included) {
        try {
          await closeMember(member.workspaceId);
        } catch (err) {
          const reason = errorMessage(err);
          closeFailures.push({ member, reason });
          console.warn(`[merge-train] landed ${member.branch} but could not close its workspace: ${reason.slice(0, 200)}`);
        }
      }
      return await finish({ trainRef: landAsm.trainRef, landed: landAsm.included, dropped: [...asm.dropped, ...additionalDropped], mergeSha, closeFailures, gateRejected: [], sided: [], gateRuns: 1 }, "landed");
    }

    const toLand = asm.included.filter((m) => !sidedIds.has(m.workspaceId));
    if (toLand.length === 0) {
      // Everyone left in this attempt was sided — nothing to land, but every member is
      // attributed, so there is no batch-level failure to blame on anyone else.
      return await finish({ trainRef: asm.trainRef, landed: [], dropped: asm.dropped, closeFailures, gateRejected: [], sided: sidedMembers, gateRuns: 1, gateFailure: "every remaining member was sided by the train review" }, "sided");
    }

    const reassembled = await assembleMergeTrain({ repoPath, baseBranch, members: toLand, label: `${label}-sided` });
    try {
      if (reassembled.included.length === 0 || !reassembled.trainSha) {
        return await finish({
          trainRef: asm.trainRef, landed: [], dropped: [...asm.dropped, ...reassembled.dropped], closeFailures,
          gateRejected: [], sided: sidedMembers, gateRuns: 1,
          gateFailure: "no members could be re-assembled after removing the sided member(s)",
        }, "sided");
      }
      await assertTrainPreservesAncestry(repoPath, reassembled.trainRef, reassembled.included, baseBranch);
      const { mergeSha } = await landMergeTrain({
        repoPath, baseBranch, trainRef: reassembled.trainRef, trainSha: reassembled.trainSha,
        baseSha: reassembled.baseSha, included: reassembled.included,
        label, ...commitEvidence,
      });

      // Bookkeeping AFTER the work is safely on the base. A failure here leaves a member merged
      // but not marked — recoverable by the existing done-unmerged/already-merged reconcilers,
      // and reported rather than swallowed.
      for (const member of reassembled.included) {
        try {
          await closeMember(member.workspaceId);
        } catch (err) {
          const reason = errorMessage(err);
          closeFailures.push({ member, reason });
          console.warn(`[merge-train] landed ${member.branch} but could not close its workspace: ${reason.slice(0, 200)}`);
        }
      }

      return await finish({
        trainRef: asm.trainRef, landed: reassembled.included, dropped: [...asm.dropped, ...reassembled.dropped],
        mergeSha, closeFailures, gateRejected: [], sided: sidedMembers, gateRuns: 1,
      }, "landed");
    } finally {
      await deleteTrainRef(repoPath, reassembled.trainRef);
    }
  } finally {
    await deleteTrainRef(repoPath, asm.trainRef);
    if (neutralRef) await deleteTrainRef(repoPath, neutralRef);
  }
}

type AssembledTrain = TrainAssemblyResult & { conflictClusters: ConflictCluster[] };

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
}): Promise<AssembledTrain | null> {
  const { repoPath, baseBranch, asm, currentBase, label } = args;
  try {
    const assessment = await assessBaseMove({ cwd: repoPath, baseBefore: asm.baseSha, baseAfter: currentBase, branchSha: asm.trainSha });
    if (!assessment.keep) return null;
    const rebased = await assembleMergeTrain({ repoPath, baseBranch, members: asm.included, label: `${label}-rebased` });
    const clean = rebased.trainSha !== null && rebased.dropped.length === 0 && rebased.included.length === asm.included.length;
    if (!clean || rebased.baseSha !== currentBase) {
      await deleteTrainRef(repoPath, rebased.trainRef);
      return null;
    }
    await assertTrainPreservesAncestry(repoPath, rebased.trainRef, rebased.included, baseBranch);
    console.log(
      `[merge-train] ${label}: base moved ${asm.baseSha.slice(0, 8)}..${currentBase.slice(0, 8)} during the gate; ` +
        `landing without a re-gate because ${assessment.reason}`,
    );
    return rebased;
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
