import type { AgentLaunchRequest } from "./agent-dispatch.service.js";
import { resolveEffectivePrompt } from "./agent-provider/context-files-prompt.js";
import { stripMcpConfigArgs } from "./agent-provider/container-wrap.js";
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
//  - worker socket lost mid-session: the worker keeps the agent running; if it
//    does not reconnect within the grace window, the session is finalized with
//    a synthesized stderr + exit(1) so it never hangs "running" forever.

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
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/** How long a disconnected worker may take to reconnect before its sessions are failed. */
export const WORKER_RECONNECT_GRACE_MS = 60 * 1000;

interface RemoteSession {
  workerId: string;
  onOutput: AgentOutputCallback;
  stdinOpen: boolean;
  /** Set for git-transport sessions: sync the pushed branch back before exit. */
  repo?: { repoPath: string; branch: string };
}

export function createRemoteAgentService(
  manager: WorkerConnectionManager,
  database: Database = realDb,
  opts?: { reconnectGraceMs?: number },
): AgentExecutionService {
  const sessions = new Map<string, RemoteSession>();
  const disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const graceMs = opts?.reconnectGraceMs ?? WORKER_RECONNECT_GRACE_MS;

  function finishSession(sessionId: string, session: RemoteSession, stderr: string, exitCode: number | null): void {
    sessions.delete(sessionId);
    try {
      session.onOutput({ type: "stderr", sessionId, data: stderr });
      session.onOutput({ type: "exit", sessionId, exitCode });
    } catch (err) {
      console.error(`[agent-remote] output callback error: sessionId=${sessionId}`, err);
    }
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
      void (async () => {
        let exitCode = exitEvent.exitCode ?? null;
        try {
          const result = await syncIncomingBranch(session.repo!.repoPath, session.repo!.branch);
          if (result.ok) {
            console.log(`[agent-remote] synced ${session.repo!.branch} (${result.status}) for session ${sessionId}`);
            await clearIncomingRef(session.repo!.repoPath, session.repo!.branch).catch(() => {});
          } else if (result.status === "missing" && exitCode !== 0) {
            // The agent failed before producing anything to push — nothing to sync.
            console.warn(`[agent-remote] no incoming ref for failed session ${sessionId}; nothing to sync`);
          } else {
            session.onOutput({
              type: "stderr",
              sessionId,
              data: `Worker result could not be landed on ${session.repo!.branch}: ${result.error}`,
            });
            exitCode = exitCode === 0 || exitCode === null ? 1 : exitCode;
          }
        } catch (err) {
          const text = errorMessage(err);
          session.onOutput({ type: "stderr", sessionId, data: `Branch sync failed: ${text}` });
          exitCode = exitCode === 0 || exitCode === null ? 1 : exitCode;
        }
        try {
          session.onOutput({ type: "exit", sessionId, exitCode });
        } catch (err) {
          console.error(`[agent-remote] exit callback error: sessionId=${sessionId}`, err);
        }
      })();
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
      // NOTE: leaving it running is not the same as adopting it. This process still
      // has no output callback for that session, so its streamed output is dropped
      // and its exit does not finalize the row here. Full adoption — rebuilding the
      // callback so the exit lands through the normal path — is the better fix and
      // is NOT implemented; this only stops the board destroying live work.
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

  manager.onDisconnect((workerId) => {
    const affected = [...sessions.entries()].filter(([, s]) => s.workerId === workerId);
    if (affected.length === 0) return;
    console.warn(
      `[agent-remote] worker ${workerId} disconnected with ${affected.length} session(s); ` +
      `waiting ${Math.round(graceMs / 1000)}s for reconnect`,
    );
    const timer = setTimeout(() => {
      disconnectTimers.delete(workerId);
      for (const [sessionId, session] of sessions.entries()) {
        if (session.workerId !== workerId) continue;
        console.error(`[agent-remote] worker ${workerId} did not reconnect; failing session ${sessionId}`);
        finishSession(
          sessionId,
          session,
          `Fleet worker ${workerId} disconnected and did not reconnect within ${Math.round(graceMs / 1000)}s.`,
          1,
        );
      }
    }, graceMs);
    if (timer.unref) timer.unref();
    disconnectTimers.set(workerId, timer);
  });

  manager.onConnect((workerId) => {
    const timer = disconnectTimers.get(workerId);
    if (timer) {
      clearTimeout(timer);
      disconnectTimers.delete(workerId);
      console.log(`[agent-remote] worker ${workerId} reconnected within grace; sessions continue`);
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

    // #244's sibling: the ENV is projected for a cross-machine spec, but the ARGS
    // were shipped verbatim — and they carry board-host paths too. `--mcp-config`
    // names a file in this machine's tmpdir, so a true remote worker died on
    // "Invalid MCP configuration: MCP config file not found" before running a single
    // turn. Shipping the file would not help: the MCP server it configures talks to
    // the board API, which is loopback-only by design and unreachable from there.
    // A same-filesystem worker keeps the arg, exactly as it keeps host paths in env.
    const isTrueRemote = Boolean(placement.repo);
    const specArgs = isTrueRemote ? stripMcpConfigArgs(config.args) : config.args;

    const spec = {
      command: config.command,
      args: specArgs,
      env,
      cwd: worktreePath,
      stdinPrompt,
      keepStdinOpen: config.keepStdinOpen,
      suppressStdinPrompt: config.suppressStdinPrompt,
      useShell: config.useShell,
      // Same policy as a host launch: mock agents are deterministic and
      // short-lived, everything else gets the silence watchdog.
      hangTimeoutMs: config.isMockAgent ? 0 : resolveAgentHangTimeoutMs(),
    };

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

  function isPidAlive(sessionId: string): boolean {
    const session = sessions.get(sessionId);
    return Boolean(session && manager.isConnected(session.workerId));
  }

  return { launch, kill, sendInput, closeStdin, isStdinOpen, getProcess, getPid, isPidAlive };
}
