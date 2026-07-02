import { and, eq } from "drizzle-orm";
import { workspaces } from "@agentic-kanban/shared/schema";
import type { Database, TransactionClient } from "../db/index.js";

type WorkspaceRow = typeof workspaces.$inferSelect;

/** The stringly workspace lifecycle statuses observed across the codebase. */
export type WorkspaceStatus =
  | "active"
  | "idle"
  | "blocked"
  | "reviewing"
  | "fixing"
  | "closed"
  | "ready_for_merge"
  | "awaiting-plan-approval";

export interface SetWorkspaceStatusOpts {
  /** Timestamp for updatedAt (defaults to now). */
  now?: string;
  /**
   * Extra columns to write atomically with the status
   * (e.g. `workingDir: null` on close, `readyForMerge: false` on reset).
   */
  set?: Partial<Omit<WorkspaceRow, "id" | "status" | "updatedAt">>;
  /**
   * Only apply the write when the workspace is currently in this status
   * (compare-and-set; e.g. auto-merge-orchestrator resets fixing → idle only
   * while the workspace is still "fixing").
   */
  onlyIfCurrentStatus?: WorkspaceStatus;
  /**
   * Override the terminal invariant (closed+mergedAt may not be revived).
   * Requires a documented reason, which is logged.
   */
  force?: { reason: string };
}

/**
 * #953 — the SINGLE workspace-status transition authority.
 *
 * Enforces the terminal invariant that readers used to re-derive defensively
 * (exit-workflow's already-merged guard, keepResolverWorkspaceRetryableIfUnlanded):
 * a workspace with status "closed" AND mergedAt set is FINAL. Reviving it (any
 * status other than "closed") logs a warning and no-ops unless `opts.force` is
 * passed with a documented reason. This closes the historical reaper/reviver bug
 * class where reconcilers reset merged workspaces to idle and re-stranded issues.
 *
 * Never throws: failures are logged (replacing the blind `.catch(() => {})`
 * writes) and reported via the boolean return.
 *
 * @returns true if the status was written; false if blocked by the terminal
 *          guard, skipped by `onlyIfCurrentStatus`, or the write failed.
 *
 * Raw `update(workspaces).set({ status })` writers outside this module are gated
 * by `packages/server/src/__tests__/status-write-ratchet.test.ts`.
 */
export async function setWorkspaceStatus(
  database: Database | TransactionClient,
  workspaceId: string,
  status: WorkspaceStatus,
  opts: SetWorkspaceStatusOpts = {},
): Promise<boolean> {
  const now = opts.now ?? new Date().toISOString();
  try {
    if (status !== "closed") {
      const rows = await database
        .select({ status: workspaces.status, mergedAt: workspaces.mergedAt })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      const current = rows[0];
      if (current && current.status === "closed" && current.mergedAt) {
        if (opts.force) {
          console.warn(
            `[workspace-status] FORCED revive of merged terminal workspace ${workspaceId} (closed, mergedAt=${current.mergedAt}) -> "${status}" — reason: ${opts.force.reason}`,
          );
        } else {
          console.warn(
            `[workspace-status] blocked revive of merged terminal workspace ${workspaceId} (closed, mergedAt=${current.mergedAt}) -> "${status}" — no-op (#953 terminal invariant; pass force with a reason to override)`,
          );
          return false;
        }
      }
    }
    const where = opts.onlyIfCurrentStatus
      ? and(eq(workspaces.id, workspaceId), eq(workspaces.status, opts.onlyIfCurrentStatus))
      : eq(workspaces.id, workspaceId);
    await database
      .update(workspaces)
      .set({ status, updatedAt: now, ...(opts.set ?? {}) })
      .where(where);
    return true;
  } catch (err) {
    console.warn(
      `[workspace-status] failed to set workspace ${workspaceId} -> "${status}":`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}
