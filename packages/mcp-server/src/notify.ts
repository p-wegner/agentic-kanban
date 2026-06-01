import { boardApiUrl } from "./server-url.js";

/**
 * Fire-and-forget notification to the main server to broadcast a board_changed event.
 * Used by MCP tools after mutations so connected browsers refresh immediately
 * instead of waiting for the next polling cycle.
 */
export function notifyBoard(projectId: string, reason: string) {
  fetch(boardApiUrl("/api/internal/board-notify"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, reason }),
  }).catch(() => {
    // Silently ignore — polling fallback will catch it
  });
}

/**
 * Fire-and-forget notification to the main server that a workflow transition
 * occurred, so it can run fork/join orchestration (which needs the session
 * manager + git, only available in the main server process).
 */
export function notifyWorkflowAdvanced(workspaceId: string) {
  fetch(boardApiUrl("/api/internal/workflow-advanced"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId }),
  }).catch(() => {
    /* best-effort */
  });
}
