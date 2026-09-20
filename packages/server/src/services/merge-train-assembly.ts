import { mergeBranch, isAncestor, revParse } from "@agentic-kanban/shared/lib/git-service";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import {
  computeConflictGraph,
  conflictClusters,
  orderByLeastOverlap,
  pickConflictFreeSet,
} from "./merge-train-conflict-graph.js";

/**
 * Split out of `merge-train.service.ts` (#1203/#1204 combined pushed it past the god-module
 * gate's 1000-line hard ceiling) — the ASSEMBLY half of a train's lifecycle: building the
 * integration ref and preserving the ancestry invariant. `merge-train.service.ts` re-exports
 * everything here, so no importer needs to know about the split.
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
  /** The branch tip sha at landing time, for the merge commit body (#1190). Not set until then. */
  tipSha?: string;
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
export function dedupeConflictClusters(clusters: ConflictCluster[]): ConflictCluster[] {
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
 * A train's label identifies the ROW/ref across every bisect sub-attempt, e.g. `train/2026-09-17-03`.
 * A bisect child extends its parent's label with a lowercase letter (`train/2026-09-17-03a`,
 * `…03ab`, …, see `landGreenest`'s `${subLabel}a`/`${subLabel}b`) — so the parent train's label is
 * whatever remains after stripping every trailing bisect letter. The landing merge commit names
 * THIS, never the sub-attempt label, so the history reads as one train regardless of which
 * bisect half actually landed.
 */
export function parentTrainLabel(label: string): string {
  return label.replace(/[a-z]+$/, "");
}

/**
 * Per-project, per-day sequence label (#1190): `train/YYYY-MM-DD-NN`, replacing the old
 * `q<base36 timestamp>` scratch label that carried no information a reader could use — a
 * `git log --first-parent` full of `Merge branch 'kanban/train/qmu4t981aba'` explains nothing
 * about which tickets rode together. `seq` is 1-based and left-padded to 2 digits (`01`..`99`,
 * unpadded beyond that — a project running 100 trains in one day is not a formatting problem).
 */
export function formatTrainLabel(dateStamp: string, seq: number): string {
  const padded = seq < 10 ? `0${seq}` : `${seq}`;
  return `train/${dateStamp}-${padded}`;
}

/** `YYYY-MM-DD` from an ISO instant, in UTC — the calendar day a train's sequence counts against. */
export function trainDateStamp(now?: string): string {
  return (now ?? new Date().toISOString()).slice(0, 10);
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
