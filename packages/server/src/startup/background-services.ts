import type { Database } from "../db/index.js";
import type { BoardEventSink } from "../services/board-events.js";
import type { SessionManager } from "../services/session.manager.js";
import { setupScheduledTasks, stopScheduledTasks } from "./scheduled-tasks.js";
import { createWorkspaceService } from "../services/workspace.service.js";
import { createScheduledRunService } from "../services/scheduled-run.service.js";
import { getPreference, setPreference } from "../repositories/preferences.repository.js";
import { projects } from "@agentic-kanban/shared/schema";
import {
  isPidAlive,
  promoteCadencePrefKey,
  promoteCadenceStatePrefKey,
  runDuePromoteCadences,
  spawnPromoteCadenceRun,
} from "../services/promote-cadence.service.js";
import { startAutoMergeOrchestrator, stopAutoMergeOrchestrator } from "./auto-merge-orchestrator.js";
import { startStrandedReviewReconciler, stopStrandedReviewReconciler } from "./stranded-review-reconciler.js";
import { startStrandedPlanReconciler, stopStrandedPlanReconciler } from "./plan-mode-reconciler.js";
import { startZombieFixSessionReconciler, stopZombieFixSessionReconciler } from "./zombie-fix-session-reconciler.js";
import { startAncestorBranchReconciler, stopAncestorBranchReconciler } from "./ancestor-branch-reconciler.js";
import { startStalledInProgressReconciler, stopStalledInProgressReconciler } from "./stalled-in-progress-reconciler.js";
import { startReadyBaseConflictHealer, stopReadyBaseConflictHealer } from "./ready-base-conflict-healer.js";
import { createReadyBaseConflictHealDeps } from "../services/ready-base-conflict-ports.js";
import { startBornBlockedReconciler, stopBornBlockedReconciler } from "./born-blocked-reconciler.js";
import { startWorkflowNodeDivergenceReconciler, stopWorkflowNodeDivergenceReconciler } from "./workflow-node-divergence-reconciler.js";
import { startDoneUnmergedSweep, stopDoneUnmergedSweep } from "./done-unmerged-invariant-sweep.js";
import { startTerminalWorkspaceReaper, stopTerminalWorkspaceReaper } from "./terminal-workspace-reaper.js";
import { startServiceStackReaper, stopServiceStackReaper } from "./service-stack-reaper.js";
import { startMonitorButler, stopMonitorButler } from "../services/monitor-butler.js";
import { startProjectConductorSupervisor } from "../services/project-conductor.service.js";
import { startBackupScheduler, stopBackupScheduler } from "./backup-scheduler.js";
import { startSessionMessagePruner, stopSessionMessagePruner } from "../services/session-message-pruner.service.js";
import { startBaseBranchHealthReconciler, stopBaseBranchHealthReconciler } from "./base-branch-health-reconciler.js";
import { startCodeHealthScanReconciler, stopCodeHealthScanReconciler } from "./code-health-scan-reconciler.js";
import { startCiStatusReconciler, stopCiStatusReconciler } from "./ci-status-reconciler.js";
import { startWorkerConnectionReaper, stopWorkerConnectionReaper } from "../services/worker-connection-reaper.service.js";
import { getWorkerFleet } from "../services/worker-fleet.service.js";
import { startInstallStalenessReconciler, stopInstallStalenessReconciler } from "./install-staleness-reconciler.js";
import { startTestImpactMapReconciler, stopTestImpactMapReconciler } from "./test-impact-map-reconciler.js";
import { startMergeTrainReconciler, stopMergeTrainReconciler } from "./merge-train-reconciler.js";
import { createMergeQueueService } from "../services/merge-queue.service.js";
import { updateMergeTrainState } from "../repositories/merge-train.repository.js";
import { startMergeRunReconciler, stopMergeRunReconciler } from "./merge-run-reconciler.js";
import { setMergeRunMarkerPort } from "../services/merge-job.service.js";
import { clearMergeRun, setMergeRun } from "../repositories/merge-run.repository.js";
import { startAgentSessionRegistryReaper, stopAgentSessionRegistryReaper, isMachineGlobalReapAllowed } from "./agent-session-registry-reaper.js";
import { startWorkerHealthProbe, stopWorkerHealthProbe } from "../services/worker-health-probe.service.js";
import { DB_LOCATION } from "../db/data-dir.js";
import { startStaleTempSweeper, stopStaleTempSweeper } from "./stale-temp-sweep.js";
import { startNonBlockingSetupRetryReconciler, stopNonBlockingSetupRetryReconciler } from "./non-blocking-setup-retry-reconciler.js";
import { startCommitMsgHookBackfill, stopCommitMsgHookBackfill } from "./commit-msg-hook-backfill.js";
import { startFlushActivityLogReconciler, stopFlushActivityLogReconciler } from "./flush-activity-log-reconciler.js";
import { startQueueFlushSweep, stopQueueFlushSweep } from "./queue-flush-sweep.js";
import { createQueueFlushService } from "../services/queue-flush.service.js";
import { startProgressInvariantSweep, stopProgressInvariantSweep, createProgressRecoveryPort } from "./progress-invariant-sweep.js";
import { createWorkspaceSessionService } from "../services/workspace-session.service.js";
import { startManualReview } from "../services/review.service.js";
import { getRecentSessionBriefs } from "../repositories/session.repository.js";
import { getWorkerBuildService, startWorkerBuildPrewarm } from "../services/worker-build.service.js";
import { startWorkerAutoUpdate, stopWorkerAutoUpdate } from "../services/worker-auto-update.service.js";

/**
 * Background-service (start/stop) plugin registry — the append target for periodic
 * reconcilers, schedulers and supervisors that used to be a hand-written
 * start-call + cleanup-push list inlined in the 375-commit composition root
 * `server-start.ts` (arch-review §1.5, conflict-tax reduction). Adding a new
 * background service is now "add one entry to BACKGROUND_SERVICES here" instead of
 * editing the hot startup file.
 *
 * `server-start.ts` iterates this array in order, calls each `start(ctx)`, and
 * collects the returned cleanup (if any) into its reversible cleanup list. The
 * ARRAY ORDER is the start order and (reversed) the shutdown order — keep it stable.
 * No behaviour change vs the previous inline list.
 */

/** Cleanup callback returned by a background service's `start`. */
export type CleanupFn = () => void;

/** Everything a background service may need at startup, injected by server-start.ts. */
export interface BackgroundServiceContext {
  db: Database;
  boardEvents: BoardEventSink;
  getSessionManager: () => SessionManager;
  serverPort: number;
  /** In-memory set of review session ids, owned by the workflow engine. */
  reviewSessionIds: Set<string>;
  /** The workflow engine's session-exit entry point, for sweeps that replay a lost exit (#1439). */
  runWorkflowOnExit: (workspaceId: string, sessionId: string, exitCode: number | null, wasPlanMode?: boolean) => Promise<unknown>;
  /** Absolute path to the board's own repo root (Conductor supervisor). */
  boardRepoRoot: string;
}

export interface BackgroundService {
  name: string;
  /**
   * Start the service. Return a cleanup function to be run on shutdown, or void if
   * the service registers no teardown. May be async (e.g. reads a preference first).
   */
  start(ctx: BackgroundServiceContext): CleanupFn | void | Promise<CleanupFn | void>;
}

export const BACKGROUND_SERVICES: BackgroundService[] = [
  {
    name: "scheduled-tasks",
    start({ db, boardEvents, getSessionManager }) {
      // Direct service call instead of the old self-HTTP fetch (#402): the scheduler
      // invokes the same service function the POST /api/scheduled-runs/:id/run route uses.
      const workspaceService = createWorkspaceService({ database: db, getSessionManager, boardEvents });
      const scheduledRunService = createScheduledRunService({ database: db, createWorkspace: workspaceService.createWorkspace });
      setupScheduledTasks({
        runScheduledRun: (id, triggeredBy) => scheduledRunService.run(id, triggeredBy),
        // #1238 — the promotion cadence: real prefs, real projects, a detached `promote.mjs` run.
        runPromoteCadenceTick: async () => {
          const fired = await runDuePromoteCadences({
            listProjects: async () => {
              const rows = await db.select({ id: projects.id, repoPath: projects.repoPath }).from(projects);
              return rows.filter((r) => !!r.repoPath).map((r) => ({ projectId: r.id, repoPath: r.repoPath }));
            },
            getCadencePref: (projectId) => getPreference(promoteCadencePrefKey(projectId), db),
            getStatePref: (projectId) => getPreference(promoteCadenceStatePrefKey(projectId), db),
            setStatePref: (projectId, value) => setPreference(promoteCadenceStatePrefKey(projectId), value, db),
            fire: (project) => spawnPromoteCadenceRun(project),
            isRunAlive: isPidAlive,
          });
          for (const r of fired) {
            if (r.fired) console.log(`[scheduler] fired promotion cadence for project ${r.projectId} (pid ${r.pid ?? "?"}; rc ${r.rcBranch ?? "<none>"} ${r.rcState ?? ""})`);
            else if (r.skipped === "fire_failed" || r.skipped === "invalid") console.warn(`[scheduler] promotion cadence for project ${r.projectId} not fired (${r.skipped}): ${r.error ?? "unknown"}`);
          }
        },
      });
      return stopScheduledTasks;
    },
  },
  {
    name: "auto-merge-orchestrator",
    start({ db, boardEvents, getSessionManager, reviewSessionIds }) {
      // #1212: `reviewSessionIds` so the completion-state reconciler can re-queue a review it
      // had to reap, through the same service function the review route calls.
      startAutoMergeOrchestrator({ database: db, boardEvents, getSessionManager, reviewSessionIds });
      return stopAutoMergeOrchestrator;
    },
  },
  {
    // Crash-safe recovery for work stranded in "In Review" because the auto-review
    // handshake never fired (#529): re-launches the review so the chain can complete.
    name: "stranded-review-reconciler",
    start({ boardEvents, getSessionManager, reviewSessionIds }) {
      startStrandedReviewReconciler({ getSessionManager, boardEvents, reviewSessionIds });
      return stopStrandedReviewReconciler;
    },
  },
  {
    // Crash-safe recovery for plan-mode workspaces stranded with planMode stuck true (#924):
    // recovers the captured plan (or clears planMode + marks blocked) so the workspace never
    // silently parks idle re-running read-only on every follow-up turn.
    name: "stranded-plan-reconciler",
    start({ boardEvents, getSessionManager }) {
      startStrandedPlanReconciler({ getSessionManager, boardEvents });
      return stopStrandedPlanReconciler;
    },
  },
  {
    // Crash-safe recovery for zombie fix-and-merge/review sessions: sessions that are
    // marked 'running' but have zero output messages and no live process (#596).
    name: "zombie-fix-session-reconciler",
    start({ boardEvents }) {
      startZombieFixSessionReconciler({ boardEvents });
      return stopZombieFixSessionReconciler;
    },
  },
  {
    name: "ancestor-branch-reconciler",
    start() {
      startAncestorBranchReconciler();
      return stopAncestorBranchReconciler;
    },
  },
  {
    // The one wedge no other reconciler can even SEE (#394): a workspace born `blocked` with zero
    // session rows. `reconcileCompletionStates` innerJoins sessions, so it is excluded under every
    // configuration, and the monitor's blocked branch only releases a quota block.
    name: "born-blocked-reconciler",
    start() {
      startBornBlockedReconciler();
      return stopBornBlockedReconciler;
    },
  },
  {
    // Committed work stalled In Progress after a watchdog kill or a restart that lost the queued
    // implement-exit check (#1439): replays the builder exit so the check/review runs.
    name: "stalled-in-progress-reconciler",
    start({ db, runWorkflowOnExit }) {
      startStalledInProgressReconciler({ database: db, runWorkflowOnExit });
      return stopStalledInProgressReconciler;
    },
  },
  {
    // A ready workspace that conflicts with the BASE gets a board rebase, a mechanical CONTINUE.md
    // resolution, or one builder fix turn - not a standing attention line (#1584).
    name: "ready-base-conflict-healer",
    start({ db, boardEvents, getSessionManager }) {
      startReadyBaseConflictHealer(createReadyBaseConflictHealDeps({ database: db, boardEvents, getSessionManager }));
      return stopReadyBaseConflictHealer;
    },
  },
  {
    // Resolves an issue whose workflow NODE and STATUS disagree (#395/#397). The `end`-node case
    // is the expensive one: such an issue left the monitor walk entirely, so committed work sat
    // unmerged for ~1000 minutes with auto-merge on and nothing ever looked at it.
    name: "workflow-node-divergence-reconciler",
    start() {
      startWorkflowNodeDivergenceReconciler();
      return stopWorkflowNodeDivergenceReconciler;
    },
  },
  {
    // Safe forward-only auto-recovery: merges clean ahead-only Done-but-unmerged branches
    // directly into base (forward-merging can't lose work). Conflicted / too-far-behind /
    // 0-ahead candidates remain log-only. Never reopens an issue.
    name: "done-unmerged-scanner",
    start() {
      startDoneUnmergedSweep();
      return stopDoneUnmergedSweep;
    },
  },
  {
    // Keeps terminal issue workspace rows from inflating WIP/merge-queue counts after
    // git proves the branch has no unmerged ahead work.
    name: "terminal-workspace-reaper",
    start() {
      startTerminalWorkspaceReaper();
      return stopTerminalWorkspaceReaper;
    },
  },
  {
    // Periodic orphaned service-stack reaper (#52). The boot reaper (server-start.ts)
    // runs ONCE; on a long-lived autodrive board a stack leaked by a swallowed down —
    // or stranded on an open "error" workspace — stayed leaked for the life of the
    // process. This re-runs the reap on an interval, shielding in-flight creates.
    name: "service-stack-reaper",
    start() {
      startServiceStackReaper();
      return stopServiceStackReaper;
    },
  },
  {
    // Closes worker sockets whose peer has gone silent (#706). Nothing else ever removes
    // one without a delivered close, so a network partition left a dead worker in the
    // connection map indefinitely and the Worker Fleet view rendered it as connected —
    // measured at 68 minutes from the worker's side. DISPATCH was never affected and is
    // deliberately untouched; see the module header.
    name: "worker-connection-reaper",
    start({ db }) {
      const fleet = getWorkerFleet(db);
      startWorkerConnectionReaper({ registry: fleet.registry, connections: fleet.connections });
      return stopWorkerConnectionReaper;
    },
  },
  {
    // Autonomous Monitor Butler — cron-driven board-health agent (gated by the
    // monitor_butler_enabled preference; off by default). See services/monitor-butler.ts.
    name: "monitor-butler",
    start() {
      startMonitorButler();
      return stopMonitorButler;
    },
  },
  {
    name: "project-conductor-supervisor",
    start({ db, boardRepoRoot }) {
      const supervisor = startProjectConductorSupervisor({ database: db, boardRepoRoot });
      return () => supervisor.stop();
    },
  },
  {
    // Periodic database backups (interval from the backup_interval_min preference).
    // Owns its own try/catch so a preference-read failure is non-fatal to startup —
    // matches the previous inline behaviour exactly.
    name: "backup-scheduler",
    async start() {
      try {
        const raw = await getPreference("backup_interval_min");
        const intervalMin = raw == null || raw === "" ? 30 : Number(raw);
        startBackupScheduler(Number.isFinite(intervalMin) ? intervalMin : 30);
        return stopBackupScheduler;
      } catch (err) {
        console.warn("[backup] failed to start scheduler (non-fatal):", err instanceof Error ? err.message : err);
      }
    },
  },
  {
    // Periodic session_messages pruning — keeps DB size bounded as workspace history grows.
    name: "session-message-pruner",
    start({ db }) {
      startSessionMessagePruner(db);
      return stopSessionMessagePruner;
    },
  },
  {
    // Periodic base-branch verify (#491): runs verify_script against each project's CURRENT
    // base-branch tip so "is the base green right now" has an answer independent of any
    // branch's own pre-merge gate.
    name: "base-branch-health-reconciler",
    start({ db }) {
      startBaseBranchHealthReconciler(db);
      return stopBaseBranchHealthReconciler;
    },
  },
  {
    // #1562: GitHub Actions status of the base branch (read-only `gh run list`); a sustained-red
    // workflow becomes a console ATTENTION line, a delivery chip and a per-workflow heal ticket.
    name: "ci-status-reconciler",
    start({ db }) {
      startCiStatusReconciler(db);
      return stopCiStatusReconciler;
    },
  },
  {
    // #1619 — the caller of the code-health report: scans each new base-branch tip once (and
    // re-scans a quiet project daily) so the ledger moves and the cleanup ticket can fire.
    name: "code-health-scan-reconciler",
    start({ db }) {
      if (process.env.VITEST || process.env.NODE_ENV === "test") return;
      startCodeHealthScanReconciler(db);
      return stopCodeHealthScanReconciler;
    },
  },
  {
    // #993 — the map refresh was a PHASE INSIDE the monitor cycle, so a project whose
    // `start_mode` is `manual` (a true kill-switch, decision 008) never refreshed it. Measured:
    // this board's map sat 46 commits stale and every selection silently escalated
    // `tier: impact` -> `tier: package`, in the merge gate AND in every builder's inner loop,
    // while `test_impact_map_refresh` was on. The monitor phase stays (it lands before
    // `runAutoStart`, so a builder forks from the branch it just committed); the pass is
    // idempotent and short-circuits on a freshness check, so running both costs nothing.
    name: "test-impact-map-reconciler",
    start({ db }) {
      startTestImpactMapReconciler({ database: db });
      return stopTestImpactMapReconciler;
    },
  },
  {
    // #685 — a deferred sibling install's `pending`/`running` row has no other way out: no
    // timeout, no re-run path, and the row survives a server restart or a skipped deferred
    // step untouched. This sweep is what finally reads `installUpdatedAt`.
    name: "install-staleness-reconciler",
    start() {
      startInstallStalenessReconciler();
      return stopInstallStalenessReconciler;
    },
  },
  {
    // #906 — a `merge_trains` row left `assembling`/`gating` when the process running it died
    // (tsx-watch reload, crash, restart mid-gate). At BOOT no live-job check is needed: the
    // row's whole lifecycle is one in-process request, so anything found then is orphaned by
    // construction. The PERIODIC sweep is different (#1181): it consults the in-process live
    // registry (`services/merge-train-live-registry.ts`) and skips rows this process is still
    // running. Resumed or marked `abandoned` with a reason — never silently dropped.
    name: "merge-train-reconciler",
    start({ db, boardEvents, getSessionManager }) {
      const queueService = createMergeQueueService({ database: db, boardEvents, getSessionManager });
      startMergeTrainReconciler({
        boardEvents,
        database: db,
        // Re-run the batch for the stranded row's member set. `executeQueue` re-derives the
        // plan from the workspace ids and re-enters `runTrainStrategy` via the normal
        // `strategy: "train"` dispatch — the same path a fresh request takes. Without this,
        // every `assembling`/`gating` row found at boot was unconditionally abandoned and the
        // "or resumes" half of the acceptance criteria was unreachable.
        //
        // `beginMergeTrain` REFUSES to start a new train (returns `"already_in_flight"`) whenever
        // any `assembling`/`gating` row already exists for the project, same member set or not
        // (#1158) — so the stranded row this callback was handed must be moved out of
        // `assembling`/`gating` BEFORE re-entering `executeQueue`, or the resume would refuse
        // against its own row and silently no-op instead of re-running the batch. Abandoning it
        // first (superseded, not a failure verdict) is also what keeps the two writes separate
        // if the reconciler ever raced a fresh caller for the same batch: this row's history
        // entry says it was superseded, and the freshly-minted row's says what actually happened.
        async runTrain(row) {
          await updateMergeTrainState(row.id, {
            state: "abandoned",
            reconciledReason: "superseded by a freshly re-assembled train after a stranded boot-time recovery",
            finishedAt: new Date().toISOString(),
          }, db);
          boardEvents?.broadcast(row.projectId, "merge_train_changed");
          const memberWorkspaceIds = JSON.parse(row.memberWorkspaceIds) as string[];
          for await (const _event of queueService.executeQueue(memberWorkspaceIds, { strategy: "train" })) {
            // The fresh train (a new `merge_trains` row) persists its own terminal state via
            // `finishMergeTrain`; nothing here needs to mirror it onto the now-abandoned row.
          }
        },
      });
      return stopMergeTrainReconciler;
    },
  },
  {
    // #945 — a merge job lives only in memory, so a restart mid-gate left the workspace
    // `readyForMerge: true` / `idle` with NO record that a merge had ever been attempted.
    // Two halves, wired together here because they are one feature: installing the durable
    // marker writer (the registry defaults to a no-op so its unit suites never touch the DB),
    // and the sweep that turns a marker with no live job into a recorded terminal state.
    name: "merge-run-reconciler",
    start({ db }) {
      setMergeRunMarkerPort({
        set: (workspaceId, values) => setMergeRun(workspaceId, values, db),
        clear: (workspaceId) => clearMergeRun(workspaceId, db),
      });
      startMergeRunReconciler({ database: db });
      return stopMergeRunReconciler;
    },
  },
  {
    // #708 — the board kills agents by PID, and a killed Claude process never removes its
    // own `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json`. The files then name PIDs the OS
    // recycles, so anything reading that registry sees sessions that do not exist. Last
    // in the list because it touches no board state at all: nothing else waits on it.
    name: "agent-session-registry-reaper",
    start() {
      // #1103 — this sweep reaps `~/.claude*` session files for the WHOLE machine, which is
      // correct only for the single operated board (default DB, source "home-fallback"). A
      // worktree/scratch server opened elsewhere (an explicit AGENTIC_KANBAN_DIR/DB_URL, or an
      // in-checkout dev DB) must not own machine-global state it has no business touching.
      if (!isMachineGlobalReapAllowed(DB_LOCATION.source)) {
        console.log(
          `[startup] skipping agent-session-registry-reaper: this process opened a non-default database ` +
            `(source: ${DB_LOCATION.source}), so it is not the machine's operated board (#1103)`,
        );
        return;
      }
      startAgentSessionRegistryReaper();
      return stopAgentSessionRegistryReaper;
    },
  },
  {
    // #901 — a wedged daemon holds its socket and keeps heartbeating, so the two conditions
    // `filterEligibleWorkers` checks both say yes about a worker that can no longer launch
    // anything. This asks it, on an interval, to prove it can still process a message.
    name: "worker-health-probe",
    start({ db }) {
      startWorkerHealthProbe(getWorkerFleet(db).health);
      return stopWorkerHealthProbe;
    },
  },
  {
    // #1110 — the boot-time-only temp sweep (`STARTUP_AUDIT_TASKS`, #1050) never re-runs on a
    // long-lived server, so a probe root leaked mid-session (a killed process, a failed
    // removal) sat on disk until the next restart. This re-runs the same ownership-safe sweep
    // hourly so the gap is an hour, not "until whenever this board happens to restart".
    name: "stale-temp-sweeper",
    start() {
      startStaleTempSweeper();
      return stopStaleTempSweeper;
    },
  },
  {
    // #1125 — the non-blocking setup-script path never blocks a workspace and so is never
    // reached by born-blocked-reconciler; a failure classified as the pnpm-store I/O fault
    // otherwise sat unretried forever with only a butler event to show for it.
    name: "non-blocking-setup-retry-reconciler",
    start() {
      startNonBlockingSetupRetryReconciler();
      return stopNonBlockingSetupRetryReconciler;
    },
  },
  {
    // #1214 — #976's BOM-stripping hook never installed in a linked worktree, so every live
    // workspace created before the fix still commits without the backstop. This installs it
    // into those worktrees rather than making the operator recreate them.
    name: "commit-msg-hook-backfill",
    start({ db }) {
      startCommitMsgHookBackfill({ database: db });
      return stopCommitMsgHookBackfill;
    },
  },
  {
    // #1253 (#1246 follow-up) — logs every flush and heal-state transition to board_health_events.
    // See the module header: flush-state.json has no writer yet and no push notification, so this
    // is a periodic re-read + diff against a per-project cursor.
    name: "flush-activity-log-reconciler",
    start({ db }) {
      startFlushActivityLogReconciler({ database: db });
      return stopFlushActivityLogReconciler;
    },
  },
  {
    // #1463 (decision 020) — the flush tick: evaluates `queue_flush_<id>=auto` and advances every
    // open flush record through its heal states. The manual door is `POST /queue/flush`.
    name: "queue-flush-sweep",
    start({ db, boardEvents, getSessionManager }) {
      const queueService = createMergeQueueService({ database: db, boardEvents, getSessionManager });
      const service = createQueueFlushService({ database: db, executeQueue: (ids, opts) => queueService.executeQueue(ids, opts) });
      startQueueFlushSweep({ database: db, service });
      return stopQueueFlushSweep;
    },
  },
  {
    // #1561 — the progress invariant: every open ticket of a monitor-driven project has a live
    // driver (session, placed gate job, future retry from the current sha, train, or human hold),
    // or it is recovered once per hour and then escalated. Replaces one-sweep-per-stall-shape.
    name: "progress-invariant-sweep",
    start({ db, boardEvents, getSessionManager, reviewSessionIds, runWorkflowOnExit }) {
      const sessionService = createWorkspaceSessionService({ database: db, boardEvents, getSessionManager });
      startProgressInvariantSweep({
        database: db,
        recovery: createProgressRecoveryPort({
          database: db,
          runWorkflowOnExit,
          relaunchReview: async (workspaceId) => {
            await startManualReview(db, getSessionManager, boardEvents, reviewSessionIds, workspaceId, false);
          },
          sendBuilderTurn: (workspaceId, content) => sessionService.sendTurn(workspaceId, content),
          lastSessionId: async (workspaceId) => (await getRecentSessionBriefs(workspaceId, 1, db))[0]?.id ?? null,
        }),
      });
      return stopProgressInvariantSweep;
    },
  },
  {
    // #1352 — the worker tarball was packed on the first worker request, so a self-updating
    // worker sat DRAINING behind a 202 for minutes. Pack the current commit at boot and
    // whenever HEAD moves, before any worker asks. Off under tests / KANBAN_WORKER_BUILD_PREWARM=0
    // (pack-worker rewrites package.json in the tree it runs in).
    name: "worker-build-prewarm",
    async start() {
      if (process.env.VITEST || process.env.NODE_ENV === "test" || process.env.KANBAN_WORKER_BUILD_PREWARM === "0") return;
      return startWorkerBuildPrewarm(await getWorkerBuildService());
    },
  },
  {
    // #1610 — a promote left workers on the old build (and train gates kept landing on them). Ask each
    // online worker that runs another worker build to update the moment it is idle, one log line each.
    name: "worker-auto-update",
    start({ db }) {
      if (process.env.VITEST || process.env.NODE_ENV === "test") return;
      startWorkerAutoUpdate(db);
      return stopWorkerAutoUpdate;
    },
  },
];
