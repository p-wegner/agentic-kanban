import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir, homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve MCP server entry point and tsx loader (relative to this file)
const MCP_SERVER_PATH = resolve(__dirname, "../../../mcp-server/src/index.ts");
const TSX_LOADER = resolve(__dirname, "../../node_modules/tsx/dist/loader.mjs");
const TSX_URL = pathToFileURL(TSX_LOADER).href;

// Write MCP config JSON once and reuse the path
let mcpConfigPath: string | null = null;

function getMcpConfigPath(): string {
  if (mcpConfigPath && existsSync(mcpConfigPath)) return mcpConfigPath;
  const config = {
    mcpServers: {
      "agentic-kanban": {
        command: "node",
        args: ["--import", TSX_URL, MCP_SERVER_PATH],
      },
    },
  };
  const path = resolve(tmpdir(), "agentic-kanban-mcp-config.json");
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
  mcpConfigPath = path;
  console.log(`[agent] MCP config written to ${path}`);
  return path;
}

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
  claudeSessionId?: string,
  agentCommand?: string,
  claudeProfile?: string,
  keepAlive?: boolean,
  permissionPromptTool?: string,
): ChildProcess {
  // Test mock agents use AGENT_COMMAND env var and need no claude-specific flags.
  // Real claude (default or configured via preferences) gets stream-json args + stdin prompt.
  const isTestMock = !!process.env.AGENT_COMMAND;
  const command = process.env.AGENT_COMMAND || agentCommand || "claude";
  const isWindows = process.platform === "win32";
  console.log(`[agent] launching: command=${command} worktree=${worktreePath} sessionId=${sessionId} resume=${claudeSessionId ?? "none"}`);

  let args: string[];
  if (isTestMock) {
    // Test mock agents: run bare, no flags
    args = [];
  } else {
    // Real claude binary (default or custom name): always use stream-json + stdin
    args = ["--output-format", "stream-json", "--verbose"];
    // Pass MCP config so the agent can use agentic-kanban tools
    try {
      const configPath = getMcpConfigPath();
      args.push("--mcp-config", configPath);
    } catch (err) {
      console.warn(`[agent] Failed to generate MCP config: ${err}`);
    }
    if (agentArgs) {
      args.push(...splitArgs(agentArgs));
    }
    if (claudeProfile) {
      const settingsPath = join(homedir(), ".claude", `settings_${claudeProfile}.json`);
      if (existsSync(settingsPath)) {
        args.push("--settings", settingsPath);
      }
    }
    if (claudeSessionId) {
      args.push("--resume", claudeSessionId);
    }
    if (permissionPromptTool) {
      args.push("--permission-prompt-tool", permissionPromptTool);
    }
    args.push("-p");
  }

  // On Windows, use shell:true for custom/mock commands (.bat/.cmd need cmd.exe).
  // Default claude uses shell:false to avoid cmd.exe buffering stdout streams.
  const useShell = isWindows && (isTestMock || !!agentCommand);

  const proc = spawn(command, args, {
    cwd: worktreePath,
    shell: useShell,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"] as const,
  });

  console.log(`[agent] spawned: sessionId=${sessionId} pid=${proc.pid} command=${command} shell=${useShell}`);

  // Send prompt via stdin. Keep stdin open for multi-turn when keepAlive is true.
  if (!isTestMock) {
    if (keepAlive) {
      proc.stdin?.write(prompt + "\n");
      stdinOpen.set(sessionId, true);
    } else {
      proc.stdin?.end(prompt + "\n");
    }
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
    spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { shell: true });
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
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { shell: true });
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
