import { streamSSE } from "hono/streaming";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { mergeQueueBody, mergeQueueWindowHoldBody, mergeQueueWindowReleaseBody } from "./merge-queue-body-schemas.js";
import { createMergeQueueService } from "../services/merge-queue.service.js";
import type { Database } from "../db/index.js";
import type { BoardEventSink } from "../services/board-events.js";
import type { SessionLauncher } from "../services/session.manager.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import {
  getMergeTrain,
  getTrainWindowMemberSummaries,
  listMergeTrainsForProject,
  updateMergeTrainState,
} from "../repositories/merge-train.repository.js";
import { getActiveAutoMergeOrchestrator, mergeTrainWindowHoldUntilPref, mergeTrainWindowPref } from "../startup/auto-merge-orchestrator.js";
import { resolveTrainWindowConfig } from "../services/merge-train-window.js";
import { getAllPreferencesCached, getPreference } from "../repositories/preferences.repository.js";
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import { formatPostureNote } from "../services/risk-posture.service.js";
import { describeReleasePartition, partitionMergeRelease, releaseBatches } from "../services/merge-release-partition.js";

export function createMergeQueueRoute(
  database: Database,
  getSessionManager: () => SessionLauncher,
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
      try {
        for await (const event of queueService.executeQueue(body.workspaceIds, {
          skipOnConflict: body.skipOnConflict ?? false,
          strategy: body.strategy,
        })) {
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
   */
  router.get("/trains", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) {
      return c.json({ ok: false, error: "projectId query parameter is required" }, 400);
    }
    const trains = await listMergeTrainsForProject(projectId, database);
    return c.json({ ok: true, trains });
  });

  /**
   * POST /api/merge-queue/trains/:id/cancel
   *
   * #1153 — the only remedy an operator had for a stranded train was a full server restart
   * (the reconciler resumes an `assembling`/`gating` row otherwise). Marks the row `abandoned`
   * with a reason; the in-flight run (if the process holding it is still alive) is not
   * interrupted — there is no cancellation token for it — but `finishMergeTrain` checks for
   * `abandoned` before overwriting it, and no NEW train will be assembled for this project while
   * one is in an unfinished state, so cancelling is what unblocks that.
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
    options?.boardEvents?.broadcast(train.projectId, "merge_train_state_changed");
    return c.json({ ok: true });
  });

  /**
   * GET /api/merge-queue/window?projectId=
   *
   * The departure-board API (#1186): what the batching window (`merge-train-window.ts`,
   * `auto-merge-orchestrator.ts`) is holding for this project right now, why, and when it is
   * projected to leave. Reads live orchestrator state when the process holds one (the normal
   * case), falling back to the persisted pref (a restart before the first tick, or this route
   * being hit from a different process) — the two are kept in the same shape on purpose.
   */
  router.get("/window", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) {
      return c.json({ ok: false, error: "projectId query parameter is required" }, 400);
    }

    const orchestrator = getActiveAutoMergeOrchestrator();
    const liveWindow = orchestrator?.state.trainWindows.get(projectId) ?? null;
    const liveVerdict = orchestrator?.getTrainWindowVerdict(projectId) ?? null;

    let pendingIds = liveWindow?.pendingIds ?? [];
    let firstSeenAt = liveWindow?.firstSeenAt ?? null;
    let lastVerdict = liveVerdict?.verdict ?? null;
    let decidedAt = liveVerdict?.decidedAt ?? null;

    if (!liveWindow && !liveVerdict) {
      // No live orchestrator state for this project (never ticked here, or this process has no
      // orchestrator at all) — fall back to what was last persisted.
      const persistedRaw = await getPreference(mergeTrainWindowPref.key(projectId), database);
      if (persistedRaw) {
        try {
          const persisted = JSON.parse(persistedRaw) as { pendingIds?: string[]; firstSeenAt?: string; lastVerdict?: unknown; decidedAt?: string };
          pendingIds = Array.isArray(persisted.pendingIds) ? persisted.pendingIds : [];
          firstSeenAt = persisted.firstSeenAt ?? null;
          lastVerdict = (persisted.lastVerdict as typeof lastVerdict) ?? null;
          decidedAt = persisted.decidedAt ?? null;
        } catch {
          // corrupt/absent — report an empty window rather than failing the request
        }
      }
    }

    const prefRows = await getAllPreferencesCached(database);
    const prefMap = toPrefMap(prefRows);
    const config = resolveTrainWindowConfig(prefMap, projectId);
    const holdUntil = prefMap.get(mergeTrainWindowHoldUntilPref.key(projectId)) ?? null;

    let members: { workspaceId: string; issueNumber: number | null; title: string | null }[] = [];
    if (pendingIds.length > 0) {
      const rows = await getTrainWindowMemberSummaries(pendingIds, database);
      const byId = new Map(rows.map((r) => [r.workspaceId, r]));
      members = pendingIds.map((id) => byId.get(id) ?? { workspaceId: id, issueNumber: null, title: null });
    }

    let projectedDepartureAt: string | null = null;
    if (firstSeenAt !== null) {
      const firstSeenAtMs = new Date(firstSeenAt).getTime();
      projectedDepartureAt = new Date(firstSeenAtMs + config.maxWaitMs).toISOString();
    }

    return c.json({
      ok: true,
      window: {
        projectId,
        pending: members.map((m) => ({ ...m, readySince: firstSeenAt })),
        config: {
          maxSize: config.maxSize,
          maxWaitMs: config.maxWaitMs,
          posture: config.posture,
          batchingFromPosture: config.batchingFromPosture,
          postureNote: config.batchingFromPosture ? formatPostureNote(config.posture) : null,
        },
        lastVerdict,
        decidedAt,
        firstSeenAt,
        projectedDepartureAt,
        holdUntil,
      },
    });
  });

  /**
   * POST /api/merge-queue/window/release
   *
   * body: { projectId: string }
   *
   * Operator control (#1186): depart now. Clears any operator hold, empties the accumulator,
   * and immediately runs the currently-pending ids through the queue (train strategy when
   * there are >= 2, same as a normal window closing). Logged either way.
   */
  router.post("/window/release", async (c) => {
    const { projectId } = await parseJsonBody(c, mergeQueueWindowReleaseBody);
    const orchestrator = getActiveAutoMergeOrchestrator();
    if (!orchestrator) {
      return c.json({ ok: false, error: "auto-merge orchestrator is not running in this process" }, 409);
    }
    const ids = await orchestrator.releaseTrainWindowNow(projectId);
    if (ids.length === 0) {
      return c.json({ ok: true, released: [] });
    }
    // Same partitioning as a normal tick's release (#1180, `runOnce` in auto-merge-orchestrator.ts):
    // an operator-released batch can span repos/base branches just like an automatic one, and
    // `trainEligible` judges a queue call as a whole — one foreign/direct/branch-less member must
    // not sink the whole release into a silent fallback.
    const plan = await queueService.computePlan(ids);
    const partition = partitionMergeRelease(plan.order);
    const splitNote = describeReleasePartition(partition, plan.order.length);
    if (splitNote) console.log(`[merge-queue] window/release ${projectId}: ${splitNote}`);
    for (const batch of releaseBatches(partition)) {
      for await (const event of queueService.executeQueue(batch.workspaceIds, {
        skipOnConflict: true,
        strategy: batch.strategy,
      })) {
        if (event.type === "done") break;
      }
    }
    return c.json({ ok: true, released: ids });
  });

  /**
   * POST /api/merge-queue/window/hold
   *
   * body: { projectId: string, minutes: number }
   *
   * Operator control (#1186): hold the door for N minutes — `decideMergeTrainRelease` refuses
   * to release (`operator_hold`) even past max_size/max_wait until the deadline passes or
   * `/window/release` clears it early. Logged.
   */
  router.post("/window/hold", async (c) => {
    const body = await parseJsonBody(c, mergeQueueWindowHoldBody);
    const orchestrator = getActiveAutoMergeOrchestrator();
    if (!orchestrator) {
      return c.json({ ok: false, error: "auto-merge orchestrator is not running in this process" }, 409);
    }
    const holdUntil = await orchestrator.holdTrainWindow(body.projectId, body.minutes);
    return c.json({ ok: true, holdUntil });
  });

  return router;
}
