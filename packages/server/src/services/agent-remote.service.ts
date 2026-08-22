import type { AgentLaunchRequest } from "./agent-dispatch.service.js";
import { resolveEffectivePrompt } from "./agent-provider/context-files-prompt.js";
import { buildRemoteLaunchSpec } from "./remote-launch-spec.js";
import { buildRemoteContextFiles } from "./remote-context-files.js";
// Remote agent execution over a fleet worker's WebSocket (epic #1, phase 1c #5).
//
// Implements the AgentExecutionService seam (phase 0): `launch` builds the SAME
// provider launch config the host path builds, but instead of spawning it ships
// a serializable WorkerLaunchSpec to the placed worker as an `assign`. The
// worker streams back events shaped exactly like AgentOutputEvent, which are
// fed to the session's normal onOutput callback — so broadcast, DB persistence
// and exit classification run unchanged. Phase 1c is same-machine: the spec's
// cwd is the board-local worktree path.
//
// The spec env is an ALLOWLISTED projection of the host env (#244,
// lib/remote-spec-env.ts) — never a copy of the board's process.env and never
// the selected profile's credentials. The worker merges it over its OWN
// environment, so its local agent login and paths win (decision 012).
//
// Failure contract:
//  - assign not deliverable (worker vanished between placement and launch):
//    launch THROWS — the dispatch proxy catches and re-launches on the host.
//  - assign_failed from the worker: surfaced as stderr + exit(1) events, which
//    the exit state machine classifies as a launch failure.
//  - worker socket lost mid-session: the worker keeps the agent running, so the
//    board HOLDS. Past the reconnect grace the session is marked DETACHED and the
//    hold is reported into the transcript; it is finalized only when the abandon
//    bound (REMOTE_SESSION_ABANDON_MS) passes with no reconnect. A reconnect
//    re-adopts it. See the disconnect handler for why 60s of silence is not death
//    (#746).
//  - worker reconnects and no longer LISTS a session it was running: the exit can
//    never arrive (the worker's pending-result queue is in-memory), so the session
//    is finalized — but only after any pushed result is landed. See onHello.

import { buildAgentLaunchConfig } from "./agent-provider.js";
import { resolveLaunchPorts, buildAgentSpawnEnv, resolveAgentHangTimeoutMs } from "../lib/agent-launch-env.js";
import { buildRemoteSpecEnv } from "../lib/remote-spec-env.js";
import { resolveWorktreeDevPorts } from "./worktree-ports.js";
import { db as realDb } from "../db/index.js";
import type { Database } from "../db/index.js";
import { updateSessionWorkerId, getSessionLiveness } from "../repositories/worker.repository.js";
import type { AgentExecutionService, AgentHandle } from "./agent-dispatch.service.js";
import type { AgentOutputCallback } from "./agent.service.js";
import type { WorkerConnectionManager } from "./worker-connection.service.js";
import { ensureGitHttpServer } from "./git-http.service.js";
import { syncIncomingBranch, clearIncomingRef, incomingRefFor } from "./worker-remote-sync.service.js";
import { listAgentSkills } from "../repositories/agent-skill.repository.js";
import { REMOTE_SESSION_ABANDON_MS } from "./remote-session-liveness.js";
import { WORKER_HEARTBEAT_STALE_MS } from "./worker-registry.service.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * How long a disconnected worker may be silent before the board REPORTS the gap.
 *
 * Was 60s, and expiry FAILED every session on that worker with a synthesized
 * exit(1) while the agent was still running there — confirmed live. 60s is shorter
 * than the worker daemon's own supervisor backoff (up to 30s) plus a reconnect, and
 * shorter than the board's own `WORKER_HEARTBEAT_STALE_MS` (90s) window for calling
 * a worker offline: the board gave up before its own definition of "offline" had
 * even triggered. Two heartbeat windows is the shortest defensible value (#746).
 *
 * Expiry no longer finalizes anything — it marks the session detached and says so.
 */
export const WORKER_RECONNECT_GRACE_MS = 2 * WORKER_HEARTBEAT_STALE_MS;

interface RemoteSession {
  workerId: string;
  onOutput: AgentOutputCallback;
  stdinOpen: boolean;
  /** Set for git-transport sessions: sync the pushed branch back before exit. */
  repo?: { repoPath: string; branch: string };
  /**
   * Epoch ms at which the board stopped being able to see this session (the
   * reconnect grace expired). Non-null means DETACHED: held, reported, not
   * finalized. Cleared on reconnect.
   */
  detachedSinceMs?: number;
}

/**
 * The remote execution service. A superset of `AgentExecutionService`: a remote
 * session outlives the board process, so it also needs to be ADOPTED back (#745).
 */
export interface RemoteAgentService extends AgentExecutionService {
  adoptSession(params: {
    sessionId: string;
    workerId: string;
    onOutput: AgentOutputCallback;
    repo?: { repoPath: string; branch: string };
  }): void;
  /** Session ids this process currently tracks (live or detached). */
  trackedSessionIds(): string[];
}

export function createRemoteAgentService(
  manager: WorkerConnectionManager,
  database: Database = realDb,
  opts?: { reconnectGraceMs?: number; abandonMs?: number },
): RemoteAgentService {
  const sessions = new Map<string, RemoteSession>();
  const disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const abandonTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const graceMs = opts?.reconnectGraceMs ?? WORKER_RECONNECT_GRACE_MS;
  const abandonMs = Math.max(opts?.abandonMs ?? REMOTE_SESSION_ABANDON_MS, graceMs);

  function finishSession(sessionId: string, session: RemoteSession, stderr: string, exitCode: number | null): void {
    sessions.delete(sessionId);
    try {
      session.onOutput({ type: "stderr", sessionId, data: stderr });
      session.onOutput({ type: "exit", sessionId, exitCode });
    } catch (err) {
      console.error(`[agent-remote] output callback error: sessionId=${sessionId}`, err);
    }
  }

  /**
   * Land whatever the worker pushed, then finalize. Used by the normal exit path AND
   * by every give-up path (#746): a session the board stops waiting for may still
   * have PUSHED its result, and orphaning that work in the incoming ref is the most
   * expensive possible outcome. Landing goes through the #743 path
   * (`syncIncomingBranch`) — never a second, private one.
   *
   * A sync failure downgrades the exit code, so a session whose work did not land is
   * never recorded as a clean success.
   */
  async function landAndFinish(
    sessionId: string,
    session: RemoteSession,
    reportedExitCode: number | null,
  ): Promise<void> {
    sessions.delete(sessionId);
    let exitCode = reportedExitCode;
    if (session.repo) {
      try {
        const result = await syncIncomingBranch(session.repo.repoPath, session.repo.branch);
        if (result.ok) {
          console.log(`[agent-remote] synced ${session.repo.branch} (${result.status}) for session ${sessionId}`);
          await clearIncomingRef(session.repo.repoPath, session.repo.branch).catch(() => {});
        } else if (result.status === "missing" && exitCode !== 0) {
          // The agent failed before producing anything to push — nothing to sync.
          console.warn(`[agent-remote] no incoming ref for failed session ${sessionId}; nothing to sync`);
        } else {
          session.onOutput({
            type: "stderr",
            sessionId,
            data: `Worker result could not be landed on ${session.repo.branch}: ${result.error}`,
          });
          exitCode = exitCode === 0 || exitCode === null ? 1 : exitCode;
        }
      } catch (err) {
        session.onOutput({ type: "stderr", sessionId, data: `Branch sync failed: ${errorMessage(err)}` });
        exitCode = exitCode === 0 || exitCode === null ? 1 : exitCode;
      }
    }
    try {
      session.onOutput({ type: "exit", sessionId, exitCode });
    } catch (err) {
      console.error(`[agent-remote] exit callback error: sessionId=${sessionId}`, err);
    }
  }

  /** Report into the session's own transcript, so a hold is visible where the run is. */
  function report(sessionId: string, session: RemoteSession, text: string): void {
    try {
      session.onOutput({ type: "stderr", sessionId, data: text });
    } catch (err) {
      console.error(`[agent-remote] output callback error: sessionId=${sessionId}`, err);
    }
  }

  function clearWorkerTimers(workerId: string): void {
    const grace = disconnectTimers.get(workerId);
    if (grace) { clearTimeout(grace); disconnectTimers.delete(workerId); }
    const abandon = abandonTimers.get(workerId);
    if (abandon) { clearTimeout(abandon); abandonTimers.delete(workerId); }
  }

  manager.onMessage((workerId, message) => {
    if (message.type === "event") {
      const session = sessions.get(message.event.sessionId);
      if (!session || session.workerId !== workerId) return;
      if (message.event.type !== "exit") {
        try {
          session.onOutput(message.event);
        } catch (err) {
          console.error(`[agent-remote] output callback error: sessionId=${message.event.sessionId}`, err);
        }
        return;
      }
      // Exit: for a git-transport session the worker has already pushed to the
      // incoming ref, so land it on the real branch BEFORE the board's exit
      // handling runs — review/merge must never see a branch that has not
      // arrived. A sync failure downgrades the exit code so a session whose
      // work did not land is never recorded as a clean success.
      const sessionId = message.event.sessionId;
      const exitEvent = message.event;
      sessions.delete(sessionId);
      if (!session.repo) {
        try {
          session.onOutput(exitEvent);
        } catch (err) {
          console.error(`[agent-remote] output callback error: sessionId=${sessionId}`, err);
        }
        return;
      }
      void landAndFinish(sessionId, session, exitEvent.exitCode ?? null);
      return;
    }
    if (message.type === "hello") {
      // A worker that reconnects after a board restart announces sessions this
      // process has no memory of. The original rule stopped all of them, on the
      // assumption that the startup sweep had already finalized their rows and the
      // agents were therefore unreachable zombies.
      //
      // That assumption is not always true, and when it is wrong the cost is high.
      // Observed: a board restart mid-run, the worker reconnected 54s later, and the
      // board answered its hello by killing an agent that had been working for 65
      // seconds — silently, from the board's side. The kill also pre-empted the
      // push, so the work was not recoverable from the incoming ref either.
      //
      // So ask the DB instead of assuming. A row that is still `running` on THIS
      // worker is sanctioned work in progress: leave it alone. It finishes, pushes
      // to its incoming ref, and the startup sweep lands it — the recovery path
      // decision 012 already specifies. Only a session the board has genuinely
      // finished with (terminal row, or no row at all) is the zombie the stop was
      // written for.
      //
      // NOTE: leaving it running is not the same as adopting it — but adoption now
      // exists (#745). `startup/remote-session-readoption.ts` runs before the pid
      // sweep and rebuilds the output callback for every session this board left on a
      // worker, so in the normal restart case a hello arrives AFTER adoption and this
      // branch is not even reached. It still is when the board never held the row
      // (adopted by a different board, or a row that predates the sweep), and there
      // the old rule stands: leave it alone, and let the incoming-ref sweep land it.
      // The REVERSE direction (#746): the board tracks a session on THIS worker that
      // the worker's own hello does not list. Genuinely ambiguous — the daemon may
      // have restarted (its children killed) or crashed (children orphaned, their
      // pipes gone either way).
      //
      // DECIDED: finalize it, after landing anything it pushed. A hello is POSITIVE
      // information — the daemon is up and has enumerated what it holds — and the
      // exit can no longer reach us in ANY of the branches: the worker's
      // pending-result queue is in-memory (`PENDING_QUEUE_CAP`, lost on daemon
      // restart) and the pipe to an orphaned child died with the old daemon. So
      // holding here would hang the workspace forever, which is the bug this ticket
      // names. It exits non-zero even when the branch landed cleanly: the board never
      // saw the agent's own verdict, and recording an unobserved run as a clean
      // success is the one outcome worse than a visible failure.
      const listed = new Set(message.runningSessionIds);
      const lost = [...sessions.entries()].filter(([id, sess]) => sess.workerId === workerId && !listed.has(id));
      for (const [sessionId, session] of lost) {
        console.warn(
          `[agent-remote] worker ${workerId} reconnected but no longer lists session ${sessionId} ` +
            `(daemon restart or crash); its exit can never arrive — landing any pushed result and failing it`,
        );
        report(
          sessionId,
          session,
          `Fleet worker ${workerId} reconnected without this session: its agent is gone and no exit can ` +
            `arrive (the worker's pending-result queue does not survive a daemon restart). Any result it ` +
            `pushed is being landed on the branch before this session is closed.`,
        );
        void landAndFinish(sessionId, session, 1);
      }

      const unknown = message.runningSessionIds.filter((id) => !sessions.has(id));
      if (unknown.length === 0) return;
      void (async () => {
        for (const sessionId of unknown) {
          let live: { status: string; workerId: string | null } | null = null;
          try {
            live = await getSessionLiveness(sessionId, database);
          } catch (err) {
            // Fail SAFE: if we cannot tell, do not kill. A stray agent is cheaper
            // than destroying work we were unable to ask about.
            console.error(
              `[agent-remote] could not check session ${sessionId} reported by worker ${workerId}; leaving it running`,
              err,
            );
            continue;
          }
          if (live && live.status === "running" && live.workerId === workerId) {
            console.warn(
              `[agent-remote] worker ${workerId} reports session ${sessionId}, which this process does not track ` +
                `but the DB still has running on that worker — leaving it alone. Its output is not being streamed; ` +
                `its result will land from the incoming ref on the next startup sweep.`,
            );
            continue;
          }
          const why = !live ? "no session row" : `row is ${live.status}` + (live.workerId === workerId ? "" : " on another worker");
          console.warn(
            `[agent-remote] worker ${workerId} reports unknown session ${sessionId} (${why}); stopping the orphan`,
          );
          manager.send(workerId, { type: "stop", sessionId });
        }
      })();
      return;
    }
    if (message.type === "assign_failed") {
      const session = sessions.get(message.sessionId);
      if (!session || session.workerId !== workerId) return;
      console.warn(`[agent-remote] assign failed on worker ${workerId}: ${message.error}`);
      finishSession(message.sessionId, session, `Worker could not start the agent: ${message.error}`, 1);
    }
  });

  // A lost socket is a lost VIEW, not a dead agent (#746). The old rule synthesized
  // exit(1) for every session on the worker after 60s — destroying a run the worker was
  // still executing, and pre-empting its push. So the gap has two bounds and they mean
  // different things:
  //
  //   graceMs   -> REPORT. The session is marked DETACHED and the hold is written into
  //                its own transcript. Nothing is finalized; a reconnect re-adopts it.
  //   abandonMs -> GIVE UP. Only now is the session finalized, and only after landing
  //                anything the worker managed to push.
  manager.onDisconnect((workerId) => {
    const affected = [...sessions.entries()].filter(([, s]) => s.workerId === workerId);
    if (affected.length === 0) return;
    console.warn(
      `[agent-remote] worker ${workerId} disconnected with ${affected.length} session(s); ` +
      `holding — reporting at ${Math.round(graceMs / 1000)}s, giving up at ${Math.round(abandonMs / 60000)}m`,
    );
    clearWorkerTimers(workerId);

    const graceTimer = setTimeout(() => {
      disconnectTimers.delete(workerId);
      const detachedAt = Date.now();
      for (const [sessionId, session] of sessions.entries()) {
        if (session.workerId !== workerId) continue;
        session.detachedSinceMs = detachedAt;
        console.warn(
          `[agent-remote] worker ${workerId} has not reconnected in ${Math.round(graceMs / 1000)}s; ` +
            `session ${sessionId} is DETACHED (held, not failed) until ${Math.round(abandonMs / 60000)}m`,
        );
        report(
          sessionId,
          session,
          `Lost the connection to fleet worker ${workerId} ${Math.round(graceMs / 1000)}s ago. The agent is ` +
            `most likely still running there; the board simply cannot see it, so live output is dropped from ` +
            `here on. This session is HELD, not failed — it resumes if the worker reconnects within ` +
            `${Math.round(abandonMs / 60000)} minutes.`,
        );
      }
    }, graceMs);
    if (graceTimer.unref) graceTimer.unref();
    disconnectTimers.set(workerId, graceTimer);

    const abandonTimer = setTimeout(() => {
      abandonTimers.delete(workerId);
      for (const [sessionId, session] of [...sessions.entries()]) {
        if (session.workerId !== workerId) continue;
        console.error(
          `[agent-remote] worker ${workerId} silent for ${Math.round(abandonMs / 60000)}m; abandoning session ${sessionId}`,
        );
        report(
          sessionId,
          session,
          `Fleet worker ${workerId} has been unreachable for ${Math.round(abandonMs / 60000)} minutes. Giving ` +
            `up on this session. If the worker pushed a result before it vanished it is being landed on the ` +
            `branch now; otherwise its work remains only in the worker's own clone.`,
        );
        void landAndFinish(sessionId, session, 1);
      }
    }, abandonMs);
    if (abandonTimer.unref) abandonTimer.unref();
    abandonTimers.set(workerId, abandonTimer);
  });

  manager.onConnect((workerId) => {
    const held = disconnectTimers.has(workerId) || abandonTimers.has(workerId);
    clearWorkerTimers(workerId);
    if (!held) return;
    const readopted: string[] = [];
    for (const [sessionId, session] of sessions.entries()) {
      if (session.workerId !== workerId) continue;
      if (session.detachedSinceMs !== undefined) readopted.push(sessionId);
      session.detachedSinceMs = undefined;
    }
    if (readopted.length === 0) {
      console.log(`[agent-remote] worker ${workerId} reconnected within grace; sessions continue`);
      return;
    }
    console.log(
      `[agent-remote] worker ${workerId} reconnected; re-adopting detached session(s) ${readopted.join(", ")} — ` +
        `their callbacks were never torn down, so streaming resumes`,
    );
    for (const sessionId of readopted) {
      const session = sessions.get(sessionId);
      if (session) report(sessionId, session, `Fleet worker ${workerId} reconnected; this session is live again.`);
    }
  });

  function launch(request: AgentLaunchRequest): AgentHandle {
    // #524: one object instead of twenty positional parameters. `_containerProvision`
    // stays unread here — a remote worker provisions its own environment — and that is
    // now visible as an unused FIELD rather than a placeholder in argument position 19.
    const {
      worktreePath, sessionId, prompt, agentArgs, onOutput,
      providerSessionId, agentCommand, keepAlive, permissionPromptTool,
      planMode, provider, profile, extraEnv, skipPermissions,
      model, contextFiles, systemInstructions, placement,
    } = request;
    if (placement?.kind !== "remote") {
      throw new Error("remote agent service requires a remote placement");
    }
    const workerId = placement.workerId;

    // #524: codex has no channel for contextFiles other than the prompt, and this path
    // used to send the raw one — so a codex builder on a fleet worker ran with NO ticket
    // context. Same helper the host uses, so the two cannot diverge again.
    const effectivePrompt = resolveEffectivePrompt(prompt, provider, contextFiles);
    const config = buildAgentLaunchConfig({
      agentArgs,
      providerSessionId,
      agentCommand,
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
    const devPorts = resolveWorktreeDevPorts(worktreePath);
    const ports = resolveLaunchPorts(
      process.env,
      devPorts ? { serverPort: String(devPorts.serverPort), clientPort: String(devPorts.clientPort) } : null,
    );
    const envWithUndefined = buildAgentSpawnEnv({
      spawnEnv: config.env,
      ports,
      serverPid: String(process.pid),
      protectedPidsEnv: process.env.KANBAN_PROTECTED_PIDS,
      sessionId,
      worktreePath,
      extraEnv,
    });
    // #244: a remote spec crosses a machine boundary, so it carries an ALLOWLISTED
    // projection of the host env — never the board's process.env or the selected
    // profile's credentials. The worker merges this over its own environment, so
    // its local login and paths win (decision 012).
    const env = buildRemoteSpecEnv({
      env: envWithUndefined,
      sharesFilesystem: !placement.repo,
      worktreePath,
    });
    const stdinPrompt = config.promptPrefix ? `${config.promptPrefix}\n\n${prompt}` : prompt;

    // #244's sibling, generalized in #747: the ENV is projected for a cross-machine spec,
    // but the COMMAND and ARGS were built for the BOARD's machine — an absolute
    // `claude.exe`, a `useShell` derived from the board's own platform, and args naming
    // board-host paths (`--mcp-config` in this machine's tmpdir, `--settings` in this
    // machine's home). A true-remote spec therefore carries INTENT and the worker resolves
    // its own executable; see remote-launch-spec.ts for the full rationale. A
    // same-filesystem worker keeps everything verbatim, exactly as it keeps host paths in
    // env.
    const isTrueRemote = Boolean(placement.repo);
    const spec = buildRemoteLaunchSpec({
      config,
      env,
      cwd: worktreePath,
      stdinPrompt,
      // Same policy as a host launch: mock agents are deterministic and
      // short-lived, everything else gets the silence watchdog.
      hangTimeoutMs: config.isMockAgent ? 0 : resolveAgentHangTimeoutMs(),
      provider,
      trueRemote: isTrueRemote,
      // An explicit agentCommand (or KANBAN_AGENT_COMMAND, which isMockAgent reflects) is
      // the operator's exact command, not a provider's platform guess — it travels as-is.
      explicitCommand: Boolean(agentCommand) || Boolean(config.isMockAgent),
    });

    // Same-machine dispatch (no repo in the placement): the worker shares this
    // filesystem, so assign directly. Git transport needs the git-http listener
    // and the skill payload, which are async — assign after they resolve, and
    // report a failure the way an unreachable worker would.
    if (!placement.repo) {
      if (!manager.send(workerId, { type: "assign", sessionId, spec })) {
        throw new Error(`fleet worker ${workerId} is not connected`);
      }
    } else {
      const repo = placement.repo;
      void (async () => {
        try {
          const git = await ensureGitHttpServer(database);
          const skillRows = await listAgentSkills(repo.projectId, false, database).catch(() => []);
          const incomingRef = incomingRefFor(repo.branch);
          // #247/#246: the token is scoped to THIS worker, THIS project and THIS
          // incoming ref — not a board-wide credential for every repo — and it is
          // dropped when the worker is revoked.
          const gitToken = git.issueToken({ workerId, projectId: repo.projectId, incomingRef });
          const delivered = manager.send(workerId, {
            type: "assign",
            sessionId,
            spec,
            repo: {
              projectId: repo.projectId,
              gitPort: git.port,
              gitToken,
              branch: repo.branch,
              baseBranch: repo.baseBranch,
              incomingRef,
              setupScript: repo.setupScript,
              // #749: the ticket-context file travels as CONTENT (the board's path names
              // nothing on the worker) and is retargeted for a machine with no board MCP.
              contextFiles: buildRemoteContextFiles(contextFiles),
              skills: skillRows
                .filter((s) => typeof s.prompt === "string" && s.prompt.trim().length > 0)
                .map((s) => ({ name: s.name, description: s.description ?? "", content: s.prompt })),
            },
          });
          if (!delivered) throw new Error(`fleet worker ${workerId} is not connected`);
          console.log(`[agent-remote] git-transport assignment sent: sessionId=${sessionId} branch=${repo.branch}`);
        } catch (err) {
          const message = errorMessage(err);
          console.error(`[agent-remote] git-transport assignment failed: sessionId=${sessionId}: ${message}`);
          const session = sessions.get(sessionId);
          if (session) finishSession(sessionId, session, `Could not dispatch to worker: ${message}`, 1);
        }
      })();
    }
    console.log(`[agent-remote] assigned session ${sessionId} to worker ${workerId} (command=${config.command})`);
    sessions.set(sessionId, {
      workerId,
      onOutput,
      stdinOpen: Boolean(config.keepStdinOpen && !config.suppressStdinPrompt),
      repo: placement.repo ? { repoPath: placement.repo.repoPath, branch: placement.repo.branch } : undefined,
    });
    updateSessionWorkerId(sessionId, workerId, database)
      .catch((err) => console.error(`[agent-remote] failed to stamp session workerId: sessionId=${sessionId}`, err));
    return {};
  }

  function kill(sessionId: string): boolean {
    const session = sessions.get(sessionId);
    if (!session) return false;
    // The exit event from the worker finalizes the session; if the worker is
    // gone the disconnect grace path does. Either way the mapping stays until
    // an exit arrives so late output is not misrouted.
    return manager.send(session.workerId, { type: "stop", sessionId });
  }

  function sendInput(sessionId: string, content: string): boolean {
    const session = sessions.get(sessionId);
    if (!session || !session.stdinOpen) return false;
    return manager.send(session.workerId, {
      type: "input",
      sessionId,
      data: JSON.stringify({ type: "user", content }),
    });
  }

  function closeStdin(sessionId: string): boolean {
    const session = sessions.get(sessionId);
    if (!session) return false;
    session.stdinOpen = false;
    return manager.send(session.workerId, { type: "close_stdin", sessionId });
  }

  function isStdinOpen(sessionId: string): boolean {
    return sessions.get(sessionId)?.stdinOpen === true;
  }

  function getProcess(sessionId: string): AgentHandle | undefined {
    return sessions.has(sessionId) ? {} : undefined;
  }

  function getPid(_sessionId: string): number | undefined {
    return undefined;
  }

  /**
   * #746: this used to require a live socket, so a detached session read as DEAD and
   * the session-lifecycle's stale-session cleanup finalized it out from under a
   * running agent. While the board still TRACKS a session it has no evidence of
   * death: a missing socket is a missing view. The abandon timer is what ends a held
   * session, deliberately and with a reason.
   */
  function isPidAlive(sessionId: string): boolean {
    return sessions.has(sessionId);
  }

  /**
   * Re-adopt a session this process did not launch — the board restarted while the
   * worker kept running the agent (#745). Rebuilding the mapping is what makes the
   * worker's next event (and its exit) land through the NORMAL path, instead of being
   * dropped as "a session we do not track".
   */
  function adoptSession(params: {
    sessionId: string;
    workerId: string;
    onOutput: AgentOutputCallback;
    repo?: { repoPath: string; branch: string };
  }): void {
    if (sessions.has(params.sessionId)) return;
    sessions.set(params.sessionId, {
      workerId: params.workerId,
      onOutput: params.onOutput,
      // Stdin state does not survive a restart; a follow-up turn must relaunch.
      stdinOpen: false,
      repo: params.repo,
    });
    console.log(
      `[agent-remote] adopted session ${params.sessionId} on worker ${params.workerId} after a board restart`,
    );
  }

  function trackedSessionIds(): string[] {
    return [...sessions.keys()];
  }

  return {
    launch, kill, sendInput, closeStdin, isStdinOpen, getProcess, getPid, isPidAlive,
    adoptSession, trackedSessionIds,
  };
}
