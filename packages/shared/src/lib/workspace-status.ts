import { and, eq, isNull, ne, or } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { workspaces } from "../schema/index.js";
import type * as schema from "../schema/index.js";
import {
  checkWorkspaceTransition,
  getTransitionStrictness,
  IllegalStatusTransitionError,
} from "./status-transitions.js";

/**
 * Both the server (`packages/server/src/db/index.ts`) and mcp-server
 * (`packages/mcp-server/src/db.ts`) open `drizzle({ client, schema })` against
 * the same `@agentic-kanban/shared/schema` — so their `Database`/transaction-client
 * types are structurally identical to this one, and either package's db handle
 * (or a `db.transaction(tx => ...)` callback client) satisfies it directly.
 */
type WorkspaceStatusDb = LibSQLDatabase<typeof schema> | Parameters<Parameters<LibSQLDatabase<typeof schema>["transaction"]>[0]>[0];

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
  | "awaiting-plan-approval"
  | "error";

/**
 * Workspace statuses that are TERMINAL — the row no longer owns live resources
 * (its teardown has run), so "still live?" filters must EXCLUDE it. This is the
 * SINGLE source of truth shared by every such filter (the service-stack reaper's
 * open-row query, the service-state repository, the deferred-launch lifecycle
 * recheck) so two liveness definitions can never silently drift apart (#57).
 *
 * "merged" is NOT a member of WorkspaceStatus today — a merged workspace is
 * `status: "closed"` with `mergedAt` set — so the entry is currently DEAD. It is
 * retained deliberately: the previous divergence (the reaper filtered on
 * `status != "closed"` while the repository filtered on `["closed","merged"]`)
 * agreed only by accident, and would have split the instant someone added a real
 * "merged" enum member — the reaper would then treat merged workspaces as live and
 * shield their stacks from reclamation forever. Routing every consumer through this
 * one constant means that if "merged" ever becomes real, they all treat it as
 * terminal in lockstep.
 */
export const TERMINAL_WORKSPACE_STATUSES = ["closed", "merged"] as const;

/** True if a workspace status is terminal (see {@link TERMINAL_WORKSPACE_STATUSES}). */
export function isTerminalWorkspaceStatus(status: string | null | undefined): boolean {
  return status != null && (TERMINAL_WORKSPACE_STATUSES as readonly string[]).includes(status);
}

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
  /**
   * Optional caller label included in transition-legality warnings
   * (arch-review §1.1) so an illegal transition is attributable to a code path.
   */
  caller?: string;
}

/**
 * #953 — the SINGLE workspace-status transition authority, shared by both the
 * HTTP server and the MCP server (#967 — draining the raw writers that used
 * to bypass it in each package separately required lifting it out of
 * `packages/server` so mcp-server can call the same guarded code path instead
 * of re-implementing it).
 *
 * Enforces the terminal invariant that readers used to re-derive defensively
 * (exit-workflow's already-merged guard, keepResolverWorkspaceRetryableIfUnlanded):
 * a workspace with status "closed" AND mergedAt set is FINAL. Reviving it (any
 * status other than "closed") logs a warning and no-ops unless `opts.force` is
 * passed with a documented reason. This closes the historical reaper/reviver bug
 * class where reconcilers reset merged workspaces to idle and re-stranded issues.
 *
 * #966 — the terminal invariant is ALSO enforced atomically at write time: the
 * UPDATE's WHERE clause excludes a closed+merged row (unless `force`), so a merge
 * that lands between the advisory pre-read and the write still wins. The pre-read
 * only exists for the detailed warning; it is not the enforcement.
 *
 * Never throws: failures are logged (replacing the blind `.catch(() => {})`
 * writes) and reported via the boolean return.
 *
 * @returns true if the status was written; false if blocked by the terminal
 *          guard (at pre-read OR write time), skipped by `onlyIfCurrentStatus`,
 *          the workspace row does not exist, or the write failed.
 *
 * Raw `update(workspaces).set({ status })` writers outside this module are gated
 * by `packages/server/src/__tests__/status-write-ratchet.test.ts`.
 */
export async function setWorkspaceStatus(
  database: WorkspaceStatusDb,
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
      // Transition-legality observability (arch-review §1.1). The pre-read gives
      // us the current status only on the non-close path; writes INTO "closed"
      // are always legal (any workspace may be closed) so no read is added there.
      // Default policy is WARN-AND-ALLOW: a "warn"-severity illegal transition is
      // logged but still applied; a "forbidden" terminal resurrection falls to the
      // existing terminal guard below (no-op / returns false). Under STRICT policy
      // any illegal transition throws (rethrown past the catch below).
      if (current?.status) {
        const check = checkWorkspaceTransition(current.status as WorkspaceStatus, status, {
          mergedAt: current.mergedAt,
          force: !!opts.force,
        });
        if (!check.legal && getTransitionStrictness() === "strict") {
          throw new IllegalStatusTransitionError(
            `[workspace-status] illegal transition of workspace ${workspaceId} (caller: ${opts.caller ?? "unknown"}): ${check.message}`,
          );
        }
        if (check.severity === "warn") {
          console.warn(
            `[workspace-status] illegal transition of workspace ${workspaceId} "${current.status}" -> "${status}" (caller: ${opts.caller ?? "unknown"}) — warn-and-allow (arch-review §1.1; set strictness=strict to enforce)`,
          );
        }
      }
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
    // #966 — write-time enforcement of the terminal invariant. The pre-read above
    // is advisory (detailed logging); a concurrent merge landing AFTER that read
    // must still win, so the UPDATE itself refuses to touch a closed+merged row.
    const terminalGuard =
      status !== "closed" && !opts.force
        ? or(ne(workspaces.status, "closed"), isNull(workspaces.mergedAt))
        : undefined;
    const casGuard = opts.onlyIfCurrentStatus
      ? eq(workspaces.status, opts.onlyIfCurrentStatus)
      : undefined;
    const result = await database
      .update(workspaces)
      .set({ status, updatedAt: now, ...(opts.set ?? {}) })
      .where(and(eq(workspaces.id, workspaceId), casGuard, terminalGuard));
    const affected = result.rowsAffected ?? (result as { changes?: number }).changes ?? 0;
    if (affected === 0) {
      // A CAS miss (`onlyIfCurrentStatus` moved on) is an expected skip — stay quiet,
      // matching the historical behavior. Anything else means the row vanished or a
      // terminal transition raced past the pre-read: surface it.
      if (!opts.onlyIfCurrentStatus) {
        console.warn(
          `[workspace-status] write of workspace ${workspaceId} -> "${status}" matched no row — concurrent terminal transition or missing workspace (#966 write-time guard); no-op`,
        );
      }
      return false;
    }
    return true;
  } catch (err) {
    // A STRICT-policy transition violation must propagate, not be swallowed into
    // a `false` return like an incidental DB failure.
    if (err instanceof IllegalStatusTransitionError) throw err;
    console.warn(
      `[workspace-status] failed to set workspace ${workspaceId} -> "${status}":`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}
