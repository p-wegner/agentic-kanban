import { spawn, type ChildProcess } from "node:child_process";
import { openSync, closeSync, readSync, statSync, unlinkSync, existsSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentLaunchConfig, type ProviderId, type ProviderName } from "./agent-provider.js";
import { guardProcessKill, auditProcessEvent } from "./process-guard.js";
import { resolveWorktreeDevPorts as resolveWorktreeDevPortsShared } from "./worktree-ports.js";

const DEFAULT_BOARD_SERVER_PORT = "3001";
const DEFAULT_BOARD_CLIENT_PORT = "5173";

function resolveWorktreeDevPorts(worktreePath: string): { serverPort: string; clientPort: string } | null {
  const ports = resolveWorktreeDevPortsShared(worktreePath);
  if (!ports) return null;
  return { serverPort: String(ports.serverPort), clientPort: String(ports.clientPort) };
}

export interface AgentOutputEvent {
  type: "stdout" | "stderr" | "exit";
  sessionId: string;
  data?: string;
  exitCode?: number | null;
}

export type AgentOutputCallback = (event: AgentOutputEvent) => void;

/** Encapsulates all runtime state for active agent processes. Injectable for testing. */
export class AgentState {
  readonly activeProcesses = new Map<string, ChildProcess>();
  readonly activePids = new Map<string, number>();
  readonly stdinOpen = new Map<string, boolean>();
  readonly outputWatchers = new Map<string, { close(): void }>();
  readonly pidWatchers = new Map<string, { close(): void }>();

  /** Close all watchers and clear all state without killing processes. Intended for test cleanup. */
  reset(): void {
    for (const watcher of this.outputWatchers.values()) watcher.close();
    this.outputWatchers.clear();
    for (const w of this.pidWatchers.values()) w.close();
    this.pidWatchers.clear();
    this.activeProcesses.clear();
    this.activePids.clear();
    this.stdinOpen.clear();
  }
}

/** Module-level singleton used by all exported functions. */
export const agentState = new AgentState();

function appendContextFilesToPrompt(prompt: string, contextFiles: string[] | undefined): string {
  if (!contextFiles?.length) return prompt;

  const sections: string[] = [];
  for (const file of contextFiles) {
    try {
      const content = readFileSync(file, "utf-8").trim();
      if (content) {
        sections.push(`### ${file}\n\n${content}`);
      }
    } catch (err) {
      console.warn(`[agent] failed to read context file for prompt injection: file=${file}`, err);
    }
  }

  if (sections.length === 0) return prompt;
  return `${prompt}\n\n[Attached context files]\n\n${sections.join("\n\n---\n\n")}`;
}

/** Get the output file path for a session. */
export function sessionOutputPath(sessionId: string): string {
  return join(tmpdir(), `kanban-session-${sessionId}.out`);
}

/**
 * Get the stderr capture file path for a detached session.
 *
 * Detached agents (claude on Windows — see {@link launchAgent}) redirect stdout to the
 * `.out` file, but stderr used to be discarded (`stdio[2] = "ignore"`). When the provider
 * process dies BEFORE emitting any stdout (e.g. claude.exe exits 1 immediately from a
 * fix-and-merge launch in a mid-rebase / conflicted worktree), the `.out` file is 0 bytes
 * and the only diagnostic — the reason on stderr — was thrown away, producing an invisible
 * "0-token zombie" (#779). We now redirect stderr to this file so the failure is debuggable.
 */
export function sessionErrorPath(sessionId: string): string {
  return join(tmpdir(), `kanban-session-${sessionId}.err`);
}

/**
 * Read the captured stderr file for a detached session and, if non-empty, emit it as a
 * stderr output event. Called once on process exit so the failure reason of a crash-on-launch
 * (which a detached claude.exe writes to stderr, not stdout) reaches session_messages instead
 * of being silently discarded (#779). Best-effort: missing/empty file is a no-op.
 */
function drainCapturedStderr(sessionId: string, onOutput: (event: AgentOutputEvent) => void): void {
  try {
    const errPath = sessionErrorPath(sessionId);
    if (!existsSync(errPath)) return;
    const data = readFileSync(errPath, "utf8");
    if (!data.trim()) return;
    onOutput({ type: "stderr", sessionId, data });
  } catch (err) {
    console.warn(`[agent] failed to drain captured stderr: sessionId=${sessionId}`, err);
  }
}

function killPid(pid: number, context: Record<string, unknown>): boolean {
  if (!guardProcessKill(pid, context)) return false;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { shell: true, windowsHide: true });
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch (err) {
      console.warn(`[agent] failed to kill pid=${pid}`, err);
    }
  }
  return true;
}

/** Watch a session output file for new content and feed it to onOutput. */
function startOutputFileWatcher(
  sessionId: string,
  filePath: string,
  onOutput: AgentOutputCallback,
  startOffset = 0,
): { close(): void } {
  let offset = startOffset;
  let closed = false;
  const poll = () => {
    if (closed) return;
    try {
      const stat = statSync(filePath);
      if (stat.size > offset) {
        const fd = openSync(filePath, "r");
        try {
          const buf = Buffer.alloc(stat.size - offset);
          readSync(fd, buf, 0, buf.length, offset);
          offset = stat.size;
          const data = buf.toString();
          if (data) {
            try {
              onOutput({ type: "stdout", sessionId, data });
            } catch (err) {
              console.error(`[agent] output-watcher callback error: sessionId=${sessionId}`, err);
            }
          }
        } finally {
          closeSync(fd);
        }
      }
    } catch {
      // File might not exist yet or was deleted — ignore
    }
  };
  const timer = setInterval(poll, 500);
  // Unref so the timer doesn't keep the process alive (only matters for the agent child,
  // not the server, but keeps things clean)
  if (timer.unref) timer.unref();
  return {
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}

/** Poll a PID and call onExit when the process dies. */
function startPidWatcher(
  sessionId: string,
  pid: number,
  onExit: () => void,
): { close(): void } {
  let closed = false;
  const timer = setInterval(() => {
    if (closed) return;
    try {
      process.kill(pid, 0);
    } catch (err: unknown) {
      // EPERM means the process exists but we lack permission to signal it — don't call onExit.
      if ((err as NodeJS.ErrnoException).code === "EPERM") return;
      closed = true;
      clearInterval(timer);
      onExit();
    }
  }, 5000);
  if (timer.unref) timer.unref();
  return {
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
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
  profile?: { provider: ProviderName; name: string },
  extraEnv?: Record<string, string>,
  skipPermissions?: boolean,
  model?: string,
  contextFiles?: string[],
  systemInstructions?: string,
): ChildProcess {
  const effectivePrompt = provider === "codex"
    ? appendContextFilesToPrompt(prompt, contextFiles)
    : prompt;
  const launchConfig = buildAgentLaunchConfig({
    agentArgs,
    providerSessionId,
    agentCommand,
    claudeProfile,
    profile,
    model,
    systemInstructions,
    keepAlive,
    permissionPromptTool,
    planMode,
    provider,
    prompt: effectivePrompt,
    contextFiles,
    skipPermissions,
  });
  const { command, args, useShell, isMockAgent, env: spawnEnv, promptPrefix, suppressStdinPrompt } = launchConfig;
  const stdinPrompt = promptPrefix ? `${promptPrefix}\n\n${effectivePrompt}` : effectivePrompt;
  const boardServerPort = process.env.KANBAN_SERVER_PORT || process.env.PORT || DEFAULT_BOARD_SERVER_PORT;
  const boardClientPort = process.env.KANBAN_CLIENT_PORT || process.env.VITE_PORT || DEFAULT_BOARD_CLIENT_PORT;
  const worktreePorts = resolveWorktreeDevPorts(worktreePath);
  const worktreeServerPort = worktreePorts?.serverPort || boardServerPort;
  const worktreeClientPort = worktreePorts?.clientPort || boardClientPort;

  console.log(`[agent] launching: command=${command} provider=${provider ?? "auto"} worktree=${worktreePath} sessionId=${sessionId} resume=${providerSessionId ?? "none"}`);

  // Agents that don't need a shell can be detached — they survive tsx watch hot-reloads.
  // shell: true on Windows is used by mock agents and Codex (.cmd shim) — detaching those
  // breaks stdout pipes, so they stay attached (sacrificing hot-reload survival for output).
  const shouldDetach = !(useShell && process.platform === "win32");

  // For detached agents, redirect stdout to a file so the output survives server restarts.
  // Non-detached agents use pipes as before.
  // When suppressStdinPrompt is true (e.g. copilot passes prompt via -p argv), stdin can be
  // "ignore" — this prevents Windows from allocating a console window for the detached process.
  let outFd: number | undefined;
  let errFd: number | undefined;
  let stdioConfig: ["pipe" | "ignore", "pipe" | number, "pipe" | number | "ignore"];
  if (shouldDetach) {
    const outPath = sessionOutputPath(sessionId);
    outFd = openSync(outPath, "w");
    // Capture stderr to a separate file instead of discarding it (#779). A detached
    // claude.exe that dies immediately writes its failure reason to stderr; with stderr
    // ignored the only artifact was a 0-byte .out file and an exit code, making the
    // crash impossible to diagnose. The .err file is drained into session_messages on exit.
    const errPath = sessionErrorPath(sessionId);
    try {
      errFd = openSync(errPath, "w");
    } catch (err) {
      console.warn(`[agent] failed to open stderr capture file: sessionId=${sessionId}`, err);
      errFd = undefined;
    }
    stdioConfig = [suppressStdinPrompt ? "ignore" : "pipe", outFd, errFd ?? "ignore"];
  } else {
    stdioConfig = ["pipe", "pipe", "pipe"];
  }

  const proc = spawn(command, args, {
    cwd: worktreePath,
    shell: useShell,
    windowsHide: true,
    detached: shouldDetach,
    env: {
      ...spawnEnv,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      KANBAN_BOARD_SERVER_PORT: boardServerPort,
      KANBAN_BOARD_CLIENT_PORT: boardClientPort,
      KANBAN_BOARD_SERVER_PID: String(process.pid),
      KANBAN_PROTECTED_PIDS: [process.env.KANBAN_PROTECTED_PIDS, String(process.pid)].filter(Boolean).join(","),
      KANBAN_SESSION_ID: sessionId,
      AGENTIC_KANBAN_SESSION_ID: sessionId,
      KANBAN_SERVER_PORT: worktreeServerPort,
      KANBAN_CLIENT_PORT: worktreeClientPort,
      KANBAN_WORKTREE_SERVER_PORT: worktreeServerPort,
      KANBAN_WORKTREE_CLIENT_PORT: worktreeClientPort,
      SERVER_PORT: worktreeServerPort,
      PORT: worktreeServerPort,
      VITE_PORT: worktreeClientPort,
      ...extraEnv,
    },
    stdio: stdioConfig,
  });
  // Allow server to exit/restart without waiting for real agents
  if (shouldDetach) proc.unref();

  // Close the parent's copies of the inherited file descriptors. The spawned child holds
  // its own dup'd handles, so closing here doesn't truncate the child's output — it just
  // releases our references and lets the .err file be read once the child exits.
  if (errFd !== undefined) {
    try { closeSync(errFd); } catch { /* already closed / invalid */ }
  }

  console.log(`[agent] spawned: sessionId=${sessionId} pid=${proc.pid} command=${command} shell=${useShell} detached=${shouldDetach}`);

  // In keepAlive (multi-turn) mode, keep stdin open so follow-ups can be sent via sendInput.
  // Otherwise close stdin immediately — on Windows, claude.exe buffers stdout until stdin closes.
  if (suppressStdinPrompt) {
    proc.stdin?.end();
  } else if (keepAlive) {
    proc.stdin?.write(stdinPrompt + "\n");
    agentState.stdinOpen.set(sessionId, true);
  } else {
    proc.stdin?.end(stdinPrompt + "\n");
  }

  agentState.activeProcesses.set(sessionId, proc);
  if (proc.pid) {
    agentState.activePids.set(sessionId, proc.pid);
  }

  if (shouldDetach) {
    // File-based output: watch the output file for new content
    const outPath = sessionOutputPath(sessionId);
    const watcher = startOutputFileWatcher(sessionId, outPath, onOutput);
    agentState.outputWatchers.set(sessionId, watcher);
  } else {
    // Pipe-based output: read directly from stdout and mirror to the .out file
    // so replay can serve from file (same path as detached agents).
    const pipedOutPath = sessionOutputPath(sessionId);
    try { writeFileSync(pipedOutPath, ""); } catch { /* ignore */ }

    proc.stdout?.on("data", (chunk: Buffer) => {
      try {
        const data = chunk.toString();
        try { appendFileSync(pipedOutPath, data); } catch { /* ignore */ }
        onOutput({ type: "stdout", sessionId, data });
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
  }

  proc.on("exit", (code, signal) => {
    console.log(`[agent] exited: sessionId=${sessionId} code=${code} signal=${signal ?? "none"} pid=${proc.pid}`);
    agentState.activeProcesses.delete(sessionId);
    agentState.activePids.delete(sessionId);
    agentState.stdinOpen.delete(sessionId);
    // Close watchers but keep the .out file for post-session replay
    const watcher = agentState.outputWatchers.get(sessionId);
    if (watcher) { watcher.close(); agentState.outputWatchers.delete(sessionId); }
    const pidW = agentState.pidWatchers.get(sessionId);
    if (pidW) { pidW.close(); agentState.pidWatchers.delete(sessionId); }
    // Drain any captured stderr (detached agents) and surface it BEFORE the exit event,
    // so a process that died with zero stdout but a stderr reason is no longer an invisible
    // "0-token zombie" (#779). Emitted as a stderr event so it lands in session_messages and
    // the launch-failure handler can attribute the crash.
    if (shouldDetach) drainCapturedStderr(sessionId, onOutput);
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
    agentState.activeProcesses.delete(sessionId);
    agentState.activePids.delete(sessionId);
    const watcher = agentState.outputWatchers.get(sessionId);
    if (watcher) { watcher.close(); agentState.outputWatchers.delete(sessionId); }
    const pidW = agentState.pidWatchers.get(sessionId);
    if (pidW) { pidW.close(); agentState.pidWatchers.delete(sessionId); }
    try {
      onOutput({ type: "exit", sessionId, exitCode: 1 });
    } catch (cbErr) {
      console.error(`[agent] error-exit callback error: sessionId=${sessionId}`, cbErr);
    }
  });

  return proc;
}

/** Delete the output file for a session. */
function cleanupOutputFile(sessionId: string): void {
  const outPath = sessionOutputPath(sessionId);
  try { unlinkSync(outPath); } catch { /* already gone */ }
}

/** Kill a running agent process by session ID. */
export function kill(sessionId: string): boolean {
  const proc = agentState.activeProcesses.get(sessionId);
  const pid = proc?.pid ?? agentState.activePids.get(sessionId);
  if (!pid) return false;

  console.log(`[agent] killing: sessionId=${sessionId} pid=${pid}`);
  const killed = killPid(pid, { reason: "agent-session-stop", sessionId });

  agentState.activeProcesses.delete(sessionId);
  agentState.activePids.delete(sessionId);
  agentState.stdinOpen.delete(sessionId);
  const watcher = agentState.outputWatchers.get(sessionId);
  if (watcher) { watcher.close(); agentState.outputWatchers.delete(sessionId); }
  const pidW = agentState.pidWatchers.get(sessionId);
  if (pidW) { pidW.close(); agentState.pidWatchers.delete(sessionId); }
  cleanupOutputFile(sessionId);
  return killed;
}

/** Send a follow-up message to a running agent via stdin JSONL. */
export function sendInput(sessionId: string, content: string): boolean {
  const proc = agentState.activeProcesses.get(sessionId);
  if (!proc || !proc.stdin || proc.stdin.destroyed) return false;
  if (!agentState.stdinOpen.has(sessionId)) return false;
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
  const proc = agentState.activeProcesses.get(sessionId);
  if (!proc || !proc.stdin || proc.stdin.destroyed) return false;
  proc.stdin.end();
  agentState.stdinOpen.delete(sessionId);
  return true;
}

/** Check if stdin is open for a session (multi-turn mode). */
export function isStdinOpen(sessionId: string): boolean {
  return agentState.stdinOpen.get(sessionId) === true;
}

/** Kill all active agent processes (for graceful shutdown). */
export function killAll(): number {
  const count = agentState.activePids.size;
  if (count === 0) return 0;
  console.log(`[agent] killAll: terminating ${count} active process(es)`);
  for (const [sessionId, pid] of agentState.activePids) {
    console.log(`[agent] killAll: sessionId=${sessionId} pid=${pid}`);
    killPid(pid, { reason: "agent-kill-all", sessionId });
  }
  agentState.activeProcesses.clear();
  agentState.activePids.clear();
  agentState.stdinOpen.clear();
  for (const watcher of agentState.outputWatchers.values()) watcher.close();
  agentState.outputWatchers.clear();
  for (const w of agentState.pidWatchers.values()) w.close();
  agentState.pidWatchers.clear();
  return count;
}

/** Get the active process for a session, if any. */
export function getProcess(sessionId: string): ChildProcess | undefined {
  return agentState.activeProcesses.get(sessionId);
}

/** Register a persisted PID for a surviving process whose ChildProcess handle was lost. */
export function registerPid(sessionId: string, pid: number): void {
  auditProcessEvent({ action: "agent-pid-registered", sessionId, pid });
  agentState.activePids.set(sessionId, pid);
}

/** Get the tracked PID for a session, whether or not a ChildProcess handle exists. */
export function getPid(sessionId: string): number | undefined {
  return agentState.activeProcesses.get(sessionId)?.pid ?? agentState.activePids.get(sessionId);
}

/** Check if the tracked PID still exists without requiring a ChildProcess handle. */
export function isPidAlive(sessionId: string): boolean {
  const pid = getPid(sessionId);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means the process exists but we lack permission to signal it — treat as alive.
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    agentState.activePids.delete(sessionId);
    return false;
  }
}

/**
 * Reattach to a surviving agent process after server restart.
 * Starts watching the output file for new content and polls the PID for exit.
 */
export function reattachSession(
  sessionId: string,
  pid: number,
  onOutput: AgentOutputCallback,
  onExit: () => void,
): void {
  agentState.activePids.set(sessionId, pid);

  // Resume streaming the output file from its current end. The file may have
  // rolled away (temp cleanup) between runs — recreate it so the watcher has
  // something to poll and any future agent output still has a sink.
  const outPath = sessionOutputPath(sessionId);
  let startOffset = 0;
  if (!existsSync(outPath)) {
    try {
      writeFileSync(outPath, "");
      console.warn(`[agent] reattach: output file missing, recreated: ${outPath}`);
    } catch (err) {
      console.warn(`[agent] reattach: could not recreate output file ${outPath}`, err);
    }
  } else {
    try {
      startOffset = statSync(outPath).size;
    } catch {
      startOffset = 0;
    }
  }
  try {
    const watcher = startOutputFileWatcher(sessionId, outPath, onOutput, startOffset);
    agentState.outputWatchers.set(sessionId, watcher);
  } catch {
    console.warn(`[agent] failed to start output watcher for reattach: sessionId=${sessionId}`);
  }
  console.log(`[agent-service] reattached session ${sessionId} pid=${pid} output=${outPath}`);

  // Start PID exit monitoring
  const pidWatcher = startPidWatcher(sessionId, pid, () => {
    console.log(`[agent] reattached process exited: sessionId=${sessionId} pid=${pid}`);
    agentState.activePids.delete(sessionId);
    const w = agentState.outputWatchers.get(sessionId);
    if (w) { w.close(); agentState.outputWatchers.delete(sessionId); }
    // Keep the .out file for post-session replay
    try {
      onOutput({ type: "exit", sessionId, exitCode: null });
    } catch (err) {
      console.error(`[agent] reattach exit callback error: sessionId=${sessionId}`, err);
    }
    onExit();
  });
  agentState.pidWatchers.set(sessionId, pidWatcher);
}
