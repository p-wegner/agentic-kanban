// Board-initiated repo operations on a live remote session (#783, #784), lifted out of
// createRemoteAgentService (#1345). Owns the in-flight request table; the service routes
// `repo_op_result` messages here and exposes `requestRepoOp` unchanged.
import type { WorkerRepoOpKind } from "@agentic-kanban/shared/lib/worker-protocol";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { Database } from "../db/index.js";
import { getProjectByRepoPath } from "../repositories/project.repository.js";
import { ensureGitHttpServer } from "./git-http.service.js";
import { incomingRefFor } from "./worker-remote-sync.service.js";
import type { WorkerConnectionManager } from "./worker-connection.service.js";
import type { RemoteSession, RemoteSessionRepo, RemoteRepoOpOutcome } from "./agent-remote.types.js";

/**
 * How long the board waits for a worker's answer to a repo operation (#783).
 *
 * A fetch + fast-forward of one branch over the board's own git transport, so seconds in
 * the normal case; the ceiling exists for the worker that never answers at all (a build
 * that predates these messages drops them as unknown, exactly as this protocol module
 * intends). The refusal it produces names that possibility.
 */
export const REPO_OP_TIMEOUT_MS = 60 * 1000;

export function createRemoteRepoOps(deps: {
  manager: WorkerConnectionManager;
  database: Database;
  sessions: Map<string, RemoteSession>;
}) {
  const { manager, database, sessions } = deps;
  /**
   * Repo operations awaiting a worker's answer, by `requestId` (#783, #784).
   *
   * Correlated by request rather than by session because a diff request and a pre-turn
   * sync can be in flight for the same session at the same time, and resolving the wrong
   * one would report a push as a sync.
   */
  const pendingRepoOps = new Map<
    string,
    { sessionId: string; op: WorkerRepoOpKind; settle: (outcome: RemoteRepoOpOutcome) => void }
  >();
  let repoOpSeq = 0;

  /**
   * The fresh, scoped git capability the worker needs for one repo operation (#783).
   *
   * Goes through the EXISTING `issueToken({workerId, projectId, incomingRef})` seam — the
   * same per-assignment scoping #247 established — rather than minting a wider credential
   * for the convenience of a mid-session call. Decision 012 is untouched: this is a git
   * capability for one ref, not an agent login.
   */
  async function resolveOpAuth(
    sessionId: string,
    session: RemoteSession,
    repo: RemoteSessionRepo,
  ): Promise<{ projectId: string; gitPort: number; gitToken: string; branch: string; incomingRef: string }> {
    // An ADOPTED session (#745) carries only the path, so the project is recovered from it
    // rather than guessed — git is the authority for the branch, the DB for the project.
    const projectId = repo.projectId ?? (await getProjectByRepoPath(repo.repoPath, database))?.id;
    if (!projectId) {
      throw new Error(
        `no project is registered at ${repo.repoPath}, so no scoped git token can be issued for session ${sessionId}`,
      );
    }
    const incomingRef = repo.incomingRef ?? incomingRefFor(repo.branch);
    const git = await ensureGitHttpServer(database);
    return {
      projectId,
      gitPort: git.port,
      gitToken: git.issueToken({ workerId: session.workerId, projectId, incomingRef }),
      branch: repo.branch,
      incomingRef,
    };
  }

  async function requestRepoOp(
    sessionId: string,
    op: WorkerRepoOpKind,
    opts?: { timeoutMs?: number },
  ): Promise<RemoteRepoOpOutcome> {
    const session = sessions.get(sessionId);
    if (!session) {
      return {
        ok: false,
        status: "not-tracked",
        error: `this board process does not track session ${sessionId} as remote`,
      };
    }
    if (!session.repo) {
      return {
        ok: false,
        status: "not-tracked",
        error: `session ${sessionId} runs on a filesystem-sharing worker, which has no checkout of its own`,
      };
    }
    let auth;
    try {
      auth = await resolveOpAuth(sessionId, session, session.repo);
    } catch (err) {
      return { ok: false, status: "error", error: errorMessage(err) };
    }
    const requestId = `${op}-${sessionId}-${++repoOpSeq}`;
    const timeoutMs = opts?.timeoutMs ?? REPO_OP_TIMEOUT_MS;
    return await new Promise<RemoteRepoOpOutcome>((resolve) => {
      let done = false;
      const settle = (outcome: RemoteRepoOpOutcome): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pendingRepoOps.delete(requestId);
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        settle({
          ok: false,
          status: "timeout",
          error:
            `fleet worker ${session.workerId} did not answer the ${op} request within ` +
            `${Math.round(timeoutMs / 1000)}s — it may be busy, unreachable, or a build that ` +
            `predates the sync_repo/push_head messages (such a worker drops them silently)`,
        });
      }, timeoutMs);
      if (timer.unref) timer.unref();
      pendingRepoOps.set(requestId, { sessionId, op, settle });
      const delivered = manager.send(session.workerId, {
        type: op === "sync" ? "sync_repo" : "push_head",
        sessionId,
        requestId,
        auth,
      });
      if (!delivered) {
        settle({
          ok: false,
          status: "undeliverable",
          error: `fleet worker ${session.workerId} is not connected, so its checkout cannot be reached`,
        });
      }
    });
  }

  /** A worker's `repo_op_result` message: settle the request it answers, if this process still has it. */
  function handleResult(workerId: string, result: { requestId: string; ok: boolean; status: string; sha?: string; error?: string }): void {
    const pending = pendingRepoOps.get(result.requestId);
    // An answer to a request this process never made (or already timed out) is dropped:
    // the caller has been told, and re-resolving would report a stale outcome as fresh.
    if (!pending) return;
    pendingRepoOps.delete(result.requestId);
    const { ok, status, sha, error } = result;
    pending.settle(
      ok
        ? ({ ok: true, status, ...(sha ? { sha } : {}) } as RemoteRepoOpOutcome)
        : ({
            ok: false,
            status,
            error: error ?? `worker ${workerId} refused the ${pending.op} with status ${status}`,
          } as RemoteRepoOpOutcome),
    );
  }

  return { requestRepoOp, handleResult };
}
