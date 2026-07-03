import { spawn, type ChildProcess } from "node:child_process";
import { openSync, closeSync, readSync, statSync, unlinkSync, existsSync, writeFileSync, readFileSync, appendFileSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { buildAgentLaunchConfig, narrowProviderName, type ProviderId, type ProviderName } from "./agent-provider.js";
import { warnIfCliVersionRisky } from "./agent-cli-version.service.js";
import { sessionOutputPath, sessionErrorPath } from "../lib/session-paths.js";
import { guardProcessKill, auditProcessEvent } from "./process-guard.js";
import { resolveWorktreeDevPorts as resolveWorktreeDevPortsShared } from "./worktree-ports.js";
import { shouldDetachAgent, resolveLaunchPorts, buildAgentSpawnEnv } from "../lib/agent-launch-env.js";
import { sanitizeUtf8 } from "@agentic-kanban/shared/lib/sanitize-utf8";

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

/**
 * Spawn-layer hang watchdog timeout. If a launched agent produces NO stdout/stderr
 * activity for this long, the watchdog kills it — a hang at the spawn layer
 * (provider deadlocked on a prompt, stuck on a network call, waiting on stdin that
 * was never closed) used to be invisible to the server and was punted entirely to
 * the out-of-process monitor's ~30-min cycle. This catches it directly, independent
 * of any monitor. Resets on every output event; only fires on true silence.
 * Override with KANBAN_AGENT_HANG_TIMEOUT_MS (0 disables).
 */
export const DEFAULT_AGENT_HANG_TIMEOUT_MS = 15 * 60 * 1000;

function resolveHangTimeoutMs(): number {
  const raw = process.env.KANBAN_AGENT_HANG_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_AGENT_HANG_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_AGENT_HANG_TIMEOUT_MS;
  return parsed;
}

/** Encapsulates all runtime state for active agent processes. Injectable for testing. */
export class AgentState {
  readonly activeProcesses = new Map<string, ChildProcess>();
  readonly activePids = new Map<string, number>();
  readonly stdinOpen = new Map<string, boolean>();
  readonly outputWatchers = new Map<string, { close(): void; drainNow(): void }>();
  readonly pidWatchers = new Map<string, { close(): void }>();
  /** Per-session inactivity watchdogs: { reset(), close() } keyed by sessionId. */
  readonly hangWatchdogs = new Map<string, { reset(): void; close(): void }>();

  /** Close all watchers and clear all state without killing processes. Intended for test cleanup. */
  reset(): void {
    for (const watcher of this.outputWatchers.values()) watcher.close();
    this.outputWatchers.clear();
    for (const w of this.pidWatchers.values()) w.close();
    this.pidWatchers.clear();
    for (const wd of this.hangWatchdogs.values()) wd.close();
    this.hangWatchdogs.clear();
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

function materializedSkillFiles(worktreePath: string): string[] {
  const skillsDir = join(worktreePath, ".claude", "skills");
  let entries: Dirent[];
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory() && !/[\\/]/.test(entry.name) && entry.name !== "." && entry.name !== "..")
    .map((entry) => join(skillsDir, entry.name, "SKILL.md"))
    .filter((skillPath) => existsSync(skillPath));
}

function piExtensionFiles(worktreePath: string): string[] {
  const extensionPath = join(worktreePath, ".pi", "plugin", "agentic-kanban-hooks.ts");
  return existsSync(extensionPath) ? [extensionPath] : [];
}

// sessionOutputPath / sessionErrorPath moved to ../lib/session-paths.ts (re-imported above)
// so the persistence layer can share them without a repository -> service import.

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

/**
 * Watch a session output file for new content and feed it to onOutput.
 *
 * Returns a `drainNow()` in addition to `close()`. `drainNow()` runs the same
 * read-from-offset-to-EOF logic the 500ms poll uses, but synchronously and on
 * demand. The exit handler calls it once before emitting the exit event so the
 * final chunk a fast-crashing detached agent wrote within the last poll interval
 * is applied BEFORE launch-failure classification reads `hadSubstantiveOutput`
 * — closing the exit-before-output race that misclassified real runs as
 * zero-output launch failures (the recurring "~1s, 0 tokens = launch-failed").
 */
function startOutputFileWatcher(
  sessionId: string,
  filePath: string,
  onOutput: AgentOutputCallback,
  startOffset = 0,
): { close(): void; drainNow(): void } {
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
          const data = sanitizeUtf8(buf.toString());
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
    // Final, synchronous drain to EOF. Tolerates being called after close() — it
    // bypasses the `closed` guard so the exit handler can flush the tail even
    // though it closes the watcher in the same teardown.
    drainNow() {
      const wasClosed = closed;
      closed = false;
      try {
        poll();
      } finally {
        closed = wasClosed;
      }
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
 * Start a per-session inactivity watchdog. After `timeoutMs` of NO reset() call
 * (i.e. no agent output), `onHang` fires once. The caller resets it on every
 * output event, so it only fires on genuine silence. timeoutMs <= 0 disables it
 * (returns inert handles).
 */
function startHangWatchdog(
  sessionId: string,
  timeoutMs: number,
  onHang: () => void,
): { reset(): void; close(): void } {
  if (timeoutMs <= 0) {
    return { reset() {}, close() {} };
  }
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let fired = false;
  const arm = () => {
    if (closed) return;
    timer = setTimeout(() => {
      if (closed || fired) return;
      fired = true;
      try {
        onHang();
      } catch (err) {
        console.error(`[agent] hang-watchdog callback error: sessionId=${sessionId}`, err);
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

/** Close + forget this session's output/pid/hang watchers (shared by the exit/error handlers). */
function closeSessionWatchers(sessionId: string): void {
  const watcher = agentState.outputWatchers.get(sessionId);
  if (watcher) { watcher.close(); agentState.outputWatchers.delete(sessionId); }
  const pidW = agentState.pidWatchers.get(sessionId);
  if (pidW) { pidW.close(); agentState.pidWatchers.delete(sessionId); }
  const hangW = agentState.hangWatchdogs.get(sessionId);
  if (hangW) { hangW.close(); agentState.hangWatchdogs.delete(sessionId); }
}

/**
 * Send the initial prompt to the child's stdin. suppressStdinPrompt (prompt passed
 * via argv) closes stdin; keepAlive (multi-turn) keeps it open for follow-ups;
 * otherwise write-and-close — on Windows claude.exe buffers stdout until stdin closes.
 */
function writeInitialStdin(
  proc: ChildProcess,
  sessionId: string,
  suppressStdinPrompt: boolean | undefined,
  keepAlive: boolean | undefined,
  stdinPrompt: string,
): void {
  if (suppressStdinPrompt) {
    proc.stdin?.end();
  } else if (keepAlive) {
    proc.stdin?.write(stdinPrompt + "\n");
    agentState.stdinOpen.set(sessionId, true);
  } else {
    proc.stdin?.end(stdinPrompt + "\n");
  }
}

/**
 * Wire up child output: detached agents are read via a watcher on the .out file
 * (survives server restarts); attached agents read stdout/stderr pipes directly and
 * mirror stdout to the .out file so replay serves from the same path.
 */
function setupChildOutput(
  proc: ChildProcess,
  sessionId: string,
  shouldDetach: boolean,
  onOutput: AgentOutputCallback,
): void {
  if (shouldDetach) {
    const outPath = sessionOutputPath(sessionId);
    const watcher = startOutputFileWatcher(sessionId, outPath, onOutput);
    agentState.outputWatchers.set(sessionId, watcher);
    return;
  }
  const pipedOutPath = sessionOutputPath(sessionId);
  try { writeFileSync(pipedOutPath, ""); } catch { /* ignore */ }

  proc.stdout?.on("data", (chunk: Buffer) => {
    try {
      const data = sanitizeUtf8(chunk.toString());
      try { appendFileSync(pipedOutPath, data); } catch { /* ignore */ }
      onOutput({ type: "stdout", sessionId, data });
    } catch (err) {
      console.error(`[agent] stdout callback error: sessionId=${sessionId}`, err);
    }
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    try {
      onOutput({ type: "stderr", sessionId, data: sanitizeUtf8(chunk.toString()) });
    } catch (err) {
      console.error(`[agent] stderr callback error: sessionId=${sessionId}`, err);
    }
  });
}

/** Attach exit/error handlers that clear runtime state, drain stderr, and emit the exit event. */
function attachProcessHandlers(
  proc: ChildProcess,
  sessionId: string,
  shouldDetach: boolean,
  onOutput: AgentOutputCallback,
): void {
  proc.on("exit", (code, signal) => {
    console.log(`[agent] exited: sessionId=${sessionId} code=${code} signal=${signal ?? "none"} pid=${proc.pid}`);
    agentState.activeProcesses.delete(sessionId);
    agentState.activePids.delete(sessionId);
    agentState.stdinOpen.delete(sessionId);
    // Detached agents stream stdout via a 500ms file poll. A fast crash that writes
    // output and exits within one poll interval fires this exit handler before the
    // poll flushed the tail — so do one explicit final drain to EOF here (an "all
    // output applied" barrier) BEFORE closing the watcher and emitting exit. Without
    // it the last chunk is lost and a real run is misclassified as a zero-output
    // launch failure (#909).
    if (shouldDetach) {
      const outputWatcher = agentState.outputWatchers.get(sessionId);
      try { outputWatcher?.drainNow(); } catch (err) {
        console.error(`[agent] final output drain error: sessionId=${sessionId}`, err);
      }
    }
    closeSessionWatchers(sessionId);
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
    closeSessionWatchers(sessionId);
    try {
      onOutput({ type: "exit", sessionId, exitCode: 1 });
    } catch (cbErr) {
      console.error(`[agent] error-exit callback error: sessionId=${sessionId}`, cbErr);
    }
  });
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
    piExtensionPaths: provider === "pi" ? piExtensionFiles(worktreePath) : undefined,
    piSkillPaths: provider === "pi" ? materializedSkillFiles(worktreePath) : undefined,
    skipPermissions,
  });
  const { command, args, useShell, env: spawnEnv, promptPrefix, suppressStdinPrompt, isMockAgent } = launchConfig;
  const stdinPrompt = promptPrefix ? `${promptPrefix}\n\n${effectivePrompt}` : effectivePrompt;
  const ports = resolveLaunchPorts(process.env, resolveWorktreeDevPorts(worktreePath));

  // Spawn-layer hang watchdog: reset on every output event; fire on prolonged
  // silence. Disabled for the mock agent (deterministic, short-lived) so tests
  // aren't held open. The wrapped callback below feeds resets.
  const hangTimeoutMs = isMockAgent ? 0 : resolveHangTimeoutMs();
  const onOutputWithWatchdog: AgentOutputCallback = (event) => {
    const wd = agentState.hangWatchdogs.get(sessionId);
    if (wd) wd.reset();
    onOutput(event);
  };

  console.log(`[agent] launching: command=${command} provider=${provider ?? "auto"} worktree=${worktreePath} sessionId=${sessionId} resume=${providerSessionId ?? "none"}`);

  // CLI version guard on the ACTUAL launch path (#956): the provider CLIs resolve
  // by bare name from PATH and auto-update, so a breaking release used to pass
  // every check until preflight happened to run. Fire-and-forget + TTL-cached
  // (one `--version` subprocess per provider:command per 30 min), warn-only —
  // never blocks or delays the spawn. Mock agents are not third-party CLIs.
  if (!isMockAgent) {
    void warnIfCliVersionRisky(narrowProviderName(provider), command);
  }

  // Agents that don't need a shell can be detached — they survive tsx watch hot-reloads.
  // shell: true on Windows is used by mock agents and Codex (.cmd shim) — detaching those
  // breaks stdout pipes, so they stay attached (sacrificing hot-reload survival for output).
  const shouldDetach = shouldDetachAgent(useShell, process.platform);

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
    env: buildAgentSpawnEnv({
      spawnEnv,
      ports,
      serverPid: String(process.pid),
      protectedPidsEnv: process.env.KANBAN_PROTECTED_PIDS,
      sessionId,
      extraEnv,
    }),
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
  writeInitialStdin(proc, sessionId, suppressStdinPrompt, keepAlive, stdinPrompt);

  agentState.activeProcesses.set(sessionId, proc);
  if (proc.pid) {
    agentState.activePids.set(sessionId, proc.pid);
  }

  // Arm the hang watchdog. On a hang we surface a diagnostic stderr (so the
  // launch-failure classifier has a reason to attribute) and kill the process —
  // the kill drives the normal exit path, which finalizes the session. Independent
  // of the out-of-process monitor.
  if (hangTimeoutMs > 0) {
    const watchdog = startHangWatchdog(sessionId, hangTimeoutMs, () => {
      console.warn(`[agent] hang watchdog fired: sessionId=${sessionId} pid=${proc.pid} — no output for ${Math.round(hangTimeoutMs / 1000)}s; killing`);
      try {
        onOutput({
          type: "stderr",
          sessionId,
          data: `Agent hang watchdog: no output for ${Math.round(hangTimeoutMs / 1000)}s — process killed at the spawn layer.`,
        });
      } catch (err) {
        console.error(`[agent] hang-watchdog stderr emit error: sessionId=${sessionId}`, err);
      }
      kill(sessionId);
    });
    agentState.hangWatchdogs.set(sessionId, watchdog);
  }

  setupChildOutput(proc, sessionId, shouldDetach, onOutputWithWatchdog);
  attachProcessHandlers(proc, sessionId, shouldDetach, onOutputWithWatchdog);

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
  const hangW = agentState.hangWatchdogs.get(sessionId);
  if (hangW) { hangW.close(); agentState.hangWatchdogs.delete(sessionId); }
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
  for (const wd of agentState.hangWatchdogs.values()) wd.close();
  agentState.hangWatchdogs.clear();
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
    // Final drain to EOF before closing the watcher and emitting exit — the PID poll is
    // 5s, so a reattached agent that wrote its tail and died between polls would otherwise
    // lose that output to the same exit-before-output race the live exit handler closes (#909).
    if (w) {
      try { w.drainNow(); } catch (err) {
        console.error(`[agent] reattach final output drain error: sessionId=${sessionId}`, err);
      }
      w.close();
      agentState.outputWatchers.delete(sessionId);
    }
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
