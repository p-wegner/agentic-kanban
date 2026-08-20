import type { BoardEventType } from "./board-events.js";

// #578: the union moved to shared so the CLIENT's ACTION_LABELS Record fails typecheck
// when a new action is added, instead of crashing the popover at runtime. Imported AND
// re-exported: `export type { X } from` alone does not bind X in this module's scope.
import type { MonitorActionName } from "@agentic-kanban/shared/lib/monitor-action";
export type { MonitorActionName };

export function sendMonitorNudge({
  sessionManager,
  sessionId,
  workspaceId,
  issueId,
  projectId,
  prompt,
  logAction,
  broadcast,
  logger = console,
}: {
  sessionManager: {
    sendTurn: (sessionId: string, content: string) => { ok: boolean; error?: string };
  };
  sessionId: string;
  workspaceId: string;
  issueId: string;
  projectId: string;
  prompt: string;
  logAction: (action: MonitorActionName, workspaceId: string, issueId: string) => void;
  broadcast: (projectId: string, event: BoardEventType) => void;
  logger?: Pick<typeof console, "log" | "warn">;
}): boolean {
  const result = sessionManager.sendTurn(sessionId, prompt);
  if (!result.ok) {
    logger.warn(`[monitor] Failed to nudge workspace ${workspaceId}: ${result.error ?? "unknown error"}`);
    return false;
  }

  logAction("nudge", workspaceId, issueId);
  broadcast(projectId, "board_changed");
  logger.log(`[monitor] Nudged long-running agent in workspace ${workspaceId}`);
  return true;
}
