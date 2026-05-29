import type { BoardEventType } from "./board-events.js";

export type MonitorActionName =
  | "relaunch"
  | "merge"
  | "nudge"
  | "mark_idle"
  | "mark_dead"
  | "auto_start";

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
