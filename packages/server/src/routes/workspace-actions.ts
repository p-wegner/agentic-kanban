import { createHash } from "node:crypto";
import type { SessionManager } from "../services/session.manager.js";
import type { BoardEventSink } from "../services/board-events.js";
import type { Database } from "../db/index.js";
import { createWorkspaceService } from "../services/workspace.service.js";
import { createWorkspaceServicesControlService } from "../services/workspace-services-control.service.js";
import { createBisectService, type BisectScope } from "../services/bisect.service.js";
import { createSessionArtifactsService } from "../services/session-artifacts.service.js";
import { getWorkspaceTimeline } from "../services/workspace-timeline.service.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody, parseOptionalJsonBody } from "../middleware/parse-body.js";
import {
  workspaceTurnBody, rejectPlanBody, createWorkspaceCommentBody,
  updateWorkspaceCommentBody, resolveWorkspaceCommentBody,
} from "./workspace-action-body-schemas.js";
import { completeMergeJob, failMergeJob, getMergeJob, startMergeJob } from "../services/merge-job.service.js";
import { describePersistedGateVerdict } from "../services/workspace-merge-gate.js";

import { queryFlag } from "../middleware/query-params.js";
import { ConflictError, UnprocessableError } from "../errors/index.js";
import { findRunningSession } from "../repositories/session.repository.js";
import { getWorkerFleet } from "../services/worker-fleet.service.js";
import { probeRemoteSessionLiveness } from "../services/fleet-liveness-probe.js";
import {
  gateRemoteTurn,
  landRemoteMidSessionWork,
  type MidSessionLanding,
  type ProbeLiveness,
  type RemoteRepoOpPort,
} from "../services/worker-remote-sync.service.js";

/**
 * How often the board will ask a worker to push its mid-session HEAD for ONE workspace
 * (#784).
 *
 * The landing is on demand, but "on demand" includes a dashboard polling `?stats=1` every
 * few seconds, and each ask is a real `git push` plus a fast-forward of the board's
 * worktree. Inside this window the previous landing is reported again WITH ITS AGE, which
 * is the honest answer and the one the ticket asks for: never present a stale mid-session
 * ref as current without saying how old it is.
 */
export const MID_SESSION_LAND_MIN_INTERVAL_MS = 15_000;

export function createWorkspaceActionsRoute(
  getSessionManager: () => SessionManager,
  database: Database,
  options?: {
    boardEvents?: BoardEventSink;
    fixAndMergeSessionIds?: Set<string>;
    /**
     * The fleet seam for #783/#784, injected for tests. Production resolves it from the
     * worker-fleet facade below; a test passes a fake worker so the refusal contract can be
     * exercised without a WebSocket, a git listener or a second machine.
     */
    remoteFleet?: { ops: RemoteRepoOpPort; probeLiveness: ProbeLiveness };
  },
) {
  const router = createRouter();

  /**
   * The remote-session collaborators, or null when this process has no fleet at all.
   *
   * The cast is the same one `startup/remote-session-readoption.ts` makes: the facade types
   * its member as the narrow `AgentExecutionService`, while the remote implementation is a
   * documented superset. `RemoteRepoOpPort` is deliberately structural, so nothing here
   * depends on the concrete service type.
   */
  function resolveRemoteFleet(): { ops: RemoteRepoOpPort; probeLiveness: ProbeLiveness } | null {
    if (options?.remoteFleet) return options.remoteFleet;
    try {
      const ops = getWorkerFleet(database).remoteAgentService as unknown as RemoteRepoOpPort;
      if (typeof ops.remoteSessionInfo !== "function" || typeof ops.requestRepoOp !== "function") return null;
      return { ops, probeLiveness: (row) => probeRemoteSessionLiveness(row, database) };
    } catch (err) {
      console.error(`[workspace-actions] could not reach the worker fleet`, err);
      return null;
    }
  }

  /** Per-workspace memo of the last mid-session landing (#784). See the interval constant. */
  const midSessionLandings = new Map<string, { at: number; landing: MidSessionLanding }>();

  const workspaceService = createWorkspaceService({
    database,
    getSessionManager,
    boardEvents: options?.boardEvents,
  });
  const bisectService = createBisectService({
    database,
    getSessionManager,
    boardEvents: options?.boardEvents,
  });
  const artifactsService = createSessionArtifactsService({ database });
  const servicesControl = createWorkspaceServicesControlService({
    database,
    boardEvents: options?.boardEvents,
  });

  // ── Per-workspace Docker service-stack lifecycle controls (#92) ──────────────
  // Reuse the existing compose/port engine — the compose project name + allocated
  // host ports are preserved across start/stop/restart (no reallocation).

  // POST /api/workspaces/:id/services/up — start (or, with ?recreate=true, rebuild) the
  // stack; (re)provisions a deferred/errored/never-run stack (the "Retry" control).
  router.post("/:id/services/up", async (c) => {
    const id = c.req.param("id");
    const recreate = queryFlag(c, "recreate");
    const serviceState = await servicesControl.up(id, { recreate });
    return c.json({ serviceState });
  });

  // POST /api/workspaces/:id/services/down — stop the stack (containers removed, named
  // volumes kept so a subsequent start finds its data intact).
  router.post("/:id/services/down", async (c) => {
    const id = c.req.param("id");
    const serviceState = await servicesControl.down(id);
    return c.json({ serviceState });
  });

  // POST /api/workspaces/:id/services/restart — bounce the running containers.
  router.post("/:id/services/restart", async (c) => {
    const id = c.req.param("id");
    const serviceState = await servicesControl.restart(id);
    return c.json({ serviceState });
  });

  // GET /api/workspaces/:id/services/logs?tail=N — a bounded, non-following log tail.
  router.get("/:id/services/logs", async (c) => {
    const id = c.req.param("id");
    const tailRaw = Number(c.req.query("tail"));
    const tail = Number.isFinite(tailRaw) && tailRaw > 0 ? Math.min(Math.floor(tailRaw), 2000) : 200;
    const result = await servicesControl.logs(id, tail);
    return c.json(result);
  });

  // POST /api/workspaces/:id/setup
  router.post("/:id/setup", async (c) => {
    const id = c.req.param("id");
    return c.json(await workspaceService.setupWorkspace(id));
  });

  // POST /api/workspaces/:id/terminal
  router.post("/:id/terminal", async (c) => {
    const id = c.req.param("id");
    const result = await workspaceService.openTerminal(id);
    return c.json({ ok: true, ...result });
  });

  // POST /api/workspaces/:id/launch
  router.post("/:id/launch", async (c) => {
    const id = c.req.param("id");
    const body = await parseOptionalJsonBody(c);
    return c.json(await workspaceService.launchSession(id, body), 201);
  });

  // POST /api/workspaces/:id/turn
  //
  // #783: a REMOTE session's worker holds its own checkout, and nothing used to push the
  // board's side of the branch into it — so a second turn ran against the tree the session
  // cloned, missing an `update-base` rebase, a fix-and-merge commit or a landed review fix.
  // The worker is therefore fast-forwarded FIRST, and the turn is REFUSED when that could
  // not be done: a turn delivered into a stale checkout is worse than a refused one, and it
  // is indistinguishable afterwards from the agent deciding to revert the board's work.
  router.post("/:id/turn", async (c) => {
    const id = c.req.param("id");
    const body = await parseJsonBody(c, workspaceTurnBody);
    const fleet = resolveRemoteFleet();
    if (fleet) {
      const session = await findRunningSession(id, database);
      const gate = await gateRemoteTurn({
        session: session ? { id: session.id, workerId: session.workerId, startedAt: session.startedAt } : null,
        ops: fleet.ops,
        probeLiveness: fleet.probeLiveness,
      });
      if (!gate.ok) {
        const message =
          `This workspace's agent runs on a fleet worker and its checkout could not be brought up ` +
          `to date (${gate.status}), so the follow-up was not delivered: ${gate.reason}`;
        // The domain-error vocabulary, not an inline c.json(4xx): 409 when a human has to
        // resolve a divergence, 422 when the sync itself could not complete.
        throw gate.kind === "conflict" ? new ConflictError(message) : new UnprocessableError(message);
      }
      if (gate.status !== "not-remote") {
        console.log(`[workspace-actions] remote checkout ${gate.status} before turn: workspaceId=${id} (${gate.reason})`);
      }
    }
    const result = await workspaceService.sendTurn(id, body.content);
    if (result.type === "sent") return c.json({ ok: true });
    return c.json({ sessionId: result.sessionId, resumed: true }, 201);
  });

  // POST /api/workspaces/:id/stop
  router.post("/:id/stop", async (c) => {
    const id = c.req.param("id");
    console.log(`[workspace-actions] stop: workspaceId=${id}`);
    return c.json(await workspaceService.stopWorkspace(id));
  });

  // POST /api/workspaces/:id/quarantine — stop session + move issue back to In Progress
  router.post("/:id/quarantine", async (c) => {
    const id = c.req.param("id");
    return c.json(await workspaceService.quarantineWorkspace(id));
  });

  // POST /api/workspaces/:id/implement-plan
  router.post("/:id/implement-plan", async (c) => {
    const id = c.req.param("id");
    const body = await parseOptionalJsonBody<{ planContent?: string }>(c);
    return c.json(await workspaceService.implementPlan(id, body.planContent), 201);
  });

  // GET /api/workspaces/:id/plan
  router.get("/:id/plan", async (c) => {
    const id = c.req.param("id");
    return c.json(await workspaceService.getPlanContent(id));
  });

  // POST /api/workspaces/:id/reject-plan
  router.post("/:id/reject-plan", async (c) => {
    const id = c.req.param("id");
    const body = await parseJsonBody(c, rejectPlanBody);
    return c.json(await workspaceService.rejectPlan(id, body.feedback), 201);
  });

  // POST /api/workspaces/:id/bisect
  router.post("/:id/bisect", async (c) => {
    const id = c.req.param("id");
    const body = await parseOptionalJsonBody<{ scope?: BisectScope }>(c);
    const scope = body.scope === "full" ? "full" : "related";
    return c.json(await bisectService.startBisect(id, scope), 201);
  });

  // GET /api/workspaces/:id/latest-commit
  router.get("/:id/latest-commit", async (c) => {
    const id = c.req.param("id");
    return c.json(await workspaceService.getLatestCommit(id));
  });

  /**
   * Land a running remote session's committed work so the diff below can see it (#784).
   *
   * Returns null for every non-remote workspace, so the response shape is unchanged for
   * host sessions. Never throws: a diff that cannot reach the worker still answers, with a
   * `remoteMidSession` block that says what it is missing and why.
   */
  async function landMidSessionWork(id: string): Promise<MidSessionLanding | null> {
    const fleet = resolveRemoteFleet();
    if (!fleet) return null;
    try {
      const session = await findRunningSession(id, database);
      if (!session?.workerId) {
        midSessionLandings.delete(id);
        return null;
      }
      const memo = midSessionLandings.get(id);
      if (memo && Date.now() - memo.at < MID_SESSION_LAND_MIN_INTERVAL_MS) {
        // Throttled: report the SAME landing with its real age rather than a fresh-looking
        // repeat of it (#784 item 4).
        return { ...memo.landing, ageMs: Date.now() - memo.at };
      }
      const landing = await landRemoteMidSessionWork({
        session: { id: session.id, workerId: session.workerId, startedAt: session.startedAt },
        ops: fleet.ops,
        probeLiveness: fleet.probeLiveness,
      });
      if (!landing) return null;
      midSessionLandings.set(id, { at: Date.now(), landing });
      if (midSessionLandings.size > 2000) midSessionLandings.clear(); // crude cap; entries are tiny
      return landing;
    } catch (err) {
      console.error(`[workspace-actions] mid-session remote landing failed: workspaceId=${id}`, err);
      return null;
    }
  }

  // GET /api/workspaces/:id/diff — full diff, or with `?stats=1` only the per-repo
  // shortstat numbers (#415: one spawn per repo instead of three, tiny payload).
  //
  // #415 ETag-before-compute — STATS VARIANT ONLY: a short-lived memo of the last
  // validator served per workspace. When If-None-Match matches a memo still within its
  // window, the 304 is answered WITHOUT recomputing — the old pattern always paid the
  // git fan-out and hashed the body just to say 304. The full-diff variant deliberately
  // keeps compute-then-compare: its consumers (review, diff panel) must never see a
  // stale 304 after a commit, and no cheap per-workspace change signal reaches here.
  // The stats consumers are polling dashboards that tolerate the same ~10s staleness
  // as the batch endpoint's memo.
  const DIFF_STATS_ETAG_MEMO_TTL_MS = 10_000;
  const diffStatsEtagMemo = new Map<string, { etag: string; at: number }>();
  router.get("/:id/diff", async (c) => {
    const id = c.req.param("id");
    const statsOnly = ["1", "true", "yes"].includes((c.req.query("stats") || "").toLowerCase());
    const ifNoneMatch = c.req.header("if-none-match");
    if (statsOnly && ifNoneMatch) {
      const memo = diffStatsEtagMemo.get(id);
      if (memo && memo.etag === ifNoneMatch && Date.now() - memo.at < DIFF_STATS_ETAG_MEMO_TTL_MS) {
        return new Response(null, { status: 304, headers: { ETag: memo.etag } });
      }
    }
    // #784: a true-remote worker pushes ONCE, post-exit, so the board-side worktree this
    // diff reads stayed at the base tip for the whole run — every mid-session reader (review
    // preparation, the monitor's progress signals, "is it changing files at all") was blind
    // on remote placement while working on host placement. Ask the worker for its current
    // HEAD, land it fast-forward-only, and SAY how fresh the answer is.
    const remoteMidSession = await landMidSessionWork(id);
    const result = statsOnly
      ? await workspaceService.getWorkspaceDiffStats(id)
      : await workspaceService.getWorkspaceDiff(id);
    const body = JSON.stringify(remoteMidSession ? { ...result, remoteMidSession } : result);
    const etag = `"${createHash("sha1").update(body).digest("hex").slice(0, 16)}"`;
    if (statsOnly) {
      if (diffStatsEtagMemo.size > 2000) diffStatsEtagMemo.clear(); // crude cap; entries are tiny
      diffStatsEtagMemo.set(id, { etag, at: Date.now() });
    }
    if (ifNoneMatch === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json", ETag: etag },
    });
  });

  // POST /api/workspaces/:id/merge
  // POST /api/workspaces/:id/merge — land the branch. Runs the pre-merge gate inline, which
  // on a full-suite project is 30-45 MINUTES, so the outcome is always recorded as a job
  // (see merge-job.service.ts): a caller whose connection dies can still get the verdict from
  // GET /:id/merge-status instead of being unable to tell a failure from a still-running gate.
  //
  // `?async=1` returns 202 + jobId immediately rather than holding the connection at all.
  // The default stays SYNCHRONOUS for back-compat — the UI and CLI both read the merge result
  // from this response body today, and silently turning that into a 202 would make them
  // report success for a merge that had not happened yet.
  router.post("/:id/merge", async (c) => {
    const id = c.req.param("id");
    const wantsAsync = ["1", "true", "yes"].includes((c.req.query("async") || "").toLowerCase());
    // #903 — a retried POST while a merge is already in-flight (double-click, a monitor's own
    // retry loop) used to call `startMergeJob` unconditionally, REPLACING the tracked job's
    // `startedAt` on every retry. That reset the zombie clock indefinitely — exactly the "only
    // a backend restart ever cleared it" failure the zombie detector exists to fix, since a
    // caller that keeps retrying never lets 4h elapse against a single start time. Only start a
    // fresh job (and only this call may complete/fail it) when we are not joining an existing
    // running job for this workspace.
    const existingJob = getMergeJob(id);
    const joiningExisting = existingJob !== null && existingJob.state === "running";
    const job = joiningExisting ? existingJob : startMergeJob(id);
    const ownsJob = !joiningExisting;
    const run = workspaceService
      // Only THIS caller defers the main checkout's `git reset --hard` past the merge result
      // (#686: the reset rewrites files → tsx hot-reload → the in-flight response is dropped).
      // Every non-interactive caller syncs inline instead, because that deferral is what left
      // the main checkout showing the merged files as staged deletions for ~32s (#350).
      .mergeWorkspaceDeduped(id, { deferMainCheckoutSync: true })
      .then((result) => {
        if (ownsJob) completeMergeJob(job.jobId, id, result);
        return result;
      })
      .catch((err) => {
        if (ownsJob) failMergeJob(job.jobId, id, err);
        throw err;
      });

    if (wantsAsync) {
      // Nothing awaits `run` in this branch, so an eventual rejection would be an unhandled
      // promise rejection (which this server logs as [fatal]). The job record IS the report.
      void run.catch(() => {});
      return c.json({ accepted: true, jobId: job.jobId, workspaceId: id, statusUrl: `/api/workspaces/${id}/merge-status` }, 202);
    }
    return c.json(await run);
  });

  // GET /api/workspaces/:id/merge-status — the latest merge job for this workspace, including
  // a finished one. `null` means this process has no record (never merged here, or restarted).
  //
  // #893: "restarted" is exactly the case where a caller most needs this endpoint — a tsx-watch
  // restart killed the merge request AFTER its 30-45 min gate had passed. The persisted gate
  // verdict (workspace_merge_gate) survives that restart, so when this process has no job the
  // response says whether a PASSING verdict is stored — distinguishing "the gate failed" from
  // "the gate passed and only the transport died; a merge retry will reuse the verdict".
  router.get("/:id/merge-status", async (c) => {
    const id = c.req.param("id");
    const job = getMergeJob(id);
    if (!job) {
      const persistedGateVerdict = await describePersistedGateVerdict(id);
      if (persistedGateVerdict) {
        return c.json({
          job: null,
          persistedGateVerdict,
          message:
            "no merge job recorded for this workspace in the current server process (it may have restarted mid-merge) — "
            + `but a PASSING pre-merge gate verdict is persisted (stage ${persistedGateVerdict.stage}, ran ${persistedGateVerdict.ranAt}). `
            + (persistedGateVerdict.reusable
              ? "A merge retry will reuse it instead of re-running the gate, as long as the branch/base tips and verification tier are unchanged (#893)."
              : "It is too old (or lacks tips/tier) to reuse, so a merge retry will re-run the gate."),
        });
      }
      return c.json({ job: null, message: "no merge job recorded for this workspace in the current server process" });
    }
    return c.json({ job });
  });

  // GET /api/workspaces/:id/already-merged-status — check if branch is already merged without modifying state
  // ?adoptMainCheckout=true previews the #218 recovery override (work asserted to have
  // landed on the base branch out-of-band) without acting on it.
  router.get("/:id/already-merged-status", async (c) => {
    const id = c.req.param("id");
    const adoptMainCheckout = queryFlag(c, "adoptMainCheckout");
    return c.json(await workspaceService.checkAlreadyMerged(id, { adoptMainCheckout }));
  });

  // GET /api/workspaces/:id/repo-merge-status — per-repo (leading + siblings) merge status (#70)
  router.get("/:id/repo-merge-status", async (c) => {
    const id = c.req.param("id");
    return c.json(await workspaceService.getRepoMergeStatus(id));
  });

  // POST /api/workspaces/:id/reconcile-as-done — close a workspace whose branch is already on master
  // Body `{ adoptMainCheckout: true }` (#218) is the explicit "the work landed on the base
  // branch out-of-band" recovery — it overrides ONLY the "no unique commits" refusal, never
  // the diff/ancestry/pending-sibling/dirty-sibling checks.
  router.post("/:id/reconcile-as-done", async (c) => {
    const id = c.req.param("id");
    const body = await parseOptionalJsonBody<{ adoptMainCheckout?: boolean }>(c);
    return c.json(await workspaceService.reconcileAlreadyMerged(id, { adoptMainCheckout: body.adoptMainCheckout === true }), 200);
  });

  // GET /api/workspaces/:id/github-handoff-draft
  router.get("/:id/github-handoff-draft", async (c) => {
    const id = c.req.param("id");
    return c.json(await workspaceService.getLatestGithubHandoffDraft(id) ?? { artifactId: null, content: null, createdAt: null });
  });

  // POST /api/workspaces/:id/github-handoff-draft
  router.post("/:id/github-handoff-draft", async (c) => {
    const id = c.req.param("id");
    return c.json(await workspaceService.generateGithubHandoffDraft(id), 201);
  });

  // GET /api/workspaces/:id/conflicts
  router.get("/:id/conflicts", async (c) => {
    const id = c.req.param("id");
    return c.json(await workspaceService.getConflicts(id));
  });

  // GET /api/workspaces/:id/handoff — HANDOFF.md metadata (mtime + excerpt) per repo (#89)
  router.get("/:id/handoff", async (c) => {
    const id = c.req.param("id");
    return c.json(await workspaceService.getHandoff(id));
  });

  // POST /api/workspaces/:id/update-base
  router.post("/:id/update-base", async (c) => {
    const id = c.req.param("id");
    const body = await parseJsonBody(c);
    const mode = body.mode === "merge" ? "merge" as const : "rebase" as const;
    return c.json(await workspaceService.updateBase(id, mode));
  });

  // POST /api/workspaces/:id/abort-rebase
  router.post("/:id/abort-rebase", async (c) => {
    const id = c.req.param("id");
    return c.json(await workspaceService.abortRebase(id));
  });

  // POST /api/workspaces/:id/repos/:repoName/rebase — per-repo recovery for a stranded sibling (#93):
  // rebase ONE repo's worktree branch onto its base (REBASE only — never lands a repo in isolation).
  router.post("/:id/repos/:repoName/rebase", async (c) => {
    const id = c.req.param("id");
    const repoName = decodeURIComponent(c.req.param("repoName"));
    return c.json(await workspaceService.rebaseRepo(id, repoName));
  });

  // POST /api/workspaces/:id/resolve-conflicts
  router.post("/:id/resolve-conflicts", async (c) => {
    const id = c.req.param("id");
    const result = await workspaceService.resolveConflicts(id);
    options?.fixAndMergeSessionIds?.add(result.sessionId);
    return c.json(result, 201);
  });

  // POST /api/workspaces/:id/fix-and-merge
  router.post("/:id/fix-and-merge", async (c) => {
    const id = c.req.param("id");
    const body = await parseOptionalJsonBody<{ mergeError?: string }>(c);
    const result = await workspaceService.fixAndMerge(id, body.mergeError);
    options?.fixAndMergeSessionIds?.add(result.sessionId);
    return c.json(result, 201);
  });

  // GET /api/workspaces/:id/comments
  router.get("/:id/comments", async (c) => {
    const id = c.req.param("id");
    const filePath = c.req.query("filePath");
    return c.json(await workspaceService.listComments(id, filePath));
  });

  // POST /api/workspaces/:id/comments
  router.post("/:id/comments", async (c) => {
    const id = c.req.param("id");
    const body = await parseJsonBody(c, createWorkspaceCommentBody);
    return c.json(await workspaceService.createComment(id, body), 201);
  });

  // PATCH /api/workspaces/:id/comments/:commentId
  router.patch("/:id/comments/:commentId", async (c) => {
    const id = c.req.param("id");
    const commentId = c.req.param("commentId");
    const body = await parseJsonBody(c, updateWorkspaceCommentBody);
    return c.json(await workspaceService.updateComment(id, commentId, body.body));
  });

  // PATCH /api/workspaces/:id/comments/:commentId/resolve — toggle resolved state
  router.patch("/:id/comments/:commentId/resolve", async (c) => {
    const id = c.req.param("id");
    const commentId = c.req.param("commentId");
    const body = await parseJsonBody(c, resolveWorkspaceCommentBody);
    return c.json(await workspaceService.resolveComment(id, commentId, body.resolved));
  });

  // DELETE /api/workspaces/:id/comments/:commentId
  router.delete("/:id/comments/:commentId", async (c) => {
    const id = c.req.param("id");
    const commentId = c.req.param("commentId");
    await workspaceService.deleteComment(id, commentId);
    return c.json({ success: true });
  });

  // GET /api/workspaces/:id/sessions
  router.get("/:id/sessions", async (c) => {
    const id = c.req.param("id");
    return c.json(await workspaceService.getSessions(id));
  });

  // POST /api/workspaces/:id/open-editor
  router.post("/:id/open-editor", async (c) => {
    const id = c.req.param("id");
    await workspaceService.openEditor(id);
    return c.json({ ok: true });
  });

  // GET /api/workspaces/:id/scorecard
  router.get("/:id/scorecard", async (c) => {
    const id = c.req.param("id");
    const { getScorecardFromDb, computeScorecard } = await import("../services/workspace-scorecard.service.js");
    let scorecard = await getScorecardFromDb(id, database);
    if (!scorecard) {
      scorecard = await computeScorecard(id, database);
    }
    if (!scorecard) return c.json({ error: "Scorecard not available" }, 404);
    return c.json(scorecard);
  });

  // POST /api/workspaces/:id/scorecard/refresh
  router.post("/:id/scorecard/refresh", async (c) => {
    const id = c.req.param("id");
    const { computeScorecard } = await import("../services/workspace-scorecard.service.js");
    const scorecard = await computeScorecard(id, database);
    if (!scorecard) return c.json({ error: "Scorecard not available" }, 404);
    return c.json(scorecard);
  });

  // DELETE /api/workspaces/:id/stale-worktree — safely remove a stale worktree directory
  router.delete("/:id/stale-worktree", async (c) => {
    const id = c.req.param("id");
    const result = await workspaceService.removeStaleWorktree(id);
    if (!result.success) {
      return c.json({ error: result.error }, 400);
    }
    return c.json({ success: true });
  });

  // POST /api/workspaces/:id/retry-cleanup — retry worktree cleanup for a workspace with a pending warning
  router.post("/:id/retry-cleanup", async (c) => {
    const id = c.req.param("id");
    const result = await workspaceService.retryCleanup(id);
    if (!result.success) {
      return c.json({ error: result.error }, 400);
    }
    return c.json({ success: true });
  });

  // GET /api/workspaces/:id/visual-proof — list DB artifacts (visual proof) scoped to this workspace
  router.get("/:id/visual-proof", async (c) => {
    const id = c.req.param("id");
    const rows = await artifactsService.listVisualProof(id);
    if (rows === null) return c.json({ error: "Workspace not found" }, 404);
    return c.json(rows);
  });

  // GET /api/workspaces/:id/artifacts — list recognized artifacts in workspace directory
  router.get("/:id/artifacts", async (c) => {
    const id = c.req.param("id");
    const artifacts = await artifactsService.listArtifacts(id);
    return c.json(artifacts);
  });

  // GET /api/workspaces/:id/artifacts-file — read a single artifact by ?path= query param
  router.get("/:id/artifacts-file", async (c) => {
    const id = c.req.param("id");
    const artifactPath = c.req.query("path");
    if (!artifactPath) {
      return c.json({ error: "path query parameter is required" }, 400);
    }
    const ext = artifactPath.split(".").pop()?.toLowerCase() ?? "";
    const imageExts = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"];
    if (imageExts.includes(ext)) {
      const result = await artifactsService.readImageArtifact(id, artifactPath);
      return new Response(result.buffer, {
        headers: {
          "Content-Type": result.mimeType,
          "Cache-Control": "no-cache",
        },
      });
    }
    const result = await artifactsService.readTextArtifact(id, artifactPath);
    return c.json(result);
  });

  // GET /api/workspaces/:id/handoff-bundle — export a compact handoff bundle (JSON or Markdown)
  router.get("/:id/handoff-bundle", async (c) => {
    const id = c.req.param("id");
    const format = c.req.query("format");
    const bundle = await workspaceService.exportHandoffBundle(id);
    if (format === "markdown") {
      const md = workspaceService.renderHandoffBundleAsMarkdown(bundle);
      return new Response(md, {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="handoff-${id.slice(0, 8)}.md"`,
        },
      });
    }
    return c.json(bundle);
  });

  // GET /api/workspaces/:id/timeline — session failure timeline with restart decisions
  router.get("/:id/timeline", async (c) => {
    const id = c.req.param("id");
    const timeline = await getWorkspaceTimeline(id, database);
    return c.json(timeline);
  });

  return router;
}
