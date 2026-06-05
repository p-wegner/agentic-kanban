import { isTerminalStatusView } from "@agentic-kanban/shared";
import { issues, preferences, projectStatuses, workspaces, workflowNodes, sessions, sessionMessages } from "@agentic-kanban/shared/schema";
import { and, count, eq, inArray, ne, or } from "drizzle-orm";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "../services/board-events.js";
import { createMergeQueueService } from "../services/merge-queue.service.js";
import { createWorkspaceMergeService } from "../services/workspace-merge.service.js";
import { buildStrandedBatch, pickIntegrationWorkspace } from "../services/reconciler.service.js";
import type { SessionManager } from "../services/session.manager.js";
import { resolveMergeStrategy } from "./merge-strategy.js";
import { reconcileCompletionStates } from "./completion-state-reconciler.js";

const DEFAULT_INTERVAL_MS = 30_000;
const MERGEABLE_STATUS_NAMES = ["In Review", "AI Reviewed"] as const;
/** Cap on how many times the orchestrator launches a batch reconciler for the SAME stranded set before leaving it for a human. */
const MAX_RECONCILER_ATTEMPTS = 2;
/** A reconciler session with 0 output messages after this many ms is treated as a zombie and reaped. */
const ZOMBIE_TIMEOUT_MS = 5 * 60_000;

export interface AutoMergeOrchestratorState {
  running: boolean;
  timer: ReturnType<typeof setInterval> | null;
  lastRunAt: string | null;
  lastMerged: number;
  lastFailed: number;
  lastSkipped: number;
  /** In-flight batch reconciler launched for the conflict residue, or null. */
  reconciler: { sessionId: string; integrationWorkspaceId: string; baseBranch: string; strandedKey: string; launchedAt: string } | null;
  /** Per-stranded-set attempt counter (key = sorted workspace ids) backing the reconciler cap. */
  reconcilerAttempts: Map<string, number>;
}

let activeAutoMergeInterval: ReturnType<typeof setInterval> | null = null;
let activeAutoMergeTimeout: ReturnType<typeof setTimeout> | null = null;

export function createAutoMergeOrchestrator(deps: {
  database: Database;
  boardEvents?: BoardEvents;
  getSessionManager?: () => SessionManager;
}) {
  const { database, boardEvents, getSessionManager } = deps;
  const state: AutoMergeOrchestratorState = {
    running: false,
    timer: null,
    lastRunAt: null,
    lastMerged: 0,
    lastFailed: 0,
    lastSkipped: 0,
    reconciler: null,
    reconcilerAttempts: new Map(),
  };

  const queueService = createMergeQueueService({
    database,
    boardEvents,
    getSessionManager,
  });
  const mergeService = createWorkspaceMergeService({ database, boardEvents, getSessionManager });

  async function isEnabled() {
    const prefRows = await database
      .select({ key: preferences.key, value: preferences.value })
      .from(preferences)
      .where(inArray(preferences.key, ["auto_merge", "auto_monitor", "merge_strategy"]));
    const prefMap = new Map(prefRows.map((row) => [row.key, row.value]));
    return prefMap.get("auto_merge") !== "false" && resolveMergeStrategy(prefMap) === "merge_queue";
  }

  async function findCompletedWorkspaceIds(): Promise<string[]> {
    const prefRows = await database.select().from(preferences);
    const prefMap = new Map(prefRows.map((row) => [row.key, row.value]));
    const autoMergeInReview = prefMap.get("auto_merge_in_review") === "true";

    // Per-project opt-out: an `auto_merge_disabled_<projectId>` pref set to "true" keeps
    // the orchestrator from auto-merging THAT project's workspaces, while other projects
    // still auto-merge. Used for the agentic-kanban dev board itself — its tickets merge
    // deliberately (Conductor / human), not via the in-process queue that's meant for
    // other projects developed with the board.
    const autoMergeDisabledProjectIds = new Set(
      [...prefMap]
        .filter(([key, value]) => /^auto_merge_disabled_[0-9a-f-]+$/.test(key) && value === "true")
        .map(([key]) => key.replace("auto_merge_disabled_", "")),
    );

    const statusNames = autoMergeInReview
      ? MERGEABLE_STATUS_NAMES
      : (["AI Reviewed"] as const);

    const rows = await database
      .select({
        workspaceId: workspaces.id,
        projectId: issues.projectId,
        issueStatusName: projectStatuses.name,
        issueCurrentNodeId: issues.currentNodeId,
        issueCurrentNodeType: workflowNodes.nodeType,
        readyForMerge: workspaces.readyForMerge,
      })
      .from(workspaces)
      .innerJoin(issues, eq(workspaces.issueId, issues.id))
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
      .where(and(
        ne(workspaces.status, "closed"),
        eq(workspaces.isDirect, false),
        eq(workspaces.status, "idle"),
        or(
          eq(workspaces.readyForMerge, true),
          inArray(projectStatuses.name, [...statusNames]),
        ),
      ));

    return rows
      // Per-project opt-out (e.g. the dev board merges deliberately, not via this queue).
      .filter((row) => !autoMergeDisabledProjectIds.has(row.projectId))
      // Terminal-status (Done/Cancelled) workspaces are normally excluded — a user may
      // deliberately park an issue in Done without merging. BUT a workspace that is still
      // OPEN (the query excludes status='closed') with readyForMerge=true is a different
      // animal: readyForMerge is set by the REVIEW flow, not a user park, so if its issue
      // was moved to Done after review but before this tick merged it, the branch is
      // stranded and unmerged. Recover it instead of dropping it (the #534 silent merge
      // loss: issue looks Done, code never lands). Non-ready terminal workspaces (a real
      // user park) are still excluded.
      .filter((row) => row.readyForMerge || !isTerminalStatusView({
        currentNodeId: row.issueCurrentNodeId,
        currentNodeType: row.issueCurrentNodeType,
        statusName: row.issueStatusName,
      }))
      .filter((row) => row.readyForMerge || row.issueStatusName === "AI Reviewed" || autoMergeInReview)
      .map((row) => row.workspaceId);
  }

  /**
   * Escalate a conflict residue to ONE batch merge-reconciler agent. Re-checks the set is still
   * open, enforces the per-set attempt cap, picks the least-overlap integration worktree, builds
   * the injected batch payload from the plan, and launches via mergeService.reconcileBatch. The
   * launched session is tracked in state.reconciler and polled on subsequent ticks.
   */
  async function launchReconciler(strandedIds: string[], plan: Awaited<ReturnType<typeof queueService.computePlan>>): Promise<void> {
    const openRows = await database
      .select({ id: workspaces.id, status: workspaces.status, issueId: workspaces.issueId })
      .from(workspaces)
      .where(inArray(workspaces.id, strandedIds));
    const open = openRows.filter((r) => r.status !== "closed").map((r) => r.id);
    if (open.length < 2) return;

    const key = [...open].sort().join(",");
    const attempts = state.reconcilerAttempts.get(key) ?? 0;
    if (attempts >= MAX_RECONCILER_ATTEMPTS) {
      console.log(`[auto-merge] reconciler attempt cap (${MAX_RECONCILER_ATTEMPTS}) reached for batch [${key}] — leaving for human`);
      return;
    }

    const integration = pickIntegrationWorkspace(open, plan);
    if (!integration) {
      console.log("[auto-merge] stranded batch has no integration worktree (all direct/no workingDir) — skipping reconciler");
      return;
    }

    const [issueRow] = await database.select({ projectId: issues.projectId }).from(issues)
      .where(eq(issues.id, integration.issueId)).limit(1);
    const projectId = issueRow?.projectId ?? "";
    const batch = buildStrandedBatch(open, plan, { baseBranch: integration.baseBranch, projectId });
    const serverPort = process.env.KANBAN_SERVER_PORT || process.env.SERVER_PORT || process.env.PORT || "3001";

    try {
      const { sessionId } = await mergeService.reconcileBatch(integration.id, {
        strandedBatchJson: JSON.stringify(batch),
        serverPort,
      });
      state.reconcilerAttempts.set(key, attempts + 1);
      state.reconciler = {
        sessionId,
        integrationWorkspaceId: integration.id,
        baseBranch: integration.baseBranch,
        strandedKey: key,
        launchedAt: new Date().toISOString(),
      };
      console.log(`[auto-merge] launched batch reconciler session=${sessionId} integration=${integration.id} over ${open.length} stranded workspaces`);
    } catch (err) {
      console.warn(`[auto-merge] reconciler launch failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function runOnce(force = false): Promise<AutoMergeOrchestratorState> {
    if (state.running) return state;

    // A batch reconciler launched on a prior tick may still be resolving. While its session runs,
    // skip this tick entirely (don't double-launch or re-queue its members); on exit, clear the
    // marker, free the integration workspace, and fall through to re-scan what landed.
    if (state.reconciler) {
      const [sess] = await database.select({ status: sessions.status, startedAt: sessions.startedAt }).from(sessions)
        .where(eq(sessions.id, state.reconciler.sessionId)).limit(1);
      if (sess && sess.status === "running") {
        // Zombie detection: a session that has been running for > ZOMBIE_TIMEOUT_MS with 0 output
        // messages is almost certainly a launch-failed session (0-token, never received input).
        // Reap it so the next tick can relaunch.
        const ageMs = sess.startedAt ? Date.now() - new Date(sess.startedAt).getTime() : 0;
        if (ageMs >= ZOMBIE_TIMEOUT_MS) {
          const [{ msgCount }] = await database
            .select({ msgCount: count() })
            .from(sessionMessages)
            .where(eq(sessionMessages.sessionId, state.reconciler.sessionId));
          if (msgCount === 0) {
            console.warn(`[auto-merge] reconciler session ${state.reconciler.sessionId} is a zombie (0 output after ${Math.round(ageMs / 60000)}m) — reaping`);
            // Fall through to the cleanup below (don't return early).
          } else {
            return state; // session is live, wait longer
          }
        } else {
          return state;
        }
      }
      console.log(`[auto-merge] reconciler session ${state.reconciler.sessionId} finished (status=${sess?.status ?? "gone"})`);
      try {
        await database.update(workspaces).set({ status: "idle", updatedAt: new Date().toISOString() })
          .where(and(eq(workspaces.id, state.reconciler.integrationWorkspaceId), eq(workspaces.status, "fixing")));
      } catch { /* best effort */ }
      state.reconciler = null;
    }

    if (!force && !(await isEnabled())) return state;

    state.running = true;
    state.lastRunAt = new Date().toISOString();
    state.lastMerged = 0;
    state.lastFailed = 0;
    state.lastSkipped = 0;

    try {
      const reconciled = await reconcileCompletionStates(database);
      if (reconciled > 0) {
        console.log(`[auto-merge] reconcileCompletionStates: unblocked ${reconciled} stuck workspace(s)`);
      }

      const workspaceIds = await findCompletedWorkspaceIds();
      if (workspaceIds.length === 0) return state;

      const plan = await queueService.computePlan(workspaceIds);
      if (plan.migrationCollisions.length > 0) {
        const summary = plan.migrationCollisions
          .map((entry) => `${entry.migrationNumber}: ${entry.workspaces.map((w) => `#${w.issueNumber ?? "?"}`).join(", ")}`)
          .join("; ");
        console.log(`[auto-merge] migration collision candidates detected; queue will merge sequentially and renumber as needed (${summary})`);
      }

      const strandedIds: string[] = [];
      for await (const event of queueService.executeQueue(workspaceIds, { skipOnConflict: true })) {
        if (event.type === "merged") {
          state.lastMerged++;
          console.log(`[auto-merge] merged workspace ${event.workspaceId} (#${event.issueNumber ?? "?"})`);
        } else if (event.type === "conflict" || event.type === "error") {
          state.lastFailed++;
          console.warn(`[auto-merge] ${event.type} for workspace ${event.workspaceId}: ${event.error}`);
          if (event.type === "conflict") strandedIds.push(event.workspaceId);
        } else if (event.type === "skipped") {
          state.lastSkipped++;
          console.log(`[auto-merge] skipped workspace ${event.workspaceId}: ${event.reason}`);
          if (event.reason.startsWith("rebase conflict") || event.reason.startsWith("merge conflict")) {
            strandedIds.push(event.workspaceId);
          }
        }
      }

      // Conflict residue: escalate the WHOLE stranded batch to ONE merge-reconciler agent that
      // picks the efficient landing strategy across the set (clean-first, resolve each cluster's
      // union once, sequence migration collisions). A lone conflict is left to per-workspace
      // fix-and-merge; the reconciler's value is batch/cluster union resolution.
      if (strandedIds.length >= 2 && getSessionManager && !state.reconciler) {
        await launchReconciler(strandedIds, plan);
      }
    } catch (err) {
      state.lastFailed++;
      console.warn("[auto-merge] orchestrator cycle failed:", err instanceof Error ? err.message : err);
    } finally {
      state.running = false;
    }

    return state;
  }

  return {
    state,
    findCompletedWorkspaceIds,
    runOnce,
  };
}

export function startAutoMergeOrchestrator(deps: {
  database: Database;
  boardEvents?: BoardEvents;
  getSessionManager?: () => SessionManager;
  intervalMs?: number;
}): AutoMergeOrchestratorState {
  if (activeAutoMergeTimeout !== null) {
    clearTimeout(activeAutoMergeTimeout);
    activeAutoMergeTimeout = null;
  }
  if (activeAutoMergeInterval !== null) {
    clearInterval(activeAutoMergeInterval);
    activeAutoMergeInterval = null;
  }

  const orchestrator = createAutoMergeOrchestrator(deps);
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;

  const tick = () => {
    orchestrator.runOnce().catch((err) => {
      console.warn("[auto-merge] unhandled orchestrator error:", err instanceof Error ? err.message : err);
    });
  };

  activeAutoMergeTimeout = setTimeout(tick, Math.min(20_000, intervalMs));
  activeAutoMergeInterval = setInterval(tick, intervalMs);
  orchestrator.state.timer = activeAutoMergeInterval;
  return orchestrator.state;
}
