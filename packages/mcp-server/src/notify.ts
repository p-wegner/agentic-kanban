const SERVER_PORT = Number(process.env.SERVER_PORT) || 3001;

/**
 * Fire-and-forget notification to the main server to broadcast a board_changed event.
 * Used by MCP tools after mutations so connected browsers refresh immediately
 * instead of waiting for the next polling cycle.
 */
export function notifyBoard(projectId: string, reason: string) {
  fetch(`http://localhost:${SERVER_PORT}/api/internal/board-notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, reason }),
  }).catch(() => {
    // Silently ignore — polling fallback will catch it
  });
}
