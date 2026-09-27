/**
 * The BRANCH-scoped half of the same-failure circuit breaker (#1207 follow-up).
 *
 * MEASURED motivation: overnight 2026-09-26/27 the stable board logged
 * `auto-merge paused for this project: 3 consecutive gate runs failed with the same signature
 * (gate failed for this branch alone (bisected out of the train): failing suite(s): …)`. All three
 * failures were ONE branch (#1253) re-gated each cycle, and the project-wide pause froze every
 * other ready branch (#1261, #1262, both green) until master happened to move. A failure the
 * bisect already attributed to one branch is that branch's problem, not the project's.
 *
 * So when the repeating failures are attributable to ONE workspace, that workspace gets a merge
 * hold (the operator's #1164 `workspace_merge_hold` row, so the existing UI panel, the monitor
 * walk and the orchestrator's candidate filter all honour it without a new mechanism) and the
 * rest of the project keeps auto-merging. The hold is released automatically when the branch head
 * moves — the author pushed something, so the next gate is a different experiment — and by hand
 * through `DELETE /api/workspaces/:id/merge-hold` or `POST /api/projects/:id/auto-merge/resume`.
 *
 * The branch sha the hold was placed at lives in a `runtime_state` row beside the hold (the hold
 * table has no sha column, and this change adds no migration). The hold's `reason` starts with
 * {@link BRANCH_HOLD_REASON_MARKER}: an operator who re-places or edits the hold overwrites the
 * reason, and from then on the hold is theirs — the sweep drops its own bookkeeping row and never
 * releases an operator's hold.
 */
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { revParse } from "@agentic-kanban/shared/lib/git-service";
import type { Database } from "../db/index.js";
import { clearMergeHold, getMergeHold, setMergeHold } from "../repositories/merge-hold.repository.js";
import { getProjectRepoFields } from "../repositories/project.repository.js";
import {
  deleteRuntimeState,
  getRuntimeStateByPrefix,
  setRuntimeState,
} from "../repositories/runtime-state.repository.js";
import { getWorkspaceById } from "../repositories/workspace-reads.repository.js";

export const AUTO_MERGE_BRANCH_HOLD_PREFIX = "auto_merge_branch_hold_";
/** Every hold this module places has a reason starting with this; anything else is an operator's. */
export const BRANCH_HOLD_REASON_MARKER = "auto-merge breaker:";

export interface AutoMergeBranchHold {
  workspaceId: string;
  projectId: string;
  branch: string | null;
  /** The branch head the failures were measured on; the hold releases when the head moves off it. */
  branchSha: string | null;
  signature: string;
  count: number;
  /** ISO. */
  heldAt: string;
}

export function autoMergeBranchHoldKey(workspaceId: string): string {
  return `${AUTO_MERGE_BRANCH_HOLD_PREFIX}${workspaceId}`;
}

export function parseBranchHold(raw: string | null | undefined): AutoMergeBranchHold | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (typeof p?.workspaceId !== "string" || typeof p?.projectId !== "string" || typeof p?.signature !== "string") return null;
    return {
      workspaceId: p.workspaceId,
      projectId: p.projectId,
      branch: typeof p.branch === "string" ? p.branch : null,
      branchSha: typeof p.branchSha === "string" ? p.branchSha : null,
      signature: p.signature,
      count: typeof p.count === "number" ? p.count : 0,
      heldAt: typeof p.heldAt === "string" ? p.heldAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export function formatBranchHoldReason(hold: Pick<AutoMergeBranchHold, "count" | "signature" | "branchSha">): string {
  const at = hold.branchSha ? ` (held at ${hold.branchSha.slice(0, 8)})` : " (branch head unreadable at hold time — release by hand)";
  return `${BRANCH_HOLD_REASON_MARKER} ${hold.count} consecutive gate runs failed for this branch alone with the same signature ` +
    `(${hold.signature}) — released automatically when the branch head moves${at}`;
}

export type BranchHoldReleaseDecision =
  | { action: "keep" }
  | { action: "release"; reason: string; clearMergeHold: boolean };

/**
 * Should a breaker-placed branch hold end (pure)?
 *
 *  - the merge-hold row is gone, or its reason is no longer ours — an operator released or took
 *    over the hold: drop our bookkeeping only, never touch their row;
 *  - the workspace is gone or closed — nothing left to hold;
 *  - the branch head MOVED off the sha the failures were measured on.
 *
 * An UNKNOWN current head never releases: a git read that failed is not evidence the author
 * pushed anything, and releasing on it would restart the retry loop this hold exists to stop.
 */
export function decideBranchHoldRelease(
  hold: Pick<AutoMergeBranchHold, "branchSha">,
  current: { mergeHoldReason: string | null | undefined; workspaceOpen: boolean; branchSha: string | null },
): BranchHoldReleaseDecision {
  if (current.mergeHoldReason === undefined) {
    return { action: "release", reason: "the merge hold was released by hand", clearMergeHold: false };
  }
  if (!current.mergeHoldReason?.startsWith(BRANCH_HOLD_REASON_MARKER)) {
    return { action: "release", reason: "an operator took over the merge hold", clearMergeHold: false };
  }
  if (!current.workspaceOpen) {
    return { action: "release", reason: "the workspace is closed or gone", clearMergeHold: true };
  }
  if (hold.branchSha && current.branchSha && current.branchSha !== hold.branchSha) {
    return { action: "release", reason: `branch head moved ${hold.branchSha.slice(0, 8)} -> ${current.branchSha.slice(0, 8)}`, clearMergeHold: true };
  }
  return { action: "keep" };
}

async function branchHeadSha(projectId: string, branch: string | null, database: Database): Promise<string | null> {
  if (!branch) return null;
  const repo = await getProjectRepoFields(projectId, database).catch(() => undefined);
  if (!repo?.repoPath) return null;
  return await revParse(repo.repoPath, branch).then((sha) => sha.trim() || null).catch(() => null);
}

/**
 * Hold ONE workspace out of auto-merge because its own gate kept failing the same way. Writes the
 * merge-hold row (what every merge path already skips) and the sha bookkeeping row. Throws on a
 * write failure so the caller can fall back rather than believe the branch is held.
 */
export async function placeAutoMergeBranchHold(args: {
  projectId: string;
  workspaceId: string;
  signature: string;
  count: number;
  database: Database;
  now?: string;
}): Promise<AutoMergeBranchHold> {
  const { projectId, workspaceId, signature, count, database } = args;
  const heldAt = args.now ?? new Date().toISOString();
  const workspace = await getWorkspaceById(workspaceId, database).catch(() => null);
  const branch = workspace?.branch ?? null;
  const hold: AutoMergeBranchHold = {
    workspaceId,
    projectId,
    branch,
    branchSha: await branchHeadSha(projectId, branch, database),
    signature,
    count,
    heldAt,
  };
  await setRuntimeState(autoMergeBranchHoldKey(workspaceId), JSON.stringify(hold), database);
  await setMergeHold(workspaceId, { reason: formatBranchHoldReason(hold), heldAt }, database);
  return hold;
}

/** Every breaker-placed branch hold, optionally for one project. Never throws. */
export async function listAutoMergeBranchHolds(database: Database, projectId?: string): Promise<AutoMergeBranchHold[]> {
  const rows = await getRuntimeStateByPrefix(AUTO_MERGE_BRANCH_HOLD_PREFIX, database).catch(() => []);
  return rows
    .map((row) => parseBranchHold(row.value))
    .filter((hold): hold is AutoMergeBranchHold => hold !== null && (projectId === undefined || hold.projectId === projectId));
}

/**
 * Re-judge every breaker-placed branch hold and release the ones whose world has changed (see
 * {@link decideBranchHoldRelease}). Called once per orchestrator tick, BEFORE the candidate query
 * reads the hold set, so a branch whose author pushed is back in the same tick. Returns the
 * released workspace ids. Never throws: a hold that cannot be re-judged stays as it is.
 */
export async function releaseMovedAutoMergeBranchHolds(
  database: Database,
  /** Receives each release line WITHOUT the `[auto-merge]` tag; the default adds it. */
  log: (line: string) => void = (line) => console.log(`[auto-merge] ${line}`),
): Promise<string[]> {
  const released: string[] = [];
  for (const hold of await listAutoMergeBranchHolds(database)) {
    try {
      const mergeHold = await getMergeHold(hold.workspaceId, database);
      const workspace = await getWorkspaceById(hold.workspaceId, database);
      const workspaceOpen = Boolean(workspace && workspace.status !== "closed");
      const decision = decideBranchHoldRelease(hold, {
        mergeHoldReason: mergeHold ? (mergeHold.reason ?? null) : undefined,
        workspaceOpen,
        branchSha: workspaceOpen && mergeHold?.reason?.startsWith(BRANCH_HOLD_REASON_MARKER)
          ? await branchHeadSha(hold.projectId, workspace?.branch ?? hold.branch, database)
          : null,
      });
      if (decision.action === "keep") continue;
      if (decision.clearMergeHold) await clearMergeHold(hold.workspaceId, database);
      await deleteRuntimeState(autoMergeBranchHoldKey(hold.workspaceId), database);
      released.push(hold.workspaceId);
      log(`released the branch hold on workspace ${hold.workspaceId} (project ${hold.projectId}): ${decision.reason}`);
    } catch (err) {
      console.warn(`[auto-merge] branch hold re-check failed for workspace ${hold.workspaceId} (non-fatal, hold kept): ${errorMessage(err)}`);
    }
  }
  return released;
}

/**
 * The operator's resume door (`POST /api/projects/:id/auto-merge/resume`): drop every hold this
 * module placed in the project. An operator-owned hold (reason no longer ours) is left alone.
 */
export async function clearAutoMergeBranchHoldsForProject(projectId: string, database: Database): Promise<string[]> {
  const cleared: string[] = [];
  for (const hold of await listAutoMergeBranchHolds(database, projectId)) {
    const mergeHold = await getMergeHold(hold.workspaceId, database).catch(() => undefined);
    if (mergeHold?.reason?.startsWith(BRANCH_HOLD_REASON_MARKER)) await clearMergeHold(hold.workspaceId, database);
    await deleteRuntimeState(autoMergeBranchHoldKey(hold.workspaceId), database);
    cleared.push(hold.workspaceId);
  }
  return cleared;
}
