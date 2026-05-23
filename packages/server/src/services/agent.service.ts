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
const stdinOpen = new Map<string, boolean>();

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
  profile?: { provider: "claude" | "codex"; name: string },
): ChildProcess {
  const launchConfig = buildAgentLaunchConfig({
    agentArgs,
    providerSessionId,
    agentCommand,
    claudeProfile,
    profile,
    keepAlive,
    permissionPromptTool,
    planMode,
    provider,
    prompt,
  });
  const { command, args, useShell, isMockAgent, env: spawnEnv } = launchConfig;

  console.log(`[agent] launching: command=${command} provider=${provider ?? "auto"} worktree=${worktreePath} sessionId=${sessionId} resume=${providerSessionId ?? "none"}`);

  // On Windows, detached: true breaks stdout pipes when shell: true is used (mock agents).
  // Only detach non-mock agents — they need to outlive server hot-reload restarts.
  const shouldDetach = !(isMockAgent && process.platform === "win32");
  const proc = spawn(command, args, {
    cwd: worktreePath,
    shell: useShell,
    windowsHide: true,
    detached: shouldDetach,
    env: {
      ...spawnEnv,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      KANBAN_SERVER_PORT: process.env.KANBAN_SERVER_PORT || process.env.PORT || "3001",
      KANBAN_CLIENT_PORT: process.env.KANBAN_CLIENT_PORT || process.env.VITE_PORT || "5173",
      SERVER_PORT: process.env.SERVER_PORT || process.env.PORT || "3001",
      PORT: process.env.PORT || "3001",
    },
    // For real (detached) agents on Windows, use "ignore" for stderr so grandchild processes
    // spawned by claude.exe don't inherit a broken pipe handle after the server hot-reloads.
    // Mock agents (not detached) use "pipe" so we can capture the "resuming session" log.
    stdio: ["pipe", "pipe", shouldDetach ? "ignore" as const : "pipe" as const],
  });
  // Allow server to exit/restart without waiting for real agents
  if (shouldDetach) proc.unref();

  console.log(`[agent] spawned: sessionId=${sessionId} pid=${proc.pid} command=${command} shell=${useShell}`);

  // In keepAlive (multi-turn) mode, keep stdin open so follow-ups can be sent via sendInput.
  // Otherwise close stdin immediately — on Windows, claude.exe buffers stdout until stdin closes.
  if (keepAlive) {
    proc.stdin?.write(prompt + "\n");
    stdinOpen.set(sessionId, true);
  } else {
    proc.stdin?.end(prompt + "\n");
  }

  activeProcesses.set(sessionId, proc);

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
  if (!proc) return false;

  console.log(`[agent] killing: sessionId=${sessionId} pid=${proc.pid}`);
  if (process.platform === "win32") {
    // On Windows, use taskkill to kill the process tree
    spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { shell: true, windowsHide: true });
  } else {
    proc.kill("SIGTERM");
  }

  activeProcesses.delete(sessionId);
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
  const count = activeProcesses.size;
  if (count === 0) return 0;
  console.log(`[agent] killAll: terminating ${count} active process(es)`);
  for (const [sessionId, proc] of activeProcesses) {
    console.log(`[agent] killAll: sessionId=${sessionId} pid=${proc.pid}`);
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { shell: true, windowsHide: true });
    } else {
      proc.kill("SIGTERM");
    }
  }
  activeProcesses.clear();
  stdinOpen.clear();
  return count;
}

/** Get the active process for a session, if any. */
export function getProcess(sessionId: string): ChildProcess | undefined {
  return activeProcesses.get(sessionId);
}
