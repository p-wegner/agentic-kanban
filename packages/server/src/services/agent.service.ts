import { resolveEffectivePrompt } from "./agent-provider/context-files-prompt.js";
import { spawn, type ChildProcess } from "node:child_process";
import { openSync, closeSync, readSync, statSync, unlinkSync, existsSync, writeFileSync, readFileSync, appendFileSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { buildAgentLaunchConfig, narrowProviderName, type ProviderId, type ProviderName } from "./agent-provider.js";
import { warnIfCliVersionRisky } from "./agent-cli-version.service.js";
import { sessionOutputPath, sessionErrorPath } from "../lib/session-paths.js";
import { guardProcessKill, auditProcessEvent } from "./process-guard.js";
import { resolveWorktreeDevPorts as resolveWorktreeDevPortsShared } from "./worktree-ports.js";
import {
  shouldDetachAgent,
  resolveLaunchPorts,
  buildAgentSpawnEnv,
  resolveAgentHangTimeoutMs,
  startHangWatchdog as startSharedHangWatchdog,
  DEFAULT_AGENT_HANG_TIMEOUT_MS as SHARED_DEFAULT_HANG_TIMEOUT_MS,
} from "../lib/agent-launch-env.js";
import { sanitizeUtf8 } from "@agentic-kanban/shared/lib/sanitize-utf8";
import { wrapLaunchConfigForContainer } from "./agent-provider/container-wrap.js";
import type { ContainerProvision } from "./devcontainer-workspace.service.js";
import { dockerExec } from "@agentic-kanban/shared/lib/docker-exec";

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
 * Re-exported from lib/agent-launch-env, which owns the policy so the fleet
 * worker resolves the identical timeout (a remote session must not silently
 * lose the hang protection its host twin has).
 */
export const DEFAULT_AGENT_HANG_TIMEOUT_MS = SHARED_DEFAULT_HANG_TIMEOUT_MS;

/** Encapsulates all runtime state for active agent processes. Injectable for testing. */
export class AgentState {
  readonly activeProcesses = new Map<string, ChildProcess>();
  readonly activePids = new Map<string, number>();
  /**
   * The devcontainer a session's agent runs inside, keyed by sessionId (#154).
   * `activePids` only tracks the HOST docker-exec client — killing that pid
   * never reaches the exec'd process inside the container's own PID
   * namespace, which is what orphaned it in the first place. Populated at
   * launch when a `ContainerProvision` is passed in, and restored on reattach
   * from the session row's persisted `containerId`.
   */
  readonly containerIds = new Map<string, string>();
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
    this.containerIds.clear();
    this.stdinOpen.clear();
  }
}

/** Module-level singleton used by all exported functions. */
export const agentState = new AgentState();

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
 * Terminate the agent running INSIDE a container (#154).
 *
 * The host-side `killPid()` above only reaches the `docker exec` CLIENT — the
 * exec'd agent process lives in the container's own PID namespace and is not
 * in that process tree, so killing the client orphans it: invisible (output
 * conduit severed, board says "stopped"), still able to edit the bind-mounted
 * worktree while review/merge proceeds. `docker kill` sends SIGKILL to the
 * container's PID 1, which tears down every process in its namespace,
 * including the exec'd one — a single call that doesn't require tracking the
 * inner PID. Fire-and-forget: the docker CLI is a real executable so this
 * never blocks the synchronous `kill()`/`killAll()` callers, and a failure
 * here is logged, never thrown (matches the rest of the devcontainer
 * best-effort contract).
 */
function killContainerAgent(sessionId: string, containerId: string): void {
  console.log(`[agent] killing containerized agent: sessionId=${sessionId} containerId=${containerId.slice(0, 12)}`);
  void dockerExec(["kill", containerId]).then((result) => {
    if (result.code !== 0) {
      console.warn(
        `[agent] docker kill failed: sessionId=${sessionId} containerId=${containerId.slice(0, 12)}: ${result.stderr.trim() || result.error}`,
      );
    }
  });
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
    // The container itself is NOT reaped here — it may be reused by a follow-up
    // turn/resume — only this session's in-memory tracking entry goes away.
    agentState.containerIds.delete(sessionId);
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
    agentState.containerIds.delete(sessionId);
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
  /**
   * When present the agent runs INSIDE this provisioned devcontainer instead of
   * on the host. Provisioning is async and happens in the caller; this function
   * stays synchronous. Absent = normal host execution.
   */
  containerProvision?: ContainerProvision,
): ChildProcess {
  // #524: shared with the remote path, which used to skip this entirely.
  const effectivePrompt = resolveEffectivePrompt(prompt, provider, contextFiles);
  const hostLaunchConfig = buildAgentLaunchConfig({
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
  const ports = resolveLaunchPorts(process.env, resolveWorktreeDevPorts(worktreePath));
  // Converge the two env pipelines (#167): compute the FULL child env (provider
  // base env + ports + protected pids + session markers + extraEnv) BEFORE
  // containerization, so the wrap's `-e` allowlist is derived from the same env
  // the host process would have received — not just the provider's base env
  // computed earlier. Previously ports/extraEnv/session vars were layered on
  // AFTER the wrap and landed only on the host `docker exec` client, never
  // inside the container.
  const fullEnvWithUndefined = buildAgentSpawnEnv({
    spawnEnv: hostLaunchConfig.env,
    ports,
    serverPid: String(process.pid),
    protectedPidsEnv: process.env.KANBAN_PROTECTED_PIDS,
    sessionId,
    worktreePath,
    extraEnv,
  });
  const fullEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(fullEnvWithUndefined)) {
    if (value !== undefined) fullEnv[key] = value;
  }
  const hostLaunchConfigWithFullEnv = { ...hostLaunchConfig, env: fullEnv };
  // Containerization is a transformation of the finished launch config, so every
  // provider is containerizable without knowing it exists. Mock agents run
  // in-process on the host and are never containerized.
  const launchConfig = containerProvision && !hostLaunchConfig.isMockAgent
    ? wrapLaunchConfigForContainer(hostLaunchConfigWithFullEnv, containerProvision)
    : hostLaunchConfigWithFullEnv;
  const { command, args, useShell, env: spawnEnv, promptPrefix, suppressStdinPrompt, keepStdinOpen, isMockAgent } = launchConfig;
  const stdinPrompt = promptPrefix ? `${promptPrefix}\n\n${effectivePrompt}` : effectivePrompt;

  // Spawn-layer hang watchdog: reset on every output event; fire on prolonged
  // silence. Disabled for the mock agent (deterministic, short-lived) so tests
  // aren't held open. The wrapped callback below feeds resets.
  const hangTimeoutMs = isMockAgent ? 0 : resolveAgentHangTimeoutMs();
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
  //
  // Checked against the PRE-WRAP command (#167): for a containerized launch,
  // `command` is `docker` — version-checking that tells us nothing about the
  // agent CLI running inside the container. The un-wrapped command is always
  // the real agent binary regardless of where it executes.
  if (!isMockAgent) {
    void warnIfCliVersionRisky(narrowProviderName(provider), hostLaunchConfig.command, {
      // Below-min is ACTIONABLE (the user must upgrade the CLI), not just one
      // warn among many (review §2.2 / ticket #20). Surface it with the launch
      // context this spawn site has — sessionId + worktree — so it is traceable
      // to a specific launch rather than a bare, context-free console line.
      onActionable: (_result, actionability) => {
        console.error(
          `[agent] launch used an unsupported ${provider ?? "agent"} CLI (sessionId=${sessionId} worktree=${worktreePath}): ${actionability.message} — upgrade the CLI; hard-coded launch flags may not work.`,
        );
      },
    });
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
    // `spawnEnv` is already the full converged env computed above, pre-wrap
    // (ports + protected pids + session markers + extraEnv) — for a host launch
    // that's the whole child env; for a containerized launch it's `{}` since the
    // wrap moved everything into the docker-exec `-e` flags baked into `args`.
    env: spawnEnv,
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

  // Keep stdin open ONLY when the PROVIDER says it can do multi-turn over an open stdin
  // (launchConfig.keepStdinOpen) — never on the caller's raw keepAlive intent. Real claude
  // launches with `-p` and reads its prompt from stdin until EOF, so a keepAlive=true
  // reconciler launch (fix-and-merge/resolve-conflicts/reconcile) that left stdin OPEN made
  // claude.exe wait on stdin forever and emit ZERO output — the recurring reconciler hang
  // (#104). The provider returns keepStdinOpen=false for real claude and true only for the
  // mock multi-turn agent, so honoring it closes stdin for claude (write-and-close → EOF →
  // it streams) while preserving mock multi-turn. Matches server CLAUDE.md "Re-chat and
  // agent stdout": always stdin.end(prompt) for real claude, never write-and-leave-open.
  writeInitialStdin(proc, sessionId, suppressStdinPrompt, keepStdinOpen, stdinPrompt);

  agentState.activeProcesses.set(sessionId, proc);
  if (proc.pid) {
    agentState.activePids.set(sessionId, proc.pid);
  }
  // Track the container this session runs inside (#154) so kill()/killAll() can
  // reach the in-container agent, not just the host docker-exec client tracked above.
  if (containerProvision) {
    agentState.containerIds.set(sessionId, containerProvision.handle.containerId);
  }

  // Arm the hang watchdog. On a hang we surface a diagnostic stderr (so the
  // launch-failure classifier has a reason to attribute) and kill the process —
  // the kill drives the normal exit path, which finalizes the session. Independent
  // of the out-of-process monitor.
  if (hangTimeoutMs > 0) {
    const watchdog = startSharedHangWatchdog(`sessionId=${sessionId}`, hangTimeoutMs, () => {
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
  const containerId = agentState.containerIds.get(sessionId);
  if (!pid && !containerId) return false;

  let killed = false;
  if (pid) {
    console.log(`[agent] killing: sessionId=${sessionId} pid=${pid}`);
    killed = killPid(pid, { reason: "agent-session-stop", sessionId });
  }
  // The container leg (#154): the host pid above is only the docker-exec CLIENT
  // for a containerized session — without this the exec'd agent inside the
  // container keeps running, orphaned and invisible, after the board reports
  // "stopped".
  if (containerId) killContainerAgent(sessionId, containerId);

  agentState.activeProcesses.delete(sessionId);
  agentState.activePids.delete(sessionId);
  agentState.containerIds.delete(sessionId);
  agentState.stdinOpen.delete(sessionId);
  const watcher = agentState.outputWatchers.get(sessionId);
  if (watcher) { watcher.close(); agentState.outputWatchers.delete(sessionId); }
  const pidW = agentState.pidWatchers.get(sessionId);
  if (pidW) { pidW.close(); agentState.pidWatchers.delete(sessionId); }
  const hangW = agentState.hangWatchdogs.get(sessionId);
  if (hangW) { hangW.close(); agentState.hangWatchdogs.delete(sessionId); }
  cleanupOutputFile(sessionId);
  return killed || Boolean(containerId);
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
  const containerEntries = [...agentState.containerIds.entries()];
  if (count === 0 && containerEntries.length === 0) return 0;
  console.log(
    `[agent] killAll: terminating ${count} active process(es)` +
      (containerEntries.length > 0 ? ` (${containerEntries.length} containerized)` : ""),
  );
  for (const [sessionId, pid] of agentState.activePids) {
    console.log(`[agent] killAll: sessionId=${sessionId} pid=${pid}`);
    killPid(pid, { reason: "agent-kill-all", sessionId });
  }
  // The container leg (#154) — see kill()'s comment for why the host pid above
  // isn't enough for a containerized session.
  for (const [sessionId, containerId] of containerEntries) {
    killContainerAgent(sessionId, containerId);
  }
  agentState.activeProcesses.clear();
  agentState.activePids.clear();
  agentState.containerIds.clear();
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
 *
 * `containerId` restores the in-memory tracking `kill()`/`killAll()` need for a
 * containerized session (#154) — without it, a session reattached after a
 * restart would lose its container leg and a later stop would re-introduce the
 * exact orphaned-container leak this ticket fixes, just delayed by a restart.
 */
export function reattachSession(
  sessionId: string,
  pid: number,
  onOutput: AgentOutputCallback,
  onExit: () => void,
  containerId?: string,
): void {
  agentState.activePids.set(sessionId, pid);
  if (containerId) agentState.containerIds.set(sessionId, containerId);

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
