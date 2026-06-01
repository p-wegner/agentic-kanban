import { isTerminalStatusView } from "@agentic-kanban/shared";
import { issues, preferences, projectStatuses, workspaces, workflowNodes } from "@agentic-kanban/shared/schema";
import { and, eq, inArray, ne, or } from "drizzle-orm";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "../services/board-events.js";
import { createMergeQueueService } from "../services/merge-queue.service.js";
import type { SessionManager } from "../services/session.manager.js";
import { resolveMergeStrategy } from "./merge-strategy.js";

const DEFAULT_INTERVAL_MS = 30_000;
const MERGEABLE_STATUS_NAMES = ["In Review", "AI Reviewed"] as const;

export interface AutoMergeOrchestratorState {
  running: boolean;
  timer: ReturnType<typeof setInterval> | null;
  lastRunAt: string | null;
  lastMerged: number;
  lastFailed: number;
  lastSkipped: number;
}

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
  };

  const queueService = createMergeQueueService({
    database,
    boardEvents,
    getSessionManager,
  });

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

    const statusNames = autoMergeInReview
      ? MERGEABLE_STATUS_NAMES
      : (["AI Reviewed"] as const);

    const rows = await database
      .select({
        workspaceId: workspaces.id,
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
      .filter((row) => !isTerminalStatusView({
        currentNodeId: row.issueCurrentNodeId,
        currentNodeType: row.issueCurrentNodeType,
        statusName: row.issueStatusName,
      }))
      .filter((row) => row.readyForMerge || row.issueStatusName === "AI Reviewed" || autoMergeInReview)
      .map((row) => row.workspaceId);
  }

  async function runOnce(force = false): Promise<AutoMergeOrchestratorState> {
    if (state.running) return state;
    if (!force && !(await isEnabled())) return state;

    state.running = true;
    state.lastRunAt = new Date().toISOString();
    state.lastMerged = 0;
    state.lastFailed = 0;
    state.lastSkipped = 0;

    try {
      const workspaceIds = await findCompletedWorkspaceIds();
      if (workspaceIds.length === 0) return state;

      const plan = await queueService.computePlan(workspaceIds);
      if (plan.migrationCollisions.length > 0) {
        const summary = plan.migrationCollisions
          .map((entry) => `${entry.migrationNumber}: ${entry.workspaces.map((w) => `#${w.issueNumber ?? "?"}`).join(", ")}`)
          .join("; ");
        console.log(`[auto-merge] migration collision candidates detected; queue will merge sequentially and renumber as needed (${summary})`);
      }

      for await (const event of queueService.executeQueue(workspaceIds, { skipOnConflict: true })) {
        if (event.type === "merged") {
          state.lastMerged++;
          console.log(`[auto-merge] merged workspace ${event.workspaceId} (#${event.issueNumber ?? "?"})`);
        } else if (event.type === "conflict" || event.type === "error") {
          state.lastFailed++;
          console.warn(`[auto-merge] ${event.type} for workspace ${event.workspaceId}: ${event.error}`);
        } else if (event.type === "skipped") {
          state.lastSkipped++;
          console.log(`[auto-merge] skipped workspace ${event.workspaceId}: ${event.reason}`);
        }
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
  const orchestrator = createAutoMergeOrchestrator(deps);
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;

  const tick = () => {
    orchestrator.runOnce().catch((err) => {
      console.warn("[auto-merge] unhandled orchestrator error:", err instanceof Error ? err.message : err);
    });
  };

  orchestrator.state.timer = setInterval(tick, intervalMs);
  setTimeout(tick, Math.min(20_000, intervalMs));
  return orchestrator.state;
}
