import type { Database } from "../db/index.js";
import type { BoardEvents } from "../services/board-events.js";
import type { SessionManager } from "../services/session.manager.js";
import { setupScheduledTasks, stopScheduledTasks } from "./scheduled-tasks.js";
import { createWorkspaceService } from "../services/workspace.service.js";
import { createScheduledRunService } from "../services/scheduled-run.service.js";
import { startAutoMergeOrchestrator, stopAutoMergeOrchestrator } from "./auto-merge-orchestrator.js";
import { startStrandedReviewReconciler, stopStrandedReviewReconciler } from "./stranded-review-reconciler.js";
import { startStrandedPlanReconciler, stopStrandedPlanReconciler } from "./plan-mode-reconciler.js";
import { startZombieFixSessionReconciler, stopZombieFixSessionReconciler } from "./zombie-fix-session-reconciler.js";
import { startAncestorBranchReconciler, stopAncestorBranchReconciler } from "./ancestor-branch-reconciler.js";
import { startBornBlockedReconciler, stopBornBlockedReconciler } from "./born-blocked-reconciler.js";
import { startWorkflowNodeDivergenceReconciler, stopWorkflowNodeDivergenceReconciler } from "./workflow-node-divergence-reconciler.js";
import { startDoneUnmergedScanner, stopDoneUnmergedScanner } from "./done-unmerged-invariant-scanner.js";
import { startTerminalWorkspaceReaper, stopTerminalWorkspaceReaper } from "./terminal-workspace-reaper.js";
import { startServiceStackReaper, stopServiceStackReaper } from "./service-stack-reaper.js";
import { startMonitorButler, stopMonitorButler } from "../services/monitor-butler.js";
import { startProjectConductorSupervisor } from "../services/project-conductor.service.js";
import { startBackupScheduler, stopBackupScheduler } from "./backup-scheduler.js";
import { startSessionMessagePruner, stopSessionMessagePruner } from "../services/session-message-pruner.service.js";
import { startBaseBranchHealthReconciler, stopBaseBranchHealthReconciler } from "./base-branch-health-reconciler.js";
import { getPreference } from "../repositories/preferences.repository.js";

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
  boardEvents: BoardEvents;
  getSessionManager: () => SessionManager;
  serverPort: number;
  /** In-memory set of review session ids, owned by the workflow engine. */
  reviewSessionIds: Set<string>;
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
      setupScheduledTasks({ runScheduledRun: (id, triggeredBy) => scheduledRunService.run(id, triggeredBy) });
      return stopScheduledTasks;
    },
  },
  {
    name: "auto-merge-orchestrator",
    start({ db, boardEvents, getSessionManager }) {
      startAutoMergeOrchestrator({ database: db, boardEvents, getSessionManager });
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
      startDoneUnmergedScanner();
      return stopDoneUnmergedScanner;
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
];
