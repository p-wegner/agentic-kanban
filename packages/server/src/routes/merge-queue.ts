import { streamSSE } from "hono/streaming";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { mergeQueueBody, mergeQueueWindowHoldBody, mergeQueueWindowReleaseBody } from "./merge-queue-body-schemas.js";
import { createMergeQueueService } from "../services/merge-queue.service.js";
import type { Database } from "../db/index.js";
import type { BoardEventSink } from "../services/board-events.js";
import type { SessionManager } from "../services/session.manager.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { getMergeTrain, listActiveMergeTrainsForProject, listMergeTrainsForProject, updateMergeTrainState } from "../repositories/merge-train.repository.js";
import { abortLiveMergeTrain } from "../services/merge-train-live-registry.js";
import { cleanupTrainWorktreesForLabel } from "../services/merge-train-worktrees.js";
import { getProjectRepoPath } from "../repositories/project.repository.js";
import { getMergeQueueIssueRows, getMergeQueueWorkspaceRows } from "../repositories/merge-queue.repository.js";
import { listTrainSidingStatesForProject } from "../repositories/merge-train-siding.repository.js";
import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import type { MergeTrainWindowDto, MergeTrainWindowPendingMemberDto, MergeTrainWindowResponse, MergeTrainsResponse } from "@agentic-kanban/shared";
import { resolveTrainWindowConfig } from "../services/merge-train-window.js";
import { holdTrainWindow, readTrainWindow, requestTrainWindowRelease } from "../services/merge-train-window-state.js";

export function createMergeQueueRoute(
  database: Database,
  // #1192: widened from SessionLauncher — createMergeQueueService now needs the full manager
  // for a siding drop's `/turn` nudge. Every real caller already passes it.
  getSessionManager: () => SessionManager,
  options?: { boardEvents?: BoardEventSink },
) {
  const router = createRouter();

  const queueService = createMergeQueueService({
    database,
    boardEvents: options?.boardEvents,
    getSessionManager,
  });

  /**
   * POST /api/merge-queue/preview/:workspaceId
   *
   * Dry-run conflict preview for a single workspace. Read-only — does not mutate the worktree.
   * Returns: WorkspaceConflictPreview
   */
  router.post("/preview/:workspaceId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    try {
      const plan = await queueService.computePlan([workspaceId]);
      const preview = plan.conflictPreviews[0] ?? { workspaceId, hasConflicts: false, conflictingFiles: [], isStale: false };
      return c.json({ ok: true, preview });
    } catch (err) {
      return c.json({ ok: false, error: errorMessage(err) }, 500);
    }
  });

  /**
   * POST /api/merge-queue
   *
   * body: { workspaceIds: string[], dryRun?: boolean, skipOnConflict?: boolean, strategy?: "sequential" | "train" }
   *
   * - dryRun: true  → returns JSON plan (sorted order + conflict matrix + per-workspace conflictPreviews)
   * - dryRun: false → streams SSE events while executing the queue
   * - strategy: explicit override; "sequential" always wins, "train" opts in regardless of
   *   project defaults. Omitted → `executeQueue` decides (classifier recommendation or the
   *   project's `train_max_size` opt-in, #904).
   */
  router.post("/", async (c) => {
    const body = await parseJsonBody(c, mergeQueueBody);

    if (body.dryRun) {
      const plan = await queueService.computePlan(body.workspaceIds);
      return c.json({ ok: true, dryRun: true, plan });
    }

    // Execute the queue and stream SSE events
    return streamSSE(c, async (stream) => {
      const events = queueService.executeQueue(body.workspaceIds, {
        skipOnConflict: body.skipOnConflict ?? false,
        strategy: body.strategy,
      });
      // #1152 (#1150 criterion #2): a client disconnect must be noticed when it happens, not
      // only after the next `writeSSE` returns — the loop below only reaches `stream.closed`
      // between events, and `executeQueue`'s locked region can run for tens of minutes between
      // yields (a rebase, a 30-45 minute gate). `onAbort` fires off the request's real abort
      // signal; `.return()` is queued and delivered at the generator's NEXT `yield`, where it
      // runs every enclosing `finally` (lock release, heartbeat clear) and ends the run instead
      // of streaming into a socket nobody reads. It cannot preempt an in-flight `await`, so a
      // train mid-gate still finishes that gate and its row bookkeeping headless — acceptance
      // criterion #2's other sanctioned outcome; the operator cancel (`DELETE /trains/:id`)
      // remains the way to abort a running gate.
      stream.onAbort(() => {
        void events.return(undefined);
      });
      try {
        for await (const event of events) {
          await stream.writeSSE({ data: JSON.stringify(event) });
          if (event.type === "done") break;
          if (stream.closed) break;
        }
      } catch (err) {
        try {
          await stream.writeSSE({
            data: JSON.stringify({
              type: "error",
              workspaceId: "",
              issueNumber: null,
              issueTitle: "",
              error: errorMessage(err),
            }),
          });
          await stream.writeSSE({
            data: JSON.stringify({ type: "done", merged: [], failed: [], skipped: [] }),
          });
        } catch {
          // stream already closed
        }
      }
    });
  });

  /**
   * GET /api/merge-queue/trains?projectId=
   *
   * History of persisted release trains for a project (#906) — newest first, including
   * `abandoned` rows the startup reconciler left behind. What a "Merge train" panel reads.
   * #1198: also the project's live sidings (#1192), so the panel can tell "on its 2nd siding"
   * from a fresh drop — the siding table is keyed by workspace and had no read surface.
   */
  router.get("/trains", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) {
      return c.json({ ok: false, error: "projectId query parameter is required" }, 400);
    }
    const [trains, sidings] = await Promise.all([
      listMergeTrainsForProject(projectId, database),
      listTrainSidingStatesForProject(projectId, database),
    ]);
    const body: MergeTrainsResponse = { ok: true, trains, sidings };
    return c.json(body);
  });

  /**
   * GET /api/merge-queue/trains/:id
   *
   * A single train row, with `gateEvidence`/`bisectResult` parsed and the bisect-tree
   * `attempts` (#1189) lifted to the top level — the shape `pnpm cli -- train show` and the
   * `get_merge_train` MCP tool render. 404 when the id names no train.
   */
  router.get("/trains/:id", async (c) => {
    const id = c.req.param("id");
    const train = await getMergeTrain(id, database);
    if (!train) {
      return c.json({ ok: false, error: "train not found" }, 404);
    }
    let gateEvidence: unknown = null;
    try {
      gateEvidence = train.gateEvidence ? JSON.parse(train.gateEvidence) : null;
    } catch {
      gateEvidence = null;
    }
    let bisectResult: unknown = null;
    try {
      bisectResult = train.bisectResult ? JSON.parse(train.bisectResult) : null;
    } catch {
      bisectResult = null;
    }
    return c.json({
      ok: true,
      train: {
        ...train,
        gateEvidence,
        bisectResult,
        attempts: (gateEvidence as { attempts?: unknown[] } | null)?.attempts ?? [],
      },
    });
  });

  /**
   * POST /api/merge-queue/trains/:id/cancel
   *
   * #1153 — the only remedy an operator had for a stranded train was a full server restart
   * (the reconciler resumes an `assembling`/`gating` row otherwise). Marks the row `abandoned`
   * with a reason.
   *
   * #1203 — this now ALSO aborts the in-flight job when this process is running it
   * (`abortLiveMergeTrain`): the bisect driver refuses to start another attempt once the signal
   * is set, and the currently-running gate/install child process is killed rather than left to
   * run to completion. `finishMergeTrain` still checks for `abandoned` before overwriting it (a
   * cross-process defence, and a defence against a race between this route and an attempt that
   * had already passed its signal check the instant before abort() fired), and no NEW train
   * will be assembled for this project while one is in an unfinished state.
   */
  router.post("/trains/:id/cancel", async (c) => {
    const id = c.req.param("id");
    const train = await getMergeTrain(id, database);
    if (!train) {
      return c.json({ ok: false, error: "train not found" }, 404);
    }
    if (train.state !== "assembling" && train.state !== "gating") {
      return c.json({ ok: false, error: `train is already terminal (${train.state})` }, 409);
    }
    await updateMergeTrainState(id, {
      state: "abandoned",
      reconciledReason: "cancelled by operator",
      finishedAt: new Date().toISOString(),
    }, database);
    // #1203: aborted AFTER the row is marked, so a job that reads the row between the two
    // writes still sees `abandoned` (the `shouldLand`/guardStates defences), and a job that
    // reads it before still gets stopped by the signal moments later.
    const stoppedLiveJob = abortLiveMergeTrain(id);
    const stoppedAfter = stoppedLiveJob ? "current-attempt" : "immediately";
    console.log(`[merge-queue] cancelled train ${id} (${train.label}) — stopped ${stoppedAfter}${stoppedLiveJob ? "" : " (no live job in this process)"}`);
    options?.boardEvents?.broadcast(train.projectId, "merge_train_changed");
    // #1235: a cancel with NO live job is a terminal transition nothing else tears down — the
    // job that would have run the gate's `finally` is gone. A live job cleans up after itself
    // when its abort lands (`runDoomedTrainJob`'s `finally`), so only the stranded case does
    // it here. Best-effort: the row is already abandoned, and the reconcilers are the backstop.
    if (!stoppedLiveJob) {
      const repoPath = await getProjectRepoPath(train.projectId, database).catch(() => null);
      if (repoPath) await cleanupTrainWorktreesForLabel({ database, repoPath, label: train.label });
    }
    return c.json({ ok: true, stoppedAfter });
  });

  /**
   * GET /api/merge-queue/window?projectId=
   *
   * The departure board (#1186): the project's merge-train batching window as the orchestrator
   * persisted it on its last tick (`train_window_<projectId>`) — who is waiting, since when,
   * the last verdict + reason, the size/wait config in force and the projected departure — or
   * `window: null` when nothing is being held. Read-only; one source with the log line.
   */
  router.get("/window", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) {
      return c.json({ ok: false, error: "projectId query parameter is required" }, 400);
    }
    const persisted = await readTrainWindow(projectId, database);
    if (!persisted) {
      const empty: MergeTrainWindowResponse = { ok: true, window: null };
      return c.json(empty);
    }

    const prefMap = toPrefMap(await getAllPreferencesCached(database));
    const config = resolveTrainWindowConfig(prefMap, projectId);
    const [pending, activeTrains] = await Promise.all([
      resolvePendingMembers(persisted.pendingIds),
      listActiveMergeTrainsForProject(projectId, ["assembling", "gating"], database),
    ]);
    const window: MergeTrainWindowDto = {
      projectId,
      pending,
      firstSeenAt: persisted.firstSeenAt,
      config: {
        maxSize: config.maxSize,
        maxWaitMs: config.maxWaitMs,
        fromPosture: config.batchingFromPosture,
        postureLevel: config.posture.level,
      },
      lastVerdict: persisted.lastVerdict,
      lastEvaluatedAt: persisted.lastEvaluatedAt,
      projectedDepartureAt: config.maxWaitMs > 0 && persisted.pendingIds.length > 0
        ? new Date(new Date(persisted.firstSeenAt).getTime() + config.maxWaitMs).toISOString()
        : null,
      heldUntil: persisted.heldUntil ?? null,
      releaseRequestedAt: persisted.releaseRequestedAt ?? null,
      liveTrainId: activeTrains[0]?.id ?? null,
    };
    const response: MergeTrainWindowResponse = { ok: true, window };
    return c.json(response);
  });

  /**
   * POST /api/merge-queue/window/release
   *
   * body: { projectId }
   *
   * Operator "depart now" (#1186): stamps `releaseRequestedAt`; the orchestrator's next tick
   * releases the pending set as one train with reason `operator_release`, regardless of size,
   * wait or a busy gate (a live hold still wins until it expires). 409 when the project has no
   * open window.
   */
  router.post("/window/release", async (c) => {
    const body = await parseJsonBody(c, mergeQueueWindowReleaseBody);
    const window = await requestTrainWindowRelease(body.projectId, database);
    if (!window) {
      return c.json({ ok: false, error: "no open merge-train window for this project" }, 409);
    }
    console.log(`[merge-queue] window release requested by operator for project ${body.projectId} (${window.pendingIds.length} pending)`);
    options?.boardEvents?.broadcast(body.projectId, "merge_train_window_changed");
    return c.json({ ok: true, window });
  });

  /**
   * POST /api/merge-queue/window/hold
   *
   * body: { projectId, minutes }
   *
   * Operator "hold the door" (#1186): no release before `now + minutes`, whatever the size or
   * wait say; `minutes: 0` clears the hold. A hold placed before anything is ready is kept as a
   * control-only record and applies to the first arrival.
   */
  router.post("/window/hold", async (c) => {
    const body = await parseJsonBody(c, mergeQueueWindowHoldBody);
    const window = await holdTrainWindow(body.projectId, body.minutes, database);
    console.log(
      body.minutes > 0
        ? `[merge-queue] window held by operator for project ${body.projectId} for ${body.minutes} min (until ${window?.heldUntil})`
        : `[merge-queue] window hold cleared by operator for project ${body.projectId}`,
    );
    options?.boardEvents?.broadcast(body.projectId, "merge_train_window_changed");
    return c.json({ ok: true, window });
  });

  /**
   * Issue number/title per pending workspace, through the queue's own repository functions.
   * A workspace row that has since vanished still appears (the window said it was pending)
   * with nulls, so the board never hides a member it cannot name.
   */
  async function resolvePendingMembers(workspaceIds: string[]): Promise<MergeTrainWindowPendingMemberDto[]> {
    if (workspaceIds.length === 0) return [];
    const workspaceRows = await getMergeQueueWorkspaceRows(workspaceIds, database);
    const issueIds = [...new Set(workspaceRows.map((w) => w.issueId))];
    const issueRows = issueIds.length > 0 ? await getMergeQueueIssueRows(issueIds, database) : [];
    const issueById = new Map(issueRows.map((i) => [i.id, i]));
    const workspaceById = new Map(workspaceRows.map((w) => [w.id, w]));
    return workspaceIds.map((workspaceId) => {
      const workspace = workspaceById.get(workspaceId);
      const issue = workspace ? issueById.get(workspace.issueId) : undefined;
      return {
        workspaceId,
        issueNumber: issue?.issueNumber ?? null,
        issueTitle: issue?.title ?? null,
        readySince: workspace?.updatedAt ?? null,
      };
    });
  }

  return router;
}
