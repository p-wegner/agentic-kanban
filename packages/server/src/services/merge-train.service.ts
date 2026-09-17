import { mergeBranch, isAncestor, revParse } from "@agentic-kanban/shared/lib/git-service";
import { gitExec, gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { MergeTrainAttemptDto, MergeTrainAttemptVerdict } from "@agentic-kanban/shared/types";
import {
  computeConflictGraph,
  conflictClusters,
  orderByLeastOverlap,
  pickConflictFreeSet,
} from "./merge-train-conflict-graph.js";
import { verifyChainSemaphoreActive, verifyChainSemaphoreConcurrency } from "./verify-chain-semaphore.js";

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

/**
 * A member left out of a train, with why. `deferred` (#1191) marks the member-vs-member case:
 * the branch is clean against the base and collides only with a sibling that IS riding this
 * train, so it is queued for the next train window (#905) rather than sent to the rebase path
 * — once the sibling has landed, the next assembly decides afresh. A drop without `deferred`
 * conflicts with the train ref itself (a base conflict, or an unresolvable branch) and stays
 * the author's to rebase.
 */
export interface DroppedTrainMember {
  member: TrainMember;
  reason: string;
  deferred?: true;
}

export interface TrainAssemblyResult {
  /** The integration ref the members were assembled onto. */
  trainRef: string;
  /** Members successfully merged into the train, in the order they landed. */
  included: TrainMember[];
  /** Members left out, with why — a conflict against the train, or an unresolvable branch. */
  dropped: DroppedTrainMember[];
  /** The train tip after assembly, or null when nothing was included. */
  trainSha: string | null;
  /** The base tip the train was built from — the gate's evidence baseSha for the batch. */
  baseSha: string;
}

/**
 * #1191 — one connected component of the member-vs-member conflict graph computed for THIS
 * assembly, restricted to members that were actually requested. Emitted so the caller can feed
 * it to `propose_ticket_groups`/`group-scan` as a candidate `coupled_with` group: tickets that
 * collide on every train attempt are coupled tickets in disguise (decision 015).
 */
export interface ConflictCluster {
  workspaceIds: string[];
}

/** Dedupe clusters by their member SET — a bisect re-discovers the same cluster at every level. */
function dedupeConflictClusters(clusters: ConflictCluster[]): ConflictCluster[] {
  const seen = new Set<string>();
  const out: ConflictCluster[] = [];
  for (const c of clusters) {
    const key = [...c.workspaceIds].sort().join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
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
 * #1191 — conflict-aware: before touching any ref, every PAIR of members is checked for a
 * member-vs-member conflict via read-only `merge-tree` (`computeConflictGraph`). A maximum
 * conflict-free SET is picked from that graph (`pickConflictFreeSet`) and stacked onto the train
 * in LEAST-OVERLAP order (`orderByLeastOverlap`, proposal 2026-08-25 §4.3) rather than the
 * caller's plan order — so a member is no longer dropped merely because of where it sat in the
 * list, and the members most likely to still collide (with the base, or with something the set
 * had to exclude) are merged last, closest to the point where a genuine problem shows up.
 *
 * A member excluded by the conflict-free-set pass is reported as dropped with the SPECIFIC
 * member it conflicts with named in the reason — not just "conflict" — and marked `deferred`:
 * its branch is clean against the base, so it is left in the queue for the next train window
 * (#905) rather than sent to the rebase path. Assembly against the train ref can still
 * additionally drop a member for a base-only conflict (the member is clean against every
 * sibling but not against the base itself); that case keeps the original per-member reason.
 *
 * One bad member must not deny the whole wave the amortized gate — every excluded/dropped member
 * keeps its branch untouched. Stacking is `--no-ff` onto the tip in the chosen order; no member
 * branch is ever rebased, so the ancestry invariant in the module docstring is unchanged.
 */
export async function assembleMergeTrain(args: {
  repoPath: string;
  baseBranch: string;
  members: TrainMember[];
  label: string;
}): Promise<TrainAssemblyResult & { conflictClusters: ConflictCluster[] }> {
  const { repoPath, baseBranch, members, label } = args;
  const trainRef = trainRefName(label);
  const baseSha = await resetTrainRef(repoPath, trainRef, baseBranch);

  const included: TrainMember[] = [];
  const dropped: DroppedTrainMember[] = [];

  let orderedForAssembly = members;
  let clusters: ConflictCluster[] = [];
  if (members.length >= 2) {
    const graph = await computeConflictGraph(repoPath, members);
    const { kept, excluded } = pickConflictFreeSet(members, graph);
    for (const e of excluded) {
      const reason =
        `conflicts with ${e.conflictsWith.branch}` +
        (e.conflictsWith.issueNumber ? ` (#${e.conflictsWith.issueNumber})` : "") +
        " — deferred to the next train";
      dropped.push({ member: e.member, reason, deferred: true });
      console.warn(
        `[merge-train] deferred ${e.member.branch}${e.member.issueNumber ? ` (#${e.member.issueNumber})` : ""} from train ${trainRef}: ${reason}`,
      );
    }
    orderedForAssembly = orderByLeastOverlap(kept, graph);
    clusters = conflictClusters(members.map((m) => m.workspaceId), graph).map((workspaceIds) => ({ workspaceIds }));
  }

  for (const member of orderedForAssembly) {
    try {
      // mergeBranch never touches a working tree when the target is not checked out (the train
      // ref never is), so this is pure ref/object plumbing: merge-tree -> commit-tree -> CAS.
      await mergeBranch(repoPath, member.branch, trainRef);
      included.push(member);
    } catch (err) {
      // A member the conflict-free-set pass judged clean against every sibling can still fail
      // here: that check is member-vs-member, never against the BASE, so this is a base-only
      // conflict (or the rare TOCTOU where a sibling branch moved between the two checks).
      const reason = errorMessage(err);
      dropped.push({ member, reason });
      console.warn(
        `[merge-train] dropped ${member.branch}${member.issueNumber ? ` (#${member.issueNumber})` : ""} from train ${trainRef}: ${reason.slice(0, 200)}`,
      );
    }
  }

  const trainSha = included.length > 0 ? await revParse(repoPath, trainRef) : null;
  return { trainRef, included, dropped, trainSha, baseSha, conflictClusters: clusters };
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
  /** Could not be assembled — `deferred` ones wait for the next train, the rest need a rebase. */
  dropped: DroppedTrainMember[];
  /** Set when the batch did not land; the members remain unmerged. */
  gateFailure?: string;
  /**
   * How many gate runs this train cost, INCLUDING bisect re-gates (#492). The happy path is
   * 1 for any batch size — the whole point — and a reader needs to see when it was not, or
   * the "N merges, 1 gate" claim is unfalsifiable.
   */
  gateRuns: number;
  /**
   * Members a bisect individually proved red (#492). They are NOT in `landed` and NOT in
   * `dropped` — `dropped` means "could not be assembled" (a conflict), this means "assembled
   * fine and failed the gate on its own". Keeping them apart matters: a conflict is the
   * author's to rebase, a gate failure is the author's to FIX, and reporting one as the other
   * sends them to the wrong place.
   */
  gateRejected: Array<{ member: TrainMember; reason: string }>;
  /**
   * #1194 — members a TRAIN REVIEW attributed a blocking finding to (`runGate`'s `sided`).
   * Neither `dropped` (a conflict) nor `gateRejected` (the code itself failed the gate): the
   * assembled tree passed the gate fine, but the reviewer found a problem specific to this
   * member's ticket. Pulled from `included` and re-landed without them — same "don't fail the
   * whole train for one member" shape as `dropped`/`gateRejected`, a third reason a member can
   * leave a train before landing.
   */
  sided: Array<{ member: TrainMember; reason: string }>;
  mergeSha?: string;
  /** Members that landed but could not be closed out — they ARE merged; only bookkeeping lags. */
  closeFailures: Array<{ member: TrainMember; reason: string }>;
  /**
   * #1181 — set when the gate PASSED but `shouldLand` refused the landing (the train's row was
   * abandoned while it ran). Distinct from `gateFailure`: nothing about the code is red, so
   * the bisect driver must not split on it and no member may be blamed for it.
   */
  landRefused?: string;
  /**
   * #1189 — one node per assemble → gate → land cycle, in the order they finished (a bisect's
   * root first, then its halves depth-first). The tree the panel renders; the sum of the nodes'
   * `gateRuns` is `gateRuns` above.
   */
  attempts: MergeTrainAttemptDto[];
  /**
   * #1191 — every member-vs-member conflict cluster found across every attempt (deduped by
   * member set), for the caller to feed to `propose_ticket_groups`/`group-scan`. A cluster here
   * means those tickets collided on THIS train's conflict graph — nothing here is written
   * anywhere by this module; the caller decides whether/how to propose it. Optional (defaults to
   * empty) so a hand-built result in a test — this module's own included — doesn't have to name
   * it every time.
   */
  conflictClusters?: ConflictCluster[];
}

/**
 * The gate port. `sided` (#1194) is set when a train-scoped review ran beside the gate and
 * attributed a blocking finding to specific members. Only meaningful when `passed` is true: a
 * review finding pulls its member into a siding, it does not fail the gate for everyone else.
 */
export type TrainGate = (ctx: {
  trainRef: string;
  trainSha: string;
  included: TrainMember[];
  /**
   * The ATTEMPT's label (`q1`, `q1a`, `q1b`, …), not the train's — #1193 gates two bisect
   * halves at once, so a caller keying anything per gate (its synthetic workspace id, log
   * lines) must key it per half or the two runs become indistinguishable.
   */
  label: string;
}) => Promise<{
  passed: boolean;
  message: string;
  sided?: Array<{ workspaceId: string; reason: string }>;
}>;

export async function runMergeTrain(args: {
  repoPath: string;
  baseBranch: string;
  members: TrainMember[];
  label: string;
  runGate: TrainGate;
  closeMember: (workspaceId: string) => Promise<void>;
  /**
   * Bisect a red batch instead of rejecting it whole (#492). Default ON: without it, one bad
   * branch blocks every other branch in the queue indefinitely, which is the failure mode
   * that made batching not worth having. Set false to restore the all-or-nothing behaviour.
   */
  bisectOnFailure?: boolean;
  /**
   * Does this gate failure message describe a BROKEN ENVIRONMENT (missing dependency, absent
   * tool) rather than a real regression in the code (#1154)? Bisecting such a failure is worse
   * than useless: every half of the split shares the same broken staging worktree, so each
   * re-gate reproduces the identical verdict, and halving down to single members eventually
   * blames an arbitrary branch for a problem that is not in its code at all — observed as a
   * 9-gate-run, 3h23m train that landed nothing over a missing `packages/e2e` install.
   *
   * When this returns true, the whole subset is treated as attribution-free: `gateFailure` is
   * kept, but nobody is added to `gateRejected` and no split is attempted. Optional so a caller
   * that never classifies failures gets today's behaviour unchanged.
   */
  isEnvironmentFailure?: (message: string) => boolean;
  /**
   * #1181 — asked ONCE, after a green gate and immediately before `landMergeTrain`. Return a
   * refusal reason to leave the base untouched (the result then carries `landRefused` and the
   * gate failure text, lands nothing, and is not bisected), or null to land. The caller uses
   * it to re-read the train's row: a row marked `abandoned` mid-gate must not land.
   */
  shouldLand?: () => Promise<string | null>;
  /**
   * #1189 — called once per attempt, AS IT FINISHES, with the node that also lands in the
   * result's `attempts`. The caller persists it so a live train shows partial progress rather
   * than a tree that appears whole at the end. Best-effort: a throw here is logged and never
   * fails the train — the merge already happened (or did not) regardless of the bookkeeping.
   */
  onAttempt?: (attempt: MergeTrainAttemptDto) => Promise<void>;
  /**
   * #1193 — how many verify-chain slots are free RIGHT NOW, so a red bisect can gate both
   * halves of a split at once instead of one after another. Defaults to a live read of the
   * verify-chain semaphore (`verifyChainSemaphoreConcurrency() - verifyChainSemaphoreActive()`);
   * a test overrides it rather than depending on that module's process-global state.
   */
  freeVerifySlots?: () => number;
}): Promise<TrainRunResult> {
  const { repoPath, baseBranch, members, label, runGate, closeMember } = args;
  const bisect = args.bisectOnFailure !== false;
  const isEnvironmentFailure = args.isEnvironmentFailure ?? (() => false);
  const freeVerifySlots = args.freeVerifySlots ?? defaultFreeVerifySlots;

  /**
   * Wait for `a`, then `b` (either may be absent) — used to chain a child's landing behind
   * both its outer predecessor and, when running in parallel, its sibling's completion.
   */
  function afterBoth(a?: Promise<void>, b?: Promise<void>): Promise<void> | undefined {
    if (!a) return b;
    if (!b) return a;
    return Promise.all([a, b]).then(() => undefined);
  }

  /**
   * Land as much of `subset` as is green, splitting on failure.
   *
   * A red train of one member is ATTRIBUTION — that member is the culprit, and it goes to
   * `gateRejected` so the caller can tell its author. A red train of several is a question,
   * and halving answers it: each half is assembled against the base as it stands THEN, so a
   * green first half lands before the second half is even built. That is what keeps the good
   * branches moving past a bad one.
   *
   * Cost: 1 gate run when the batch is green (the case this feature exists for). With k bad
   * branches out of n it is bounded by O(k log n) runs — worse than n only when nearly
   * everything is red, and in that case the queue was never going to land in one run anyway.
   *
   * #1193 — `waitForPredecessor` (resolved before this subset may LAND, never before it may be
   * assembled or gated) and `notifyDone` (called once this subset's own landing — including any
   * further nested splits — is fully settled) let a caller run two halves' assemble+gate
   * CONCURRENTLY while keeping their LANDING in the original left-to-right order, which is what
   * keeps `landMergeTrain`'s base-moved refusal meaningful (the base only ever moves under a
   * half that has already had its turn).
   */
  async function landGreenest(
    subset: TrainMember[],
    subLabel: string,
    waitForPredecessor?: Promise<void>,
    notifyDone?: () => void,
  ): Promise<TrainRunResult> {
    try {
      const attempt = await runTrainAttempt({ ...args, members: subset, label: subLabel, isEnvironmentFailure, waitForLandTurn: waitForPredecessor });
      if (attempt.landed.length > 0 || !attempt.gateFailure) return attempt;
      // #1181: a refused landing is not a red gate — splitting would re-gate green code twice
      // and then refuse again. Stop here, attribution-free.
      if (attempt.landRefused) return attempt;
      // #1154: an environment failure fails the SAME way for every subset of the same staging
      // worktree — splitting cannot learn anything a second run at the top level didn't already
      // say, and it can only mislabel branches as individually red. Stop here, attribution-free.
      if (isEnvironmentFailure(attempt.gateFailure)) return attempt;
      // #1185: an assembly-empty subset has NO gate to blame — every member conflicted during
      // assembly and is already under `dropped` with its conflict reason. It must not be split
      // (halving would just re-discover the same conflicts) and, for a singleton, it must NOT be
      // promoted to `gateRejected`: that told the author to FIX a gate failure when the only
      // thing wrong was a conflict to REBASE (observed on trains qmu4t981a / qmu4ymqjx, whose
      // bisectResult named conflicting members with "no members could be assembled").
      if (attempt.dropped.length === subset.length) return attempt;
      // #1194: a siding only ever happens on a GREEN gate — the review attributed a finding to a
      // member, the rest were re-assembled and either landed or conflicted (both attributed). There
      // is nothing red left to search for, so splitting would only re-gate green code.
      if (attempt.sided.length > 0) return attempt;
      // Nothing landed and the gate is why. A red singleton IS attribution.
      if (!bisect || subset.length <= 1) {
        return {
          ...attempt,
          gateRejected: subset.length === 1
            ? [{ member: subset[0], reason: attempt.gateFailure }]
            : attempt.gateRejected,
        };
      }
      const mid = Math.floor(subset.length / 2);
      // #1193: only run both halves' assemble+gate at once when the box actually has room for a
      // second full verify chain right now — otherwise the second half's staging worktree and
      // install are pure overhead, since the semaphore would queue its gate behind the first's
      // anyway (capacity gate: CLAUDE.md).
      const canParallelize = freeVerifySlots() >= 2;
      let first: TrainRunResult;
      let second: TrainRunResult;
      if (canParallelize) {
        let releaseFirst!: () => void;
        const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve; });
        // #1193: `allSettled`, not `all` — `all` rejects as soon as EITHER half throws while
        // the other's async work (already started, up to and including landing onto the base)
        // keeps running unobserved. That would let one half's landing complete after this
        // function has already thrown to its caller, with nothing recording or waiting on it.
        // Settling both first means a throw here always means BOTH halves' git work is done.
        const settled = await Promise.allSettled([
          landGreenest(subset.slice(0, mid), `${subLabel}a`, waitForPredecessor, releaseFirst),
          landGreenest(subset.slice(mid), `${subLabel}b`, afterBoth(waitForPredecessor, firstDone)),
        ]);
        const rejected = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
        if (rejected) throw rejected.reason;
        [first, second] = (settled as PromiseFulfilledResult<TrainRunResult>[]).map((s) => s.value);
      } else {
        first = await landGreenest(subset.slice(0, mid), `${subLabel}a`, waitForPredecessor);
        second = await landGreenest(subset.slice(mid), `${subLabel}b`, waitForPredecessor);
      }
      return {
        trainRef: attempt.trainRef,
        landed: [...first.landed, ...second.landed],
        dropped: [...attempt.dropped, ...first.dropped, ...second.dropped],
        gateRejected: [...first.gateRejected, ...second.gateRejected],
        sided: [...first.sided, ...second.sided],
        closeFailures: [...first.closeFailures, ...second.closeFailures],
        gateRuns: attempt.gateRuns + first.gateRuns + second.gateRuns,
        attempts: [...attempt.attempts, ...first.attempts, ...second.attempts],
        mergeSha: second.mergeSha ?? first.mergeSha,
        conflictClusters: dedupeConflictClusters([
          ...(attempt.conflictClusters ?? []),
          ...(first.conflictClusters ?? []),
          ...(second.conflictClusters ?? []),
        ]),
        // Only still a whole-batch failure if neither half landed anything.
        ...(first.landed.length + second.landed.length === 0
          ? { gateFailure: attempt.gateFailure }
          : {}),
      };
    } finally {
      notifyDone?.();
    }
  }

  return await landGreenest(members, label);
}

/** The live default for `freeVerifySlots` — how many verify chains could start on this box right now. */
function defaultFreeVerifySlots(): number {
  return Math.max(0, verifyChainSemaphoreConcurrency() - verifyChainSemaphoreActive());
}

/** ONE assemble → gate → land → close cycle. The bisect driver above composes these. */
async function runTrainAttempt(args: {
  repoPath: string;
  baseBranch: string;
  members: TrainMember[];
  label: string;
  runGate: TrainGate;
  closeMember: (workspaceId: string) => Promise<void>;
  shouldLand?: () => Promise<string | null>;
  isEnvironmentFailure: (message: string) => boolean;
  onAttempt?: (attempt: MergeTrainAttemptDto) => Promise<void>;
  /**
   * #1193 — resolved once it is this attempt's turn to LAND (a no-op when absent, i.e. every
   * caller before #1193). Awaited only immediately before `landMergeTrain`, never before
   * assembly or the gate, so two concurrently-gated halves still verify at the same time —
   * only the git-level landing is serialized.
   */
  waitForLandTurn?: Promise<void>;
}): Promise<TrainRunResult> {
  const { repoPath, baseBranch, members, label, runGate, closeMember } = args;

  const asm = await assembleMergeTrain({ repoPath, baseBranch, members, label });
  const closeFailures: TrainRunResult["closeFailures"] = [];
  let gateStartedAt: string | null = null;
  let gateFinishedAt: string | null = null;

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
      dropped: result.dropped.map((d) => ({ workspaceId: d.member.workspaceId, reason: d.reason })),
      gateStartedAt,
      gateFinishedAt,
      gateRuns: result.gateRuns > 0 ? 1 : 0,
      verdict,
      ...(verdict !== "landed" && failure ? { failureHead: failure.slice(0, 300) } : {}),
      ...(result.mergeSha ? { mergeSha: result.mergeSha } : {}),
      ...(result.sided.length > 0 ? { sided: result.sided.map((s) => ({ workspaceId: s.member.workspaceId, reason: s.reason.slice(0, 300) })) } : {}),
    };
    if (args.onAttempt) {
      try {
        await args.onAttempt(record);
      } catch (err) {
        console.warn(`[merge-train] could not record attempt ${label} (non-fatal): ${errorMessage(err).slice(0, 200)}`);
      }
    }
    return { ...result, attempts: [record], conflictClusters: asm.conflictClusters };
  }

  // The train ref is scratch state, so its cleanup belongs in a `finally` rather than at each
  // of the three exits. `deleteTrainRef` used to be called on assembly-empty, gate-fail and
  // success — but a THROW from `assertTrainPreservesAncestry` or `landMergeTrain` (base moved
  // under us, ancestry violation) skipped all three, so every failed train left a
  // `refs/kanban/train/q…` branch behind and they accumulated for the life of the repo.
  // `deleteTrainRef` is itself best-effort and never throws, so it cannot mask a real error.
  try {
    if (asm.included.length === 0 || !asm.trainSha) {
      return await finish({ trainRef: asm.trainRef, landed: [], dropped: asm.dropped, closeFailures, gateRejected: [], sided: [], gateRuns: 0, gateFailure: "no members could be assembled onto the train" }, "assembly_empty");
    }

    // Cheap insurance before spending a gate on it: if assembly somehow produced a train that
    // does not contain a member's tip, everything downstream would be wrong.
    await assertTrainPreservesAncestry(repoPath, asm.trainRef, asm.included);

    // #676: hand the gate the members actually INCLUDED in the assembled tree, not the ones
    // requested. A member dropped during assembly (conflict) is not landing, so keying the
    // deferred-install check on the requested set would block the train on a workspace whose
    // code is not in it.
    gateStartedAt = new Date().toISOString();
    const gate = await runGate({ trainRef: asm.trainRef, trainSha: asm.trainSha, included: asm.included, label });
    gateFinishedAt = new Date().toISOString();
    if (!gate.passed) {
      // #1154/#1189: an environment failure is the train's, not a member's — its own leaf kind.
      const verdict: MergeTrainAttemptVerdict = args.isEnvironmentFailure(gate.message) ? "env_failure" : "red";
      return await finish({ trainRef: asm.trainRef, landed: [], dropped: asm.dropped, closeFailures, gateRejected: [], sided: [], gateRuns: 1, gateFailure: gate.message }, verdict);
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
      if (args.waitForLandTurn && (await revParse(repoPath, baseBranch)) !== asm.baseSha) {
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
        await assertTrainPreservesAncestry(repoPath, landAsm.trainRef, landAsm.included);
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
      await assertTrainPreservesAncestry(repoPath, reassembled.trainRef, reassembled.included);
      const { mergeSha } = await landMergeTrain({
        repoPath, baseBranch, trainRef: reassembled.trainRef, trainSha: reassembled.trainSha,
        baseSha: reassembled.baseSha, included: reassembled.included,
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
