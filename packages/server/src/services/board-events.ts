import type { WSContext } from "hono/ws";

/**
 * All typed board event reasons.
 *
 * Payload shape (all events):
 *   { type: "board_changed", projectId: string, reason: BoardEventType }
 *
 * | Reason                    | Emitted by                                  |
 * |---------------------------|---------------------------------------------|
 * | board_changed             | monitor-cycle, monitor-auto-start,          |
 * |                           | workspace-merge (rebase/abort)              |
 * | issue_created             | issue.service (create / batch)              |
 * | issue_updated             | issue.service, exit-workflow, review.service|
 * | issue_deleted             | issue.service                               |
 * | dependency_added          | issue.service                               |
 * | dependency_removed        | issue.service                               |
 * | session_completed         | exit-workflow (session exit)                |
 * | session_launched          | workspace-session, workspace-merge          |
 * | session_stopped           | workspace-session (stopWorkspace)           |
 * | workspace_created         | workspace-crud (createWorkspace)            |
 * | workspace_setup           | workspace-crud (setupWorkspace)             |
 * | workspace_idle            | exit-workflow                               |
 * | workspace_merged          | exit-workflow, merge-workflow,              |
 * |                           | workspace-merge, followup-workspace         |
 * | workspace_ready_for_merge | workspace-crud (markReadyForMerge)          |
 * | workflow_error            | exit-workflow, merge-workflow               |
 * | workflow_fork             | workflow-fork.service                       |
 * | workflow_join             | workflow-fork.service                       |
 * | internal_notify           | routes/index internal endpoint              |
 */
export type BoardEventType =
  | "board_changed"
  | "issue_created"
  | "issue_updated"
  | "issue_deleted"
  | "dependency_added"
  | "dependency_removed"
  | "session_completed"
  | "session_launched"
  | "session_stopped"
  | "workspace_created"
  | "workspace_setup"
  | "workspace_idle"
  | "workspace_merged"
  | "workspace_ready_for_merge"
  | "workflow_error"
  | "workflow_fork"
  | "workflow_join"
  | "internal_notify";

interface BoardEventMessage {
  type: "board_changed";
  projectId: string;
  reason: BoardEventType;
}

export interface SessionActivityMessage {
  type: "session_activity";
  projectId: string;
  issueId: string;
  sessionId: string;
  activity: string;
}

export interface SessionStatsMessage {
  type: "session_stats";
  projectId: string;
  issueId: string;
  model: string;
  contextTokens: number;
  toolUses: number;
  subagentCount: number;
}

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}

export interface SessionTodosMessage {
  type: "session_todos";
  projectId: string;
  issueId: string;
  todos: TodoItem[];
}

export interface ApprovalRequestMessage {
  type: "approval_requested";
  projectId: string;
  id: string;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  workspaceId?: string;
}

type BoardWsMessage = BoardEventMessage | SessionActivityMessage | SessionStatsMessage | SessionTodosMessage | ApprovalRequestMessage;

interface BoardEventSubscriber {
  ws: WSContext;
}

function createBoardEvents() {
  const subscribers = new Map<string, Map<WSContext, BoardEventSubscriber>>();
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  function subscribe(projectId: string, ws: WSContext) {
    if (!subscribers.has(projectId)) {
      subscribers.set(projectId, new Map());
    }
    subscribers.get(projectId)!.set(ws, { ws });
    console.log(`[board-events] WS subscribed: projectId=${projectId} subscribers=${subscribers.get(projectId)!.size}`);
  }

  function unsubscribe(projectId: string, ws: WSContext) {
    const subs = subscribers.get(projectId);
    if (subs) {
      subs.delete(ws);
      console.log(`[board-events] WS unsubscribed: projectId=${projectId} subscribers=${subs.size}`);
      if (subs.size === 0) {
        subscribers.delete(projectId);
      }
    }
  }

  /** Remove dead WebSocket entries (readyState !== OPEN). */
  function cleanupStaleConnections() {
    for (const [projectId, subs] of subscribers) {
      for (const [ws] of subs) {
        if (ws.readyState !== 1) {
          subs.delete(ws);
        }
      }
      if (subs.size === 0) {
        subscribers.delete(projectId);
      }
    }
  }

  /**
   * Start a periodic cleanup timer that removes stale WebSocket connections.
   * Call once at server startup. The timer is unref'd so it won't prevent process exit.
   */
  function startCleanup(intervalMs = 30_000) {
    if (cleanupTimer !== null) return;
    cleanupTimer = setInterval(cleanupStaleConnections, intervalMs);
    (cleanupTimer as NodeJS.Timeout).unref?.();
  }

  /** Stop the cleanup timer (e.g. for testing or graceful shutdown). */
  function stopCleanup() {
    if (cleanupTimer !== null) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }

  function broadcast(projectId: string, reason: BoardEventType) {
    const subs = subscribers.get(projectId);
    if (!subs) return;
    const message: BoardEventMessage = { type: "board_changed", projectId, reason };
    const payload = JSON.stringify(message);
    for (const sub of subs.values()) {
      if (sub.ws.readyState === 1) {
        sub.ws.send(payload);
      }
    }
  }

  function broadcastActivity(projectId: string, data: Omit<SessionActivityMessage, "type" | "projectId">) {
    const subs = subscribers.get(projectId);
    if (!subs) return;
    const message: SessionActivityMessage = { type: "session_activity", projectId, ...data };
    const payload = JSON.stringify(message);
    for (const sub of subs.values()) {
      if (sub.ws.readyState === 1) {
        sub.ws.send(payload);
      }
    }
  }

  function broadcastLiveStats(projectId: string, issueId: string, model: string, contextTokens: number, toolUses: number, subagentCount: number) {
    const subs = subscribers.get(projectId);
    if (!subs) return;
    const message: SessionStatsMessage = { type: "session_stats", projectId, issueId, model, contextTokens, toolUses, subagentCount };
    const payload = JSON.stringify(message);
    for (const sub of subs.values()) {
      if (sub.ws.readyState === 1) {
        sub.ws.send(payload);
      }
    }
  }

  function broadcastApprovalRequest(projectId: string, data: Omit<ApprovalRequestMessage, "type" | "projectId">) {
    const subs = subscribers.get(projectId);
    if (!subs) return;
    const message: ApprovalRequestMessage = { type: "approval_requested", projectId, ...data };
    const payload = JSON.stringify(message);
    for (const sub of subs.values()) {
      if (sub.ws.readyState === 1) {
        sub.ws.send(payload);
      }
    }
  }

  function broadcastTodos(projectId: string, issueId: string, todos: TodoItem[]) {
    const subs = subscribers.get(projectId);
    if (!subs) return;
    const message: SessionTodosMessage = { type: "session_todos", projectId, issueId, todos };
    const payload = JSON.stringify(message);
    for (const sub of subs.values()) {
      if (sub.ws.readyState === 1) {
        sub.ws.send(payload);
      }
    }
  }

  return {
    subscribe,
    unsubscribe,
    broadcast,
    broadcastActivity,
    broadcastLiveStats,
    broadcastTodos,
    broadcastApprovalRequest,
    startCleanup,
    stopCleanup,
    cleanupStaleConnections,
  };
}

export { createBoardEvents };
export type BoardEvents = ReturnType<typeof createBoardEvents>;
