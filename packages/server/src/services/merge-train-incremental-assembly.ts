/**
 * INCREMENTAL assembly (#1572): the train tree is a real worktree opened at the train ref, and each
 * member is merged into it one by one with `git merge --no-ff`. A clean merge joins directly. A
 * member that collides with an earlier SIBLING goes to the train shepherd (one persistent agent,
 * `merge-train-shepherd.ts`) which resolves it in that worktree and commits; the same shepherd later
 * fixes a red gate in the gate's worktree, resuming the same session.
 *
 * Deferral to the next train is the fallback only (shepherd capped, could not resolve, could not be
 * placed). A member that conflicts with the BASE itself is not the shepherd's to fix: it is dropped
 * for its author to rebase, exactly as the ref-only assembly does.
 *
 * Ancestry stays intact: every merge is `--no-ff`, no member branch is rebased or squashed, and the
 * resolution commit is a plain merge commit, so `assertTrainPreservesAncestry` holds as before.
 * The worktree is removed before this returns; the train ref (its branch) carries the result, so the
 * gate opens its own worktree on it exactly as it does after the ref-only assembly.
 */
import { gitExec, gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { MergeTrainAgentFixCaps } from "@agentic-kanban/shared/lib/merge-train-red-strategy";
import { resolveWorktreeClaims } from "@agentic-kanban/shared/lib/worktree-claim";
import type { Database } from "../db/index.js";
import * as gitService from "./git.service.js";
import {
  assembleMergeTrain,
  resetTrainRef,
  trainRefName,
  type ConflictCluster,
  type DroppedTrainMember,
  type TrainAssemblyResult,
  type TrainMember,
} from "./merge-train-assembly.js";
import { computeConflictGraph, conflictClusters, orderByLeastOverlap, pickConflictFreeSet } from "./merge-train-conflict-graph.js";
import { enrichMembersWithTickets, type AgentFixMember } from "./merge-train-agent-fix.js";
import { mergeMembersWithShepherd, type MergeAttempt, type ShepherdMember, type TrainShepherd } from "./merge-train-shepherd.js";
import { removeTrainWorktree } from "./merge-train-worktrees.js";

export type ShepherdAssemblyMember = TrainMember & { issueId?: string; title?: string | null; description?: string | null };

/** Test seam: where the assembly worktree comes from and goes to. Defaults to the shared git service. */
export interface IncrementalAssemblyPorts {
  createWorktree?: (repoPath: string, ref: string) => Promise<string>;
  removeWorktree?: (repoPath: string, worktreePath: string) => Promise<void>;
}

const MERGE_IDENTITY = ["-c", "user.name=agentic-kanban", "-c", "user.email=kanban@localhost"];

async function hasMergeInProgress(cwd: string): Promise<boolean> {
  return (await gitExec(["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd })).code === 0;
}

async function unmergedFiles(cwd: string): Promise<string[]> {
  const r = await gitExec(["diff", "--name-only", "--diff-filter=U"], { cwd });
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** True when the member collides with the BASE alone (read-only `merge-tree`; exit 1 = conflict). */
async function conflictsWithBase(repoPath: string, baseSha: string, branch: string): Promise<boolean> {
  return (await gitExec(["merge-tree", "--write-tree", "--no-messages", baseSha, branch], { cwd: repoPath })).code === 1;
}

/** The git ports `mergeMembersWithShepherd` runs against, over one assembly worktree. */
export function createWorktreeMergePorts(args: {
  repoPath: string;
  worktree: string;
  baseSha: string;
  /** For each member the shepherd may resolve (it collides with a sibling, not with the base): that sibling. */
  rivals: ReadonlyMap<string, AgentFixMember>;
}) {
  const { repoPath, worktree, baseSha } = args;
  let headBefore = "";
  const tryMerge = async (member: ShepherdMember): Promise<MergeAttempt> => {
    headBefore = (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: worktree })).trim();
    const merged = await gitExec([...MERGE_IDENTITY, "merge", "--no-ff", "-m", `Merge branch '${member.branch}'`, member.branch], { cwd: worktree });
    if (merged.code === 0) return { ok: true };
    const detail = `${merged.stdout}\n${merged.stderr}`.trim();
    const conflicted = (await unmergedFiles(worktree)).length > 0;
    if (conflicted && !(await conflictsWithBase(repoPath, baseSha, member.branch))) {
      const rival = args.rivals.get(member.workspaceId);
      return { ok: false, detail, ...(rival ? { conflictsWith: rival } : {}) };
    }
    await gitExec(["merge", "--abort"], { cwd: worktree });
    await gitExec(["reset", "--hard", headBefore], { cwd: worktree });
    return { ok: false, detail: conflicted ? `conflicts with the base: ${detail.slice(0, 200)}` : `merge failed: ${detail.slice(0, 200)}`, unresolvable: true };
  };
  const isResolved = async (member: ShepherdMember): Promise<boolean> => {
    // The shepherd may have resolved every file and left the merge uncommitted: finish it for them.
    if (await hasMergeInProgress(worktree)) {
      if ((await unmergedFiles(worktree)).length > 0) return false;
      const done = await gitExec([...MERGE_IDENTITY, "commit", "--no-edit"], { cwd: worktree });
      if (done.code !== 0) return false;
    }
    const tip = (await gitExec(["rev-parse", member.branch], { cwd: worktree })).stdout.trim();
    if (!tip || (await gitExec(["merge-base", "--is-ancestor", tip, "HEAD"], { cwd: worktree })).code !== 0) return false;
    // No conflict markers in what the merge commit touched.
    const files = (await gitExec(["diff", "--name-only", "HEAD^1", "HEAD"], { cwd: worktree })).stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 200);
    if (files.length === 0) return true;
    const markers = await gitExec(["grep", "-nIE", "^(<{7}|>{7}) ", "HEAD", "--", ...files], { cwd: worktree });
    return markers.code === 1; // 1 = no match
  };
  const abortMerge = async (): Promise<void> => {
    if (!headBefore) return;
    if (await hasMergeInProgress(worktree)) await gitExec(["merge", "--abort"], { cwd: worktree });
    await gitExec(["reset", "--hard", headBefore], { cwd: worktree });
  };
  return { tryMerge, isResolved, abortMerge };
}

/**
 * Assemble `members` onto a fresh train ref, resolving member-vs-member conflicts with the shepherd
 * instead of deferring them. With no sibling collision (or one member) it IS `assembleMergeTrain`.
 */
export async function assembleMergeTrainWithShepherd(
  args: { repoPath: string; baseBranch: string; members: ShepherdAssemblyMember[]; label: string },
  deps: { database: Database; shepherd: TrainShepherd; caps: MergeTrainAgentFixCaps; placement?: { projectId: string; repoPath: string }; log?: (line: string) => void } & IncrementalAssemblyPorts,
): Promise<TrainAssemblyResult & { conflictClusters: ConflictCluster[] }> {
  const { repoPath, baseBranch, members, label } = args;
  const log = deps.log ?? ((line: string) => console.warn(`[merge-train] ${line}`));
  if (members.length < 2) return assembleMergeTrain(args);
  const graph = await computeConflictGraph(repoPath, members);
  const { kept, excluded } = pickConflictFreeSet(members, graph);
  if (excluded.length === 0) return assembleMergeTrain(args);

  const trainRef = trainRefName(label);
  const baseSha = await resetTrainRef(repoPath, trainRef, baseBranch);
  const clusters = conflictClusters(members.map((m) => m.workspaceId), graph).map((workspaceIds) => ({ workspaceIds }));
  // Conflict-free members first (least overlap), the colliding ones last: the shepherd resolves them against a full tree.
  const ordered = [...orderByLeastOverlap(kept, graph), ...excluded.map((e) => e.member)] as ShepherdAssemblyMember[];
  const rivals = new Map<string, AgentFixMember>(excluded.map((e) => [e.member.workspaceId, e.conflictsWith as AgentFixMember]));
  const enriched = await enrichMembersWithTickets(ordered, deps.database);

  const create = deps.createWorktree ?? (async (repo: string, ref: string) => gitService.createWorktree(repo, ref, undefined, {
    pathNamespace: "train", ...(await resolveWorktreeClaims(deps.database, { label: "merge-train-assembly" })),
  }));
  const worktree = await create(repoPath, trainRef);
  const dropped: DroppedTrainMember[] = [];
  let included: TrainMember[] = [];
  try {
    const ports = createWorktreeMergePorts({ repoPath, worktree, baseSha, rivals });
    const res = await mergeMembersWithShepherd({
      label, baseBranch, worktree, members: enriched, shepherd: deps.shepherd, caps: deps.caps, placement: deps.placement, log, ...ports,
    });
    const byId = new Map(members.map((m) => [m.workspaceId, m]));
    const original = (m: ShepherdMember): TrainMember => byId.get(m.workspaceId) ?? { workspaceId: m.workspaceId, branch: m.branch, issueNumber: m.issueNumber };
    included = res.included.map(original);
    for (const d of res.dropped) dropped.push({ member: original(d.member), reason: d.reason, ...(d.deferred ? { deferred: true as const } : {}) });
  } catch (err) {
    log(`${label}: incremental assembly failed: ${errorMessage(err).slice(0, 300)}`);
    throw err;
  } finally {
    // The branch stays: it IS the train ref the gate opens next.
    const remove = deps.removeWorktree ?? (async (repo: string, path: string) => {
      await removeTrainWorktree({ database: deps.database, repoPath: repo, worktreePath: path, branch: "", label: "merge-train-assembly" });
    });
    await remove(repoPath, worktree).catch(() => undefined);
  }
  const trainSha = included.length > 0 ? (await gitExecOrThrow(["rev-parse", trainRef], { cwd: repoPath })).trim() : null;
  return { trainRef, included, dropped, trainSha, baseSha, conflictClusters: clusters };
}
