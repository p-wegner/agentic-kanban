import { spawn, type ChildProcess } from "node:child_process";

export interface AgentOutputEvent {
  type: "stdout" | "stderr" | "exit";
  sessionId: string;
  data?: string;
  exitCode?: number | null;
}

export type AgentOutputCallback = (event: AgentOutputEvent) => void;

const activeProcesses = new Map<string, ChildProcess>();

/**
 * Launch an agent subprocess in the given worktree directory.
 * Uses AGENT_COMMAND env var for test substitution.
 * Emits structured output events via the callback.
 */
export function launch(
  worktreePath: string,
  sessionId: string,
  prompt: string,
  onOutput: AgentOutputCallback,
): ChildProcess {
  const command = process.env.AGENT_COMMAND || "claude";
  const isWindows = process.platform === "win32";

  const proc = spawn(command, ["--output-format", "stream-json", "-p", prompt], {
    cwd: worktreePath,
    shell: isWindows,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  activeProcesses.set(sessionId, proc);

  proc.stdout?.on("data", (chunk: Buffer) => {
    onOutput({ type: "stdout", sessionId, data: chunk.toString() });
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    onOutput({ type: "stderr", sessionId, data: chunk.toString() });
  });

  proc.on("exit", (code) => {
    activeProcesses.delete(sessionId);
    onOutput({ type: "exit", sessionId, exitCode: code });
  });

  proc.on("error", (err) => {
    onOutput({ type: "stderr", sessionId, data: `Process error: ${err.message}` });
    activeProcesses.delete(sessionId);
    onOutput({ type: "exit", sessionId, exitCode: 1 });
  });

  return proc;
}

/** Kill a running agent process by session ID. */
export function kill(sessionId: string): boolean {
  const proc = activeProcesses.get(sessionId);
  if (!proc) return false;

  if (process.platform === "win32") {
    // On Windows, use taskkill to kill the process tree
    spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { shell: true });
  } else {
    proc.kill("SIGTERM");
  }

  activeProcesses.delete(sessionId);
  return true;
}

/** Get the active process for a session, if any. */
export function getProcess(sessionId: string): ChildProcess | undefined {
  return activeProcesses.get(sessionId);
}
