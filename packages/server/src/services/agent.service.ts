import { spawn, type ChildProcess } from "node:child_process";
import { buildAgentLaunchConfig, type ProviderId } from "./agent-provider.js";

export interface AgentOutputEvent {
  type: "stdout" | "stderr" | "exit";
  sessionId: string;
  data?: string;
  exitCode?: number | null;
}

export type AgentOutputCallback = (event: AgentOutputEvent) => void;

const activeProcesses = new Map<string, ChildProcess>();
const activePids = new Map<string, number>();
const stdinOpen = new Map<string, boolean>();

function killPid(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { shell: true, windowsHide: true });
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch (err) {
      console.warn(`[agent] failed to kill pid=${pid}`, err);
    }
  }
}

/**
 * Launch an agent subprocess in the given worktree directory.
 * Uses AGENT_COMMAND env var for test substitution.
 * Emits structured output events via the callback.
 */
export function launch(
  worktreePath: string,
  sessionId: string,
  prompt: string,
  agentArgs: string | undefined,
  onOutput: AgentOutputCallback,
  providerSessionId?: string,
  agentCommand?: string,
  claudeProfile?: string,
  keepAlive?: boolean,
  permissionPromptTool?: string,
  planMode?: boolean,
  provider?: ProviderId,
): ChildProcess {
  const launchConfig = buildAgentLaunchConfig({
    agentArgs,
    providerSessionId,
    agentCommand,
    claudeProfile,
    keepAlive,
    permissionPromptTool,
    planMode,
    provider,
    prompt,
  });
  const { command, args, useShell, isMockAgent, env: spawnEnv } = launchConfig;

  console.log(`[agent] launching: command=${command} provider=${provider ?? "auto"} worktree=${worktreePath} sessionId=${sessionId} resume=${providerSessionId ?? "none"}`);

  const proc = spawn(command, args, {
    cwd: worktreePath,
    shell: useShell,
    env: {
      ...spawnEnv,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      KANBAN_SERVER_PORT: process.env.KANBAN_SERVER_PORT || process.env.PORT || "3001",
      KANBAN_CLIENT_PORT: process.env.KANBAN_CLIENT_PORT || process.env.VITE_PORT || "5173",
      SERVER_PORT: process.env.SERVER_PORT || process.env.PORT || "3001",
      PORT: process.env.PORT || "3001",
    },
    stdio: ["pipe", "pipe", "pipe"] as const,
  });

  console.log(`[agent] spawned: sessionId=${sessionId} pid=${proc.pid} command=${command} shell=${useShell}`);

  // Send prompt via stdin and close immediately.
  // On Windows, claude.exe buffers stdout until stdin is closed.
  // Multi-turn follow-ups are handled via --resume (new process per turn).
  proc.stdin?.end(prompt + "\n");


  activeProcesses.set(sessionId, proc);
  if (proc.pid) {
    activePids.set(sessionId, proc.pid);
  }

  proc.stdout?.on("data", (chunk: Buffer) => {
    try {
      onOutput({ type: "stdout", sessionId, data: chunk.toString() });
    } catch (err) {
      console.error(`[agent] stdout callback error: sessionId=${sessionId}`, err);
    }
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    try {
      onOutput({ type: "stderr", sessionId, data: chunk.toString() });
    } catch (err) {
      console.error(`[agent] stderr callback error: sessionId=${sessionId}`, err);
    }
  });

  proc.on("exit", (code, signal) => {
    console.log(`[agent] exited: sessionId=${sessionId} code=${code} signal=${signal ?? "none"} pid=${proc.pid}`);
    activeProcesses.delete(sessionId);
    activePids.delete(sessionId);
    stdinOpen.delete(sessionId);
    try {
      onOutput({ type: "exit", sessionId, exitCode: code });
    } catch (err) {
      console.error(`[agent] exit callback error: sessionId=${sessionId}`, err);
    }
  });

  proc.on("error", (err) => {
    console.error(`[agent] process error: sessionId=${sessionId} err=${err.message}`);
    try {
      onOutput({ type: "stderr", sessionId, data: `Process error: ${err.message}` });
    } catch (cbErr) {
      console.error(`[agent] error callback error: sessionId=${sessionId}`, cbErr);
    }
    activeProcesses.delete(sessionId);
    activePids.delete(sessionId);
    try {
      onOutput({ type: "exit", sessionId, exitCode: 1 });
    } catch (cbErr) {
      console.error(`[agent] error-exit callback error: sessionId=${sessionId}`, cbErr);
    }
  });

  return proc;
}

/** Kill a running agent process by session ID. */
export function kill(sessionId: string): boolean {
  const proc = activeProcesses.get(sessionId);
  const pid = proc?.pid ?? activePids.get(sessionId);
  if (!pid) return false;

  console.log(`[agent] killing: sessionId=${sessionId} pid=${pid}`);
  killPid(pid);

  activeProcesses.delete(sessionId);
  activePids.delete(sessionId);
  stdinOpen.delete(sessionId);
  return true;
}

/** Send a follow-up message to a running agent via stdin JSONL. */
export function sendInput(sessionId: string, content: string): boolean {
  const proc = activeProcesses.get(sessionId);
  if (!proc || !proc.stdin || proc.stdin.destroyed) return false;
  if (!stdinOpen.has(sessionId)) return false;
  const jsonl = JSON.stringify({ type: "user", content }) + "\n";
  try {
    return proc.stdin.write(jsonl);
  } catch (err) {
    console.error(`[agent] sendInput write error: sessionId=${sessionId}`, err);
    return false;
  }
}

/** Close stdin to signal the agent should finish. */
export function closeStdin(sessionId: string): boolean {
  const proc = activeProcesses.get(sessionId);
  if (!proc || !proc.stdin || proc.stdin.destroyed) return false;
  proc.stdin.end();
  stdinOpen.delete(sessionId);
  return true;
}

/** Check if stdin is open for a session (multi-turn mode). */
export function isStdinOpen(sessionId: string): boolean {
  return stdinOpen.get(sessionId) === true;
}

/** Kill all active agent processes (for graceful shutdown). */
export function killAll(): number {
  const count = activePids.size;
  if (count === 0) return 0;
  console.log(`[agent] killAll: terminating ${count} active process(es)`);
  for (const [sessionId, pid] of activePids) {
    console.log(`[agent] killAll: sessionId=${sessionId} pid=${pid}`);
    killPid(pid);
  }
  activeProcesses.clear();
  activePids.clear();
  stdinOpen.clear();
  return count;
}

/** Get the active process for a session, if any. */
export function getProcess(sessionId: string): ChildProcess | undefined {
  return activeProcesses.get(sessionId);
}

/** Register a persisted PID for a surviving process whose ChildProcess handle was lost. */
export function registerPid(sessionId: string, pid: number): void {
  activePids.set(sessionId, pid);
}

/** Get the tracked PID for a session, whether or not a ChildProcess handle exists. */
export function getPid(sessionId: string): number | undefined {
  return activeProcesses.get(sessionId)?.pid ?? activePids.get(sessionId);
}

/** Check if the tracked PID still exists without requiring a ChildProcess handle. */
export function isPidAlive(sessionId: string): boolean {
  const pid = getPid(sessionId);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    activePids.delete(sessionId);
    return false;
  }
}
