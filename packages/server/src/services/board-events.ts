import type { WSContext } from "hono/ws";
import type {
  BoardEventReason,
  ProjectEventReason,
  BoardChangedMessage,
  ProjectsChangedMessage,
  SessionActivityMessage,
  SessionStatsMessage,
  SessionTodosMessage,
  ApprovalRequestMessage,
  PluginGateMessage,
  TodoItem,
  BoardWsMessage,
} from "@agentic-kanban/shared/lib/board-events-contract";

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
 * | workflow_template_saved   | workflows route                             |
 * | workflow_template_deleted | workflows route                             |
 * | workflow_transition       | workflows route                             |
 * | drive_obstacle            | drive-obstacles.service (friction telemetry)|
 * | project_completed         | project-completion-reconciler (#848)        |
 * | internal_notify           | routes/index internal endpoint              |
 * | projects_changed          | projects route emits a separate WS message  |
 */
/**
 * The vocabulary and the message union live in shared (#566) so the MCP notifier, the
 * internal notify route and the client filter on the SAME list instead of three
 * hand-maintained copies. Re-exported under the historical names because the rest of
 * the server already imports them from here.
 */
export type BoardEventType = BoardEventReason;
export type ProjectEventType = ProjectEventReason;
export type {
  SessionActivityMessage,
  SessionStatsMessage,
  SessionTodosMessage,
  ApprovalRequestMessage,
  PluginGateMessage,
  TodoItem,
  BoardWsMessage,
};

interface BoardEventSubscriber {
  ws: WSContext;
}

type InvalidationListener = (projectId: string) => void;

function createBoardEvents() {
  const subscribers = new Map<string, Map<WSContext, BoardEventSubscriber>>();
  const invalidationListeners = new Set<InvalidationListener>();
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  function addInvalidationListener(listener: InvalidationListener): void {
    invalidationListeners.add(listener);
  }

  function removeInvalidationListener(listener: InvalidationListener): void {
    invalidationListeners.delete(listener);
  }

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

  /** Whether any LIVE WebSocket is subscribed to this project's board (G14f) —
   * lets warm-ahead work skip projects nobody is currently watching. */
  function hasSubscribers(projectId: string): boolean {
    const subs = subscribers.get(projectId);
    if (!subs) return false;
    for (const sub of subs.values()) {
      if (sub.ws.readyState === 1) return true;
    }
    return false;
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
    (cleanupTimer).unref?.();
  }

  /** Stop the cleanup timer (e.g. for testing or graceful shutdown). */
  function stopCleanup() {
    if (cleanupTimer !== null) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }

  function broadcast(projectId: string, reason: BoardEventType) {
    for (const listener of invalidationListeners) {
      listener(projectId);
    }
    const subs = subscribers.get(projectId);
    if (!subs) return;
    const message: BoardChangedMessage = { type: "board_changed", projectId, reason };
    const payload = JSON.stringify(message);
    for (const sub of subs.values()) {
      if (sub.ws.readyState === 1) {
        sub.ws.send(payload);
      }
    }
  }

  function broadcastProjectsChanged(projectId: string, reason: ProjectEventType) {
    const message: ProjectsChangedMessage = { type: "projects_changed", projectId, reason };
    const payload = JSON.stringify(message);
    const sent = new Set<WSContext>();

    for (const subs of subscribers.values()) {
      for (const sub of subs.values()) {
        if (sent.has(sub.ws)) continue;
        sent.add(sub.ws);
        if (sub.ws.readyState === 1) {
          sub.ws.send(payload);
        }
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

  function broadcastPluginGate(projectId: string, data: Omit<PluginGateMessage, "type" | "projectId">) {
    const subs = subscribers.get(projectId);
    if (!subs) return;
    const message: PluginGateMessage = { type: "plugin_gate", projectId, ...data };
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
    hasSubscribers,
    broadcast,
    broadcastProjectsChanged,
    broadcastActivity,
    broadcastLiveStats,
    broadcastTodos,
    broadcastApprovalRequest,
    broadcastPluginGate,
    startCleanup,
    stopCleanup,
    cleanupStaleConnections,
    addInvalidationListener,
    removeInvalidationListener,
  };
}

export { createBoardEvents };
export type BoardEvents = ReturnType<typeof createBoardEvents>;

/**
 * The narrow port most consumers actually need (#560): emit an event, nothing else.
 *
 * `BoardEvents` is the whole 14-method hub — subscribe/unsubscribe, invalidation
 * listeners, the cleanup timer — and demanding it from a service that only calls
 * `broadcast` both hides that service's real dependency surface and forces every one
 * of its tests to fake a hub it never touches (`boardEvents as never`). Wiring code
 * (`server-start.ts`, `routes/index.ts`, the WS route) keeps the full type; a service
 * that only emits declares this.
 */
export type BoardEventSink = Pick<BoardEvents, "broadcast" | "broadcastActivity">;
