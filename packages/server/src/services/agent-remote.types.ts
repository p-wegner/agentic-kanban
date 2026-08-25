// Type declarations for the remote agent service (#871 ceiling split) — see
// agent-remote.service.ts, which re-exports the public ones. Types only, no runtime code.
import type { WorkerRepoOpKind, WorkerRepoOpResult } from "@agentic-kanban/shared/lib/worker-protocol";
import type { AgentExecutionService, DeferredLaunchFailure } from "./agent-dispatch.service.js";
import type { AgentOutputCallback } from "./agent.service.js";

export interface RemoteSession {
  workerId: string;
  onOutput: AgentOutputCallback;
  stdinOpen: boolean;
  /** Set for git-transport sessions: sync the pushed branch back before exit. */
  repo?: RemoteSessionRepo;
  /**
   * The dispatch proxy's late-launch-failure hook (#751). Held per session because
   * `assign_failed` arrives on the manager's message channel, long after `launch`
   * returned, and a launch failure must reach the proxy's placement rule rather than
   * being flattened into an exit code here.
   */
  onDeferredLaunchFailure?: (failure: DeferredLaunchFailure) => void;
  /** Has this worker ever spoken about this session? Positive proof it took the assign. */
  observed?: boolean;
  /** A deferred "is this really lost?" re-check, armed by a hello inside the settle window. */
  lostCheckTimer?: ReturnType<typeof setTimeout>;
  /**
   * #887: the silence-after-assign probe. Holds the "ask now" timer before the question goes
   * out, then the "no answer" timer after it — one field, because the two never overlap.
   */
  probeTimer?: ReturnType<typeof setTimeout>;
  /** The in-flight probe's correlation id, so a stale answer is dropped rather than acted on. */
  probeRequestId?: string;
  /**
   * Epoch ms at which the board stopped being able to see this session (the
   * reconnect grace expired). Non-null means DETACHED: held, reported, not
   * finalized. Cleared on reconnect.
   */
  detachedSinceMs?: number;
}

/**
 * What the board knows about a git-transport session's repo.
 *
 * `projectId` was added for #783/#784: a mid-session repo operation needs a FRESH scoped
 * git token, and `issueToken` is scoped by project. It is optional because a session
 * ADOPTED after a board restart (#745) has only the path — see `resolveOpAuth`, which
 * recovers the project from `repoPath` rather than guessing.
 */
export interface RemoteSessionRepo {
  repoPath: string;
  branch: string;
  projectId?: string;
  incomingRef?: string;
}

/** How a board-initiated repo operation on a live remote session ended (#783, #784). */
export type RemoteRepoOpOutcome =
  | { ok: true; status: WorkerRepoOpResult["status"]; sha?: string }
  | { ok: false; status: WorkerRepoOpResult["status"] | "timeout" | "not-tracked" | "undeliverable"; error: string };

/**
 * The remote execution service. A superset of `AgentExecutionService`: a remote
 * session outlives the board process, so it also needs to be ADOPTED back (#745).
 */
export interface RemoteAgentService extends AgentExecutionService {
  adoptSession(params: {
    sessionId: string;
    workerId: string;
    onOutput: AgentOutputCallback;
    repo?: RemoteSessionRepo;
  }): void;
  /** Session ids this process currently tracks (live or detached). */
  trackedSessionIds(): string[];
  /**
   * What this process tracks about a session, for callers that must know whether it is
   * remote AND whether it runs over git transport before acting (#783, #784). A
   * filesystem-sharing worker has no `repo`: it works in the board's own worktree, so
   * there is nothing to sync and nothing to push.
   */
  remoteSessionInfo(sessionId: string): { workerId: string; repo?: RemoteSessionRepo } | undefined;
  /**
   * Every session this process is running over GIT TRANSPORT right now (#790).
   *
   * The board's copy of such a branch is the base tip until something lands the worker's
   * push, so any reader computing numbers from the board-side worktree is reading a zero
   * that is not the truth. This is the cheap, synchronous way to ASK — no git, no push, no
   * DB — which is what makes it usable from the board's hot per-card paths, where #784's
   * on-demand landing deliberately is not.
   *
   * Filesystem-sharing workers are absent by construction: they have no `repo`, because
   * they write into the board's own worktree and there is nothing unlanded.
   */
  remoteGitTransportSessions(): Array<{ sessionId: string; workerId: string; branch: string; repoPath: string }>;
  /**
   * Ask the worker to fast-forward its live checkout to the board's branch tip (#783) or
   * to push its current HEAD to the incoming ref (#784), and WAIT for the answer.
   *
   * Bounded: an unanswered request resolves `{ok:false, status:"timeout"}` rather than
   * hanging, because the caller refuses a turn on it.
   */
  requestRepoOp(
    sessionId: string,
    op: WorkerRepoOpKind,
    opts?: { timeoutMs?: number },
  ): Promise<RemoteRepoOpOutcome>;
  /**
   * Always implemented here (#900) — narrows the optional signature on
   * {@link AgentExecutionService}, which leaves it optional only because a HOST
   * implementation has no worker to ask. The remote implementation always has one.
   */
  probeStdinIdle(sessionId: string): Promise<{ ok: true; stdinOpen: boolean } | { ok: false; reason: string }>;
}

