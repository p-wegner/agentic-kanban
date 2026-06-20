// Pure launch-config helpers extracted from agent.service.launch: the detach
// decision, dev-port resolution, and the spawn env wiring. These are
// side-effect-free (no spawn, no fs, no process.env reads — inputs are passed in)
// so the historically bug-prone bits (port derivation, KANBAN_PROTECTED_PIDS,
// extraEnv precedence) become directly unit-testable. The actual spawn, fd setup,
// and watcher wiring stay in agent.service.

export const DEFAULT_BOARD_SERVER_PORT = "3001";
export const DEFAULT_BOARD_CLIENT_PORT = "5173";

/**
 * Agents that don't need a shell can be detached so they survive tsx-watch
 * hot-reloads. `shell: true` on Windows (mock agents, Codex's .cmd shim) must stay
 * attached — detaching those breaks the stdout pipe.
 */
export function shouldDetachAgent(useShell: boolean, platform: NodeJS.Platform): boolean {
  return !(useShell && platform === "win32");
}

export interface LaunchPorts {
  boardServerPort: string;
  boardClientPort: string;
  worktreeServerPort: string;
  worktreeClientPort: string;
}

/**
 * Resolve the board's own ports (from env, with defaults) and the worktree's ports
 * (from the derived worktree ports, falling back to the board's).
 */
export function resolveLaunchPorts(
  env: { KANBAN_SERVER_PORT?: string; PORT?: string; KANBAN_CLIENT_PORT?: string; VITE_PORT?: string },
  worktreePorts: { serverPort: string; clientPort: string } | null,
): LaunchPorts {
  const boardServerPort = env.KANBAN_SERVER_PORT || env.PORT || DEFAULT_BOARD_SERVER_PORT;
  const boardClientPort = env.KANBAN_CLIENT_PORT || env.VITE_PORT || DEFAULT_BOARD_CLIENT_PORT;
  return {
    boardServerPort,
    boardClientPort,
    worktreeServerPort: worktreePorts?.serverPort || boardServerPort,
    worktreeClientPort: worktreePorts?.clientPort || boardClientPort,
  };
}

export interface AgentSpawnEnvParams {
  /** The provider-resolved base env (auth, profile dir, etc.). */
  spawnEnv: Record<string, string | undefined>;
  ports: LaunchPorts;
  /** String(process.pid) of the board server. */
  serverPid: string;
  /** process.env.KANBAN_PROTECTED_PIDS (already-protected pids), if any. */
  protectedPidsEnv: string | undefined;
  sessionId: string;
  /** Per-launch overrides; applied LAST so they win. */
  extraEnv: Record<string, string> | undefined;
}

/**
 * Build the full child-process env: base provider env, color-off flags, board +
 * worktree port wiring, the protected-pid list (board pid appended), session id
 * markers, then the per-launch extraEnv overrides last.
 */
export function buildAgentSpawnEnv(params: AgentSpawnEnvParams): Record<string, string | undefined> {
  const { spawnEnv, ports, serverPid, protectedPidsEnv, sessionId, extraEnv } = params;
  return {
    ...spawnEnv,
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    KANBAN_BOARD_SERVER_PORT: ports.boardServerPort,
    KANBAN_BOARD_CLIENT_PORT: ports.boardClientPort,
    KANBAN_BOARD_SERVER_PID: serverPid,
    KANBAN_PROTECTED_PIDS: [protectedPidsEnv, serverPid].filter(Boolean).join(","),
    KANBAN_SESSION_ID: sessionId,
    AGENTIC_KANBAN_SESSION_ID: sessionId,
    KANBAN_SERVER_PORT: ports.worktreeServerPort,
    KANBAN_CLIENT_PORT: ports.worktreeClientPort,
    KANBAN_WORKTREE_SERVER_PORT: ports.worktreeServerPort,
    KANBAN_WORKTREE_CLIENT_PORT: ports.worktreeClientPort,
    SERVER_PORT: ports.worktreeServerPort,
    PORT: ports.worktreeServerPort,
    VITE_PORT: ports.worktreeClientPort,
    ...extraEnv,
  };
}
