export function buildDevPortEnv(serverPort, clientPort, env = process.env, supervisorPid = process.pid) {
  return {
    PORT: String(serverPort),
    VITE_PORT: String(clientPort),
    SERVER_PORT: String(serverPort),
    KANBAN_SERVER_PORT: String(serverPort),
    KANBAN_WORKTREE_SERVER_PORT: String(serverPort),
    KANBAN_CLIENT_PORT: String(clientPort),
    KANBAN_WORKTREE_CLIENT_PORT: String(clientPort),
    KANBAN_BOARD_SERVER_PID: String(supervisorPid),
    KANBAN_PROTECTED_PIDS: [env.KANBAN_PROTECTED_PIDS, String(supervisorPid)]
      .filter(Boolean)
      .join(","),
  };
}
