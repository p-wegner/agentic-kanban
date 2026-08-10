// Pure launch-config helpers extracted from agent.service.launch: the detach
// decision, dev-port resolution, and the spawn env wiring. These are
// side-effect-free (no spawn, no fs, no process.env reads — inputs are passed in)
// so the historically bug-prone bits (port derivation, KANBAN_PROTECTED_PIDS,
// extraEnv precedence) become directly unit-testable. The actual spawn, fd setup,
// and watcher wiring stay in agent.service.

import { gradleUserHomeForWorktree } from "@agentic-kanban/shared/lib/gradle-env";

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
  /**
   * Absolute path of the worktree the agent runs in. Used to derive a per-worktree
   * `GRADLE_USER_HOME` (#194) so JVM builders in different worktrees never share a
   * daemon registry — set unconditionally; it is inert for non-Gradle projects.
   *
   * Also exported to the child as `KANBAN_WORKTREE_DIR` (#369): the cross-worktree
   * guard reads it as the AUTHORIZED root instead of deriving one from its own cwd.
   * Board-supplied, so an agent that has cd-ed into the main checkout can no longer
   * self-authorize that checkout.
   */
  worktreePath: string;
  /** Per-launch overrides; applied LAST so they win. */
  extraEnv: Record<string, string> | undefined;
}

/**
 * Build the full child-process env: base provider env, color-off flags, board +
 * worktree port wiring, the protected-pid list (board pid appended), session id
 * markers, the per-worktree Gradle isolation default, then the per-launch extraEnv
 * overrides last.
 */
export function buildAgentSpawnEnv(params: AgentSpawnEnvParams): Record<string, string | undefined> {
  const { spawnEnv, ports, serverPid, protectedPidsEnv, sessionId, worktreePath, extraEnv } = params;
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
    GRADLE_USER_HOME: gradleUserHomeForWorktree(worktreePath),
    // The authorized-worktree declaration the cross-worktree guard trusts (#369). Must come
    // from the board, never from the agent's own cwd.
    KANBAN_WORKTREE_DIR: worktreePath,
    ...extraEnv,
  };
}

/**
 * Spawn-layer hang watchdog timeout. If a launched agent produces NO stdout/stderr
 * activity for this long, the watchdog kills it — a hang at the spawn layer
 * (provider deadlocked on a prompt, stuck on a network call, waiting on stdin that
 * was never closed) is otherwise invisible until a monitor cycle notices. Resets on
 * every output event; only fires on true silence.
 *
 * Lives here (not in agent.service) because BOTH execution paths need the same
 * rule: the host spawn site and the fleet worker's runner. A remote session that
 * resolved this differently would silently lose the protection its host twin has.
 * Override with KANBAN_AGENT_HANG_TIMEOUT_MS (0 disables).
 */
export const DEFAULT_AGENT_HANG_TIMEOUT_MS = 15 * 60 * 1000;

export function resolveAgentHangTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.KANBAN_AGENT_HANG_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_AGENT_HANG_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_AGENT_HANG_TIMEOUT_MS;
  return parsed;
}

/**
 * Start an inactivity watchdog: after `timeoutMs` with no reset() call, `onHang`
 * fires exactly once. timeoutMs <= 0 disables it (inert handles). Shared by the
 * host spawn site and the worker runner so both behave identically.
 */
export function startHangWatchdog(
  label: string,
  timeoutMs: number,
  onHang: () => void,
): { reset(): void; close(): void } {
  if (timeoutMs <= 0) return { reset() {}, close() {} };
  let closed = false;
  let fired = false;
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    if (closed) return;
    timer = setTimeout(() => {
      if (closed || fired) return;
      fired = true;
      try {
        onHang();
      } catch (err) {
        console.error(`[agent] hang-watchdog callback error: ${label}`, err);
      }
    }, timeoutMs);
    if (timer.unref) timer.unref();
  };
  arm();
  return {
    reset() {
      if (closed || fired) return;
      if (timer) clearTimeout(timer);
      arm();
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  };
}
