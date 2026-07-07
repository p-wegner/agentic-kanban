import type { createBoardEvents } from "../services/board-events.js";
import type { createSessionManager } from "../services/session.manager.js";
import type { Database } from "../db/index.js";
import { createWorkspaceService } from "../services/workspace.service.js";
import { RUN_GATE, type MergeGateToken } from "../services/pre-merge-gate.service.js";

/**
 * The subset of workspace application-service operations the in-process board
 * monitor drives (relaunch / merge / fix-and-merge / delete). Defining it as an
 * explicit PORT — injected by the composition root (createMonitorSetup) — is what
 * lets the monitor invoke the workspace service DIRECTLY instead of round-tripping
 * through its own HTTP API (`fetch http://127.0.0.1:<port>/api/...`), the #1
 * documented anti-pattern in packages/server/CLAUDE.md.
 *
 * Self-HTTP from an in-process caller: created a hard runtime dependency on the
 * server's own port (a transient bind drop made a monitor merge/relaunch silently
 * no-op — a real, recurring failure mode), bypassed the TypeScript contract via a
 * JSON round-trip, swallowed errors through re-parsing, and made the monitor
 * impossible to unit-test without a live HTTP server. With the port injected, the
 * monitor cycle is exercised by passing a fake.
 *
 * Each method REJECTS on failure (mirroring the previous non-2xx HTTP response),
 * so callers use try/catch exactly where they used to check `res.ok` — and a
 * rejected promise also covers the old `fetch().catch(() => null)` network-failure
 * branch, since an in-process call has no network to fail.
 */
export interface MonitorWorkspaceActions {
  /** Relaunch the agent for an idle workspace. (POST /api/workspaces/:id/launch) */
  launch(workspaceId: string): Promise<void>;
  /**
   * Merge + close, deduped and repo-locked. (POST /api/workspaces/:id/merge)
   *
   * #943 / arch-review §1.2: the caller passes an explicit merge-gate DECISION token. The monitor
   * hands over `already-passed` PROOF (it ran the gate this cycle for un-ready In-Review work, or
   * the work was gated at review-exit → readyForMerge), so `doMerge` does NOT double an expensive
   * verify/smoke build — but STALE/absent proof re-runs the gate inside `resolveMergeGate`. When
   * omitted the merge defaults to `run-gate` (fully gated), so no caller can accidentally skip.
   */
  merge(workspaceId: string, gate?: MergeGateToken): Promise<void>;
  /**
   * Launch a fix-and-merge session after a failed merge, registering the new
   * session id in `fixAndMergeSessionIds` so the exit workflow classifies it as a
   * fix-and-merge (not a builder) session — exactly what the HTTP route handler
   * did. (POST /api/workspaces/:id/fix-and-merge)
   */
  fixAndMerge(workspaceId: string, mergeError: string): Promise<void>;
  /** Delete a (ghost) workspace and cascade. (DELETE /api/workspaces/:id) */
  delete(workspaceId: string): Promise<void>;
}

export function createMonitorWorkspaceActions(deps: {
  database: Database;
  getSessionManager: () => ReturnType<typeof createSessionManager>;
  boardEvents: ReturnType<typeof createBoardEvents>;
  /**
   * The workflow-engine set marking a session as a fix-and-merge session (read by
   * isBuilderSession()/rate-limit-exit so a fix session is not treated as a
   * builder). The HTTP fix-and-merge route populated this; the direct call MUST
   * preserve it, or monitor-triggered fix sessions would be misclassified on exit.
   */
  fixAndMergeSessionIds: Set<string>;
}): MonitorWorkspaceActions {
  // The repo-level merge lock (workspace-internals.activeMerges) is a module-level
  // singleton shared by every service instance, so this monitor-owned instance
  // still serializes merges against the route's instance for the same repo.
  const workspaceService = createWorkspaceService({
    database: deps.database,
    getSessionManager: deps.getSessionManager,
    boardEvents: deps.boardEvents,
  });
  return {
    async launch(workspaceId) {
      await workspaceService.launchSession(workspaceId);
    },
    async merge(workspaceId, gate) {
      // #943 / arch-review §1.2: the monitor cycle already ran the verify/smoke gate this cycle
      // (for un-ready In-Review work) or the work was gated at review-exit (readyForMerge), so it
      // passes an `already-passed` PROOF token that `resolveMergeGate` honors (avoiding a doubled
      // build/boot) — while stale/absent proof re-runs the gate. If a caller omits the token we
      // default to fully gating, so "no gate" can never be an accident.
      await workspaceService.mergeWorkspaceDeduped(workspaceId, { gate: gate ?? RUN_GATE });
    },
    async fixAndMerge(workspaceId, mergeError) {
      const result = await workspaceService.fixAndMerge(workspaceId, mergeError);
      deps.fixAndMergeSessionIds.add(result.sessionId);
    },
    async delete(workspaceId) {
      await workspaceService.deleteWorkspace(workspaceId);
    },
  };
}
