// Launch-side leaves of the remote agent service (#1345 decomposition) — see
// agent-remote.service.ts. Two pieces, both lifted verbatim out of `launch`:
//  - `buildRemoteAssignSpec`: the SYNCHRONOUS half, request -> provider launch config -> the
//    serializable spec the worker is assigned. Pure of service state.
//  - `dispatchGitTransportAssignment`: the ASYNC half for a git-transport placement, which
//    resolves the git-http listener, scoped token, skills and board-tool bridge before it can
//    send the `assign`.
import type { AgentLaunchRequest, DeferredLaunchFailure } from "./agent-dispatch.service.js";
import type { Database } from "../db/index.js";
import { resolveEffectivePrompt } from "./agent-provider/context-files-prompt.js";
import { buildRemoteLaunchSpec } from "./remote-launch-spec.js";
import { announceRemoteBridgeInBrief, buildRemoteContextFiles, withTicketContextFile } from "./remote-context-files.js";
import {
  REMOTE_BOARD_TOOLS,
  buildRemoteMcpConfigFile,
  providerNeedsMcpTokenEnv,
  providerSupportsRemoteMcp,
  remoteMcpConfigArgs,
  type getFleetMcpBridge,
} from "./fleet-mcp-bridge.service.js";
import { buildAgentLaunchConfig, narrowProviderName } from "./agent-provider.js";
import { resolveLaunchPorts, buildAgentSpawnEnv, resolveAgentHangTimeoutMs } from "../lib/agent-launch-env.js";
import { buildRemoteSpecEnv } from "../lib/remote-spec-env.js";
import { resolveWorktreeDevPorts } from "./worktree-ports.js";
import { listAgentSkills } from "../repositories/agent-skill.repository.js";
import { getSessionLiveness } from "../repositories/worker.repository.js";
import { ensureGitHttpServer } from "./git-http.service.js";
import { incomingRefFor } from "./worker-remote-sync.service.js";
import { resolveProjectCommitterIdentity } from "./project-committer-identity.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { WorkerConnectionManager } from "./worker-connection.service.js";
import type { RemoteSession } from "./agent-remote.types.js";

type Placement = Extract<NonNullable<AgentLaunchRequest["placement"]>, { kind: "remote" }>;
type BuiltConfig = ReturnType<typeof buildAgentLaunchConfig>;
export type RemoteAssignSpec = ReturnType<typeof buildRemoteLaunchSpec>;

export function buildRemoteAssignSpec(
  request: AgentLaunchRequest,
  placement: Placement,
): { config: BuiltConfig; spec: RemoteAssignSpec } {
  const {
    worktreePath, sessionId, prompt, agentArgs,
    providerSessionId, agentCommand, keepAlive, permissionPromptTool,
    planMode, provider, profile, extraEnv, skipPermissions,
    model, systemInstructions, builderContext,
  } = request;
  // #1407: the ticket brief ships whatever the launch prompt was (see withTicketContextFile).
  const contextFiles = placement.repo ? withTicketContextFile(request.contextFiles, worktreePath) : request.contextFiles;
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
    builderContext,
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
  const spec = buildRemoteLaunchSpec({
    config,
    env,
    cwd: worktreePath,
    stdinPrompt,
    // Same policy as a host launch: mock agents are deterministic and
    // short-lived, everything else gets the silence watchdog.
    hangTimeoutMs: config.isMockAgent ? 0 : resolveAgentHangTimeoutMs(),
    provider,
    // #1027: the roster-selected profile the placement pinned, by NAME. The worker
    // resolves it locally and rejects the assign if it cannot — which is what makes a
    // profile restriction enforceable on a machine holding none of the board's logins.
    ...(placement.profile?.name ? { profileName: placement.profile.name } : {}),
    trueRemote: Boolean(placement.repo),
    // An explicit agentCommand (or KANBAN_AGENT_COMMAND, which isMockAgent reflects) is
    // the operator's exact command, not a provider's platform guess — it travels as-is.
    explicitCommand: Boolean(agentCommand) || Boolean(config.isMockAgent),
  });
  return { config, spec };
}

export interface GitTransportAssignmentDeps {
  manager: WorkerConnectionManager;
  database: Database;
  sessions: Map<string, RemoteSession>;
  fleetMcp: ReturnType<typeof getFleetMcpBridge>;
  request: AgentLaunchRequest;
  workerId: string;
  repo: NonNullable<Placement["repo"]>;
  spec: RemoteAssignSpec;
  noteAssigned: (sessionId: string, workerId: string, detail: Record<string, unknown>) => void;
  finishSession: (sessionId: string, session: RemoteSession, stderr: string, exitCode: number | null) => void;
  onDeferredLaunchFailure?: (failure: DeferredLaunchFailure) => void;
  /** True once the board has killed this session while its assign was still being prepared (#1407). */
  isCancelled?: () => boolean;
}

/**
 * Has the board already ended this session (#1407)? The assign is built asynchronously, so a
 * session reconciled or stopped in that gap would otherwise still be handed to a worker, which
 * would run it, hold a slot, and push a stale result. Fails OPEN on an unreadable row: a stray
 * agent is cheaper than a launch that never happens.
 */
async function sessionAlreadyEnded(deps: GitTransportAssignmentDeps): Promise<boolean> {
  if (deps.isCancelled?.()) return true;
  try {
    const live = await getSessionLiveness(deps.request.sessionId, deps.database);
    return live !== null && live.status !== "running";
  } catch {
    return false;
  }
}

/** Git transport needs the git-http listener and the skill payload, which are async — assign after they resolve. */
export async function dispatchGitTransportAssignment(deps: GitTransportAssignmentDeps): Promise<void> {
  const { manager, database, sessions, fleetMcp, request, workerId, repo, spec, noteAssigned, finishSession, onDeferredLaunchFailure } = deps;
  const { sessionId, provider } = request;
  const contextFiles = withTicketContextFile(request.contextFiles, request.worktreePath);
  try {
    const git = await ensureGitHttpServer(database);
    const skillRows = await listAgentSkills(repo.projectId, false, database).catch(() => []);
    if (await sessionAlreadyEnded(deps)) {
      console.warn(`[agent-remote] session ${sessionId} ended before its assign was sent; not assigning it to worker ${workerId} (#1407)`);
      sessions.delete(sessionId);
      return;
    }
    const incomingRef = incomingRefFor(repo.branch);
    // #247/#246: the token is scoped to THIS worker, THIS project and THIS
    // incoming ref — not a board-wide credential for every repo — and it is
    // dropped when the worker is revoked. #1407: and to THIS session, so a session the
    // board has since superseded cannot push over its successor's result.
    const gitToken = git.issueToken({ workerId, projectId: repo.projectId, incomingRef, sessionId });
    // #769: board TOOLS for a remote builder — the second half of #749. A per-assignment
    // token on the fleet listener's allowlisted MCP bridge, delivered as a config file in
    // the checkout (never in argv, where a process listing would show it) plus the provider
    // flag that loads it. Same scoping rules as the git token above: one worker, one
    // project, one session; expiring; dropped on revoke and when the session ends.
    const remoteContextFiles = buildRemoteContextFiles(contextFiles);
    const mcpArgs: string[] = [];
    const mcpAssignment = providerSupportsRemoteMcp(provider)
      ? fleetMcp.prepareAssignment({ workerId, projectId: repo.projectId, sessionId })
      : null;
    // #799 — codex takes its config through argv (`-c mcp_servers...`) and its TOKEN
    // through the worker's own environment, so it gets no config file and instead sets
    // `boardMcpToken` below. claude/copilot keep the file channel #769 built.
    const mcpTokenViaEnv = mcpAssignment !== null && providerNeedsMcpTokenEnv(provider);
    if (mcpAssignment) {
      if (!mcpTokenViaEnv) remoteContextFiles.push(buildRemoteMcpConfigFile(mcpAssignment));
      mcpArgs.push(...remoteMcpConfigArgs(provider, { url: mcpAssignment.url }));
      // The brief was retargeted to "no board tools here" while it was read (#749). That is
      // now false for this assignment, so the section is rewritten to name the tools that
      // actually work — instructions that describe the wrong environment are how an agent
      // wastes a session.
      await announceRemoteBridgeInBrief(remoteContextFiles, REMOTE_BOARD_TOOLS, repo.projectId, sessionId, database);
    } else {
      console.log(
        `[agent-remote] no board MCP bridge for session ${sessionId} ` +
          `(provider=${provider ?? "claude"} -> ${narrowProviderName(provider)}, fleet listener ${fleetMcp.endpointPort() === null ? "not running" : "up"}) — ` +
          "the worker's brief keeps saying it has no board tools",
      );
    }
    // #1369: the board checkout's identity, so a worker with no global one can still commit.
    const committer = await resolveProjectCommitterIdentity(repo.repoPath);
    const delivered = manager.send(workerId, {
      type: "assign",
      sessionId,
      spec: mcpArgs.length > 0 ? { ...spec, args: [...spec.args, ...mcpArgs] } : spec,
      repo: {
        projectId: repo.projectId,
        gitPort: git.port,
        gitToken,
        branch: repo.branch,
        baseBranch: repo.baseBranch,
        incomingRef,
        setupScript: repo.setupScript,
        ...(committer ? { committer } : {}),
        // #749: the ticket-context file travels as CONTENT (the board's path names
        // nothing on the worker) and is retargeted for a machine with no board MCP.
        // #769 appends the MCP config file to the same channel when a bridge is offered.
        contextFiles: remoteContextFiles,
        ...(mcpTokenViaEnv && mcpAssignment ? { boardMcpToken: mcpAssignment.token } : {}),
        skills: skillRows
          .filter((s) => typeof s.prompt === "string" && s.prompt.trim().length > 0)
          .map((s) => ({ name: s.name, description: s.description ?? "", content: s.prompt })),
      },
    });
    if (!delivered) throw new Error(`fleet worker ${workerId} is not connected`);
    noteAssigned(sessionId, workerId, {
      transport: "git",
      branch: repo.branch,
      baseBranch: repo.baseBranch,
      projectId: repo.projectId,
      boardTools: mcpAssignment !== null,
    });
    console.log(`[agent-remote] git-transport assignment sent: sessionId=${sessionId} branch=${repo.branch}`);
  } catch (err) {
    const message = errorMessage(err);
    console.error(`[agent-remote] git-transport assignment failed: sessionId=${sessionId}: ${message}`);
    // This path CANNOT throw to the dispatch proxy — `launch` returned before the
    // git-http listener, skill payload and scoped token resolved. Reporting it as
    // a deferred launch failure is what restores the #245 contract here: a
    // non-strict project gets its host run instead of a failed session (#751).
    if (onDeferredLaunchFailure) {
      sessions.delete(sessionId);
      onDeferredLaunchFailure({ kind: "dispatch", reason: message });
      return;
    }
    const session = sessions.get(sessionId);
    if (session) finishSession(sessionId, session, `Could not dispatch to worker: ${message}`, 1);
  }
}
