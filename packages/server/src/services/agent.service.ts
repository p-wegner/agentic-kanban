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
  agentArgs: string | undefined,
  onOutput: AgentOutputCallback,
): ChildProcess {
  const command = process.env.AGENT_COMMAND || "claude";
  const isCustomCommand = !!process.env.AGENT_COMMAND;
  const isWindows = process.platform === "win32";
  console.log(`[agent] launching: command=${command} worktree=${worktreePath} sessionId=${sessionId}`);

  // Custom agent commands run directly; claude gets its specific flags
  let args: string[];
  if (isCustomCommand) {
    args = [];
  } else {
    args = ["--output-format", "stream-json", "--verbose"];
    // Append extra args from settings (e.g. "--model opus", "--settings path")
    if (agentArgs) {
      args.push(...splitArgs(agentArgs));
    }
    args.push("-p", prompt);
  }

  // On Windows, only use shell:true for custom commands (which may be one-liners).
  // The claude binary is a real .exe — shell:true causes cmd.exe to buffer stdout.
  const useShell = isWindows && isCustomCommand;

  const proc = spawn(command, args, {
    cwd: worktreePath,
    shell: useShell,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"] as const,
  });

  activeProcesses.set(sessionId, proc);

  proc.stdout?.on("data", (chunk: Buffer) => {
    onOutput({ type: "stdout", sessionId, data: chunk.toString() });
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    onOutput({ type: "stderr", sessionId, data: chunk.toString() });
  });

  proc.on("exit", (code) => {
    console.log(`[agent] exited: sessionId=${sessionId} code=${code}`);
    activeProcesses.delete(sessionId);
    onOutput({ type: "exit", sessionId, exitCode: code });
  });

  proc.on("error", (err) => {
    console.error(`[agent] process error: sessionId=${sessionId} err=${err.message}`);
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

/** Split a shell-like args string into an array, respecting quoted segments. */
function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  for (const ch of input) {
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === " " || ch === "\t") {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}
