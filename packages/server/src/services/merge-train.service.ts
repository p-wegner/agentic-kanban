import { mergeBranch, isAncestor, revParse } from "@agentic-kanban/shared/lib/git-service";
import { gitExec, gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";

/**
 * Release trains: gate N tickets ONCE instead of N times.
 *
 * Today every member of a merge wave pays its own full pre-merge gate — on this repo
 * `check:arch && typecheck && test:mine && build`, 30-45 minutes — and they serialize behind
 * the repo lock, so a wave of 4 costs 4 gates. A train instead assembles the members onto one
 * integration ref, gates that ref once, and lands it as a batch.
 *
 * It is also STRICTLY MORE correct than the per-ticket gate, which is the part worth
 * understanding: a per-ticket gate verifies the feature branch in isolation, un-rebased. It
 * never tests the two-parent merge commit that actually lands, so two branches that are each
 * green can merge to a red master with no textual conflict at all (a semantic conflict —
 * `merge-tree` reports no problem and the merge proceeds). A train gates the assembled tree,
 * which IS what lands.
 *
 * ## The one hard constraint: --no-ff, never squash and never rebase
 *
 * Every downstream invariant in this codebase is ANCESTRY-based, not shape-based:
 *   - `checkBranchTipIsAncestor` (merge-executor.service.ts) asserts the member tip is
 *     reachable from the target after the merge;
 *   - `checkAlreadyMerged` (workspace-already-merged.service.ts) decides "already merged" by
 *     ancestry;
 *   - the done-unmerged invariant scanner treats a member whose tip is NOT an ancestor as a
 *     `silent_merge_loss` and RE-MERGES it — and it has no patch-equivalence check, so a
 *     squashed member gets its work applied to master a second time as duplicate commits.
 *
 * A `--no-ff` merge preserves every member tip as an ancestor of the train, and the train's
 * tip as an ancestor of master, so all of the above keep working with no changes. Squashing or
 * rebasing members into the train breaks all of them at once. `assertTrainPreservesAncestry`
 * exists to make that failure loud rather than silent.
 */

export interface TrainMember {
  workspaceId: string;
  /** The member's feature branch. Its tip must remain an ancestor of the train. */
  branch: string;
  /** For logs and the dropped-member report. */
  issueNumber?: number | null;
}

export interface TrainAssemblyResult {
  /** The integration ref the members were assembled onto. */
  trainRef: string;
  /** Members successfully merged into the train, in the order they landed. */
  included: TrainMember[];
  /** Members left out, with why — a conflict against the train, or an unresolvable branch. */
  dropped: Array<{ member: TrainMember; reason: string }>;
  /** The train tip after assembly, or null when nothing was included. */
  trainSha: string | null;
  /** The base tip the train was built from — the gate's evidence baseSha for the batch. */
  baseSha: string;
}

/** Name of the integration ref for a train. Kept under a `kanban/` namespace to be obviously ours. */
export function trainRefName(label: string): string {
  return `kanban/train/${label}`;
}

/**
 * Point `trainRef` at `baseBranch`'s current tip, creating it if absent.
 *
 * `-f` is safe here precisely because a train ref is disposable scratch space that this
 * service owns: it is never checked out, never pushed, and carries no work that is not
 * already on a member branch.
 */
async function resetTrainRef(repoPath: string, trainRef: string, baseBranch: string): Promise<string> {
  const baseSha = await revParse(repoPath, baseBranch);
  // `{ cwd }` — gitExecOrThrow takes an OPTIONS OBJECT. A bare string leaves cwd undefined and
  // the command silently runs in the process cwd, against the wrong repository.
  await gitExecOrThrow(["branch", "-f", trainRef, baseSha], { cwd: repoPath });
  return baseSha;
}

/**
 * Assemble members onto a fresh train ref with `--no-ff` merges.
 *
 * A member that conflicts with the train is DROPPED rather than failing the batch: one bad
 * member must not deny the whole wave the amortized gate. Dropped members keep their branches
 * untouched and fall back to the normal per-ticket path.
 */
export async function assembleMergeTrain(args: {
  repoPath: string;
  baseBranch: string;
  members: TrainMember[];
  label: string;
}): Promise<TrainAssemblyResult> {
  const { repoPath, baseBranch, members, label } = args;
  const trainRef = trainRefName(label);
  const baseSha = await resetTrainRef(repoPath, trainRef, baseBranch);

  const included: TrainMember[] = [];
  const dropped: Array<{ member: TrainMember; reason: string }> = [];

  for (const member of members) {
    try {
      // mergeBranch never touches a working tree when the target is not checked out (the train
      // ref never is), so this is pure ref/object plumbing: merge-tree -> commit-tree -> CAS.
      await mergeBranch(repoPath, member.branch, trainRef);
      included.push(member);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      dropped.push({ member, reason });
      console.warn(
        `[merge-train] dropped ${member.branch}${member.issueNumber ? ` (#${member.issueNumber})` : ""} from train ${trainRef}: ${reason.slice(0, 200)}`,
      );
    }
  }

  const trainSha = included.length > 0 ? await revParse(repoPath, trainRef) : null;
  return { trainRef, included, dropped, trainSha, baseSha };
}

/**
 * Fail loudly if any included member's tip is not reachable from the train.
 *
 * This is the guard against the squash/rebase mistake described in the module docstring. It is
 * cheap (one `merge-base --is-ancestor` per member) and it protects an expensive, hard-to-debug
 * failure: the done-unmerged scanner silently re-merging landed work as duplicate commits.
 */
export async function assertTrainPreservesAncestry(
  repoPath: string,
  trainRef: string,
  included: TrainMember[],
): Promise<void> {
  const broken: string[] = [];
  for (const member of included) {
    const tip = await revParse(repoPath, member.branch).catch(() => null);
    if (!tip) {
      broken.push(`${member.branch} (unresolvable)`);
      continue;
    }
    if (!(await isAncestor(repoPath, tip, trainRef))) broken.push(member.branch);
  }
  if (broken.length > 0) {
    throw new Error(
      `[merge-train] ancestry invariant violated on ${trainRef}: ${broken.join(", ")} not reachable from the train. ` +
        `Members must be merged with --no-ff — squash/rebase breaks checkAlreadyMerged and makes the ` +
        `done-unmerged scanner re-merge landed work as duplicate commits.`,
    );
  }
}

/**
 * Land an assembled, GATED train onto the base branch.
 *
 * Caller contract: the gate must already have passed against `trainSha`. This function
 * re-checks the ancestry invariant and refuses to land a train whose base moved underneath it
 * (that would land a tree nobody verified) — it does NOT re-run the gate itself, because
 * deciding that belongs to the caller that owns the gate token.
 */
export async function landMergeTrain(args: {
  repoPath: string;
  baseBranch: string;
  trainRef: string;
  trainSha: string;
  baseSha: string;
  included: TrainMember[];
}): Promise<{ mergeSha: string; mergeMessage: string }> {
  const { repoPath, baseBranch, trainRef, trainSha, baseSha, included } = args;
  if (included.length === 0) throw new Error(`[merge-train] refusing to land empty train ${trainRef}`);

  const currentBase = await revParse(repoPath, baseBranch);
  if (currentBase !== baseSha) {
    throw new Error(
      `[merge-train] base '${baseBranch}' moved from ${baseSha.slice(0, 8)} to ${currentBase.slice(0, 8)} ` +
        `after the train was gated — refusing to land an unverified tree. Reassemble and re-gate.`,
    );
  }
  const currentTrain = await revParse(repoPath, trainRef);
  if (currentTrain !== trainSha) {
    throw new Error(
      `[merge-train] train ${trainRef} moved from ${trainSha.slice(0, 8)} to ${currentTrain.slice(0, 8)} after gating — refusing to land.`,
    );
  }

  await assertTrainPreservesAncestry(repoPath, trainRef, included);
  // `mergeBranch` resolves with a human-readable MESSAGE, not a SHA, so read the resulting
  // base tip explicitly — callers want the commit that landed, for stamping and for logs.
  const mergeMessage = await mergeBranch(repoPath, trainRef, baseBranch);
  const mergeSha = await revParse(repoPath, baseBranch);
  // Post-condition: every member is now reachable from the base. This is what lets each
  // member be stamped as merged and keeps the reconcilers from treating them as lost work.
  for (const member of included) {
    const tip = await revParse(repoPath, member.branch);
    if (!(await isAncestor(repoPath, tip, baseBranch))) {
      throw new Error(
        `[merge-train] landed ${trainRef} into ${baseBranch} but member ${member.branch} is NOT an ancestor — ` +
          `refusing to report success; the batch must be reconciled by hand.`,
      );
    }
  }
  return { mergeSha, mergeMessage };
}

/**
 * Run a full train: assemble → gate ONCE → land → close each member out.
 *
 * Injected ports rather than direct imports, so the orchestration is testable without a
 * server, a DB, or a 40-minute gate:
 *  - `runGate` gates the assembled train. It receives the train ref and a worktree path the
 *    caller prepared for it (the gate must run the project's verify script against the
 *    train's tree, not a member's).
 *  - `closeMember` marks a member merged. Pass the EXISTING `reconcileAlreadyMerged` here:
 *    once the train has landed, every member's tip is an ancestor of the base, which is
 *    exactly the precondition that function checks. Reusing it means the train does not
 *    reimplement mergedAt/status/issue-comment bookkeeping — the part where a bespoke
 *    implementation would silently diverge from the reconcilers.
 *
 * A red train lands NOTHING. The members are untouched, so the caller falls back to the
 * per-ticket path, which is slower but attributes the failure to a single ticket.
 */
export interface TrainRunResult {
  trainRef: string;
  landed: TrainMember[];
  dropped: Array<{ member: TrainMember; reason: string }>;
  /** Set when the batch did not land; the members remain unmerged. */
  gateFailure?: string;
  mergeSha?: string;
  /** Members that landed but could not be closed out — they ARE merged; only bookkeeping lags. */
  closeFailures: Array<{ member: TrainMember; reason: string }>;
}

export async function runMergeTrain(args: {
  repoPath: string;
  baseBranch: string;
  members: TrainMember[];
  label: string;
  runGate: (ctx: { trainRef: string; trainSha: string }) => Promise<{ passed: boolean; message: string }>;
  closeMember: (workspaceId: string) => Promise<void>;
}): Promise<TrainRunResult> {
  const { repoPath, baseBranch, members, label, runGate, closeMember } = args;

  const asm = await assembleMergeTrain({ repoPath, baseBranch, members, label });
  const closeFailures: TrainRunResult["closeFailures"] = [];

  // The train ref is scratch state, so its cleanup belongs in a `finally` rather than at each
  // of the three exits. `deleteTrainRef` used to be called on assembly-empty, gate-fail and
  // success — but a THROW from `assertTrainPreservesAncestry` or `landMergeTrain` (base moved
  // under us, ancestry violation) skipped all three, so every failed train left a
  // `refs/kanban/train/q…` branch behind and they accumulated for the life of the repo.
  // `deleteTrainRef` is itself best-effort and never throws, so it cannot mask a real error.
  try {
    if (asm.included.length === 0 || !asm.trainSha) {
      return { trainRef: asm.trainRef, landed: [], dropped: asm.dropped, closeFailures, gateFailure: "no members could be assembled onto the train" };
    }

    // Cheap insurance before spending a gate on it: if assembly somehow produced a train that
    // does not contain a member's tip, everything downstream would be wrong.
    await assertTrainPreservesAncestry(repoPath, asm.trainRef, asm.included);

    const gate = await runGate({ trainRef: asm.trainRef, trainSha: asm.trainSha });
    if (!gate.passed) {
      return { trainRef: asm.trainRef, landed: [], dropped: asm.dropped, closeFailures, gateFailure: gate.message };
    }

    const { mergeSha } = await landMergeTrain({
      repoPath,
      baseBranch,
      trainRef: asm.trainRef,
      trainSha: asm.trainSha,
      baseSha: asm.baseSha,
      included: asm.included,
    });

    // Bookkeeping AFTER the work is safely on the base. A failure here leaves a member merged
    // but not marked — recoverable by the existing done-unmerged/already-merged reconcilers,
    // and reported rather than swallowed.
    for (const member of asm.included) {
      try {
        await closeMember(member.workspaceId);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        closeFailures.push({ member, reason });
        console.warn(`[merge-train] landed ${member.branch} but could not close its workspace: ${reason.slice(0, 200)}`);
      }
    }

    return { trainRef: asm.trainRef, landed: asm.included, dropped: asm.dropped, mergeSha, closeFailures };
  } finally {
    await deleteTrainRef(repoPath, asm.trainRef);
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
