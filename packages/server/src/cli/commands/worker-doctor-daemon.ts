// The doctor, as the worker DAEMON uses it (#1370): keeping the compact summary of its own doctor that the board shows as
// a setup checklist. Split from `worker-doctor.ts`, which owns the checks themselves.
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { doctorSignature, summarizeDoctorChecks, type WorkerDoctorSummary } from "@agentic-kanban/shared/lib/worker-doctor-summary";
import type { WorkerHarness } from "../../worker/worker-harness.js";
import { runWorkerDoctor } from "./worker-doctor.js";
/**
 * The daemon's running summary of its OWN doctor (#1370): runs the machine-only checks, keeps the
 * latest summary, and says which one still has to reach the board — `pending()` is the summary only
 * while it differs from what `markSent` last recorded, so a beat carries it when it CHANGED, not
 * every 30 s. Disabled (tests, callers that opt out) = `current()`/`pending()` stay undefined.
 */
export function createDoctorSummaryTracker(cfg: {
  enabled: boolean;
  log: (line: string) => void;
  boardUrl: string;
  stateFile: string;
  providers: string[];
  profiles?: string[] | undefined;
  harness?: WorkerHarness | undefined;
  home?: string | undefined;
  workRoot?: string | undefined;
  runningEntry?: string | null;
  refreshIntervalMs?: number;
}) {
  let summary: WorkerDoctorSummary | undefined;
  let sentSignature: string | null = null;
  let running = false;
  let ranAtMs = 0;
  async function refresh(): Promise<void> {
    if (!cfg.enabled || running) return;
    running = true;
    try {
      const report = await runWorkerDoctor({
        boardUrl: cfg.boardUrl,
        stateFile: cfg.stateFile,
        providers: cfg.providers,
        local: true,
        ...(cfg.profiles ? { profiles: cfg.profiles } : {}),
        ...(cfg.harness ? { harness: cfg.harness } : {}),
        ...(cfg.home ? { home: cfg.home } : {}),
        ...(cfg.workRoot ? { workRoot: cfg.workRoot } : {}),
        runningEntry: cfg.runningEntry ?? null,
      });
      summary = summarizeDoctorChecks(report.checks, {
        providers: cfg.providers,
        ...(cfg.harness ? { harnessMode: cfg.harness.mode } : {}),
      });
    } catch (err) {
      cfg.log(`[worker] doctor summary failed (continuing): ${errorMessage(err)}`);
    } finally {
      running = false;
      ranAtMs = Date.now();
    }
  }
  return {
    refresh,
    /** Background re-run when the last one is older than the interval; never awaited by a beat. */
    refreshIfDue(nowMs: number = Date.now()): void {
      if (cfg.enabled && nowMs - ranAtMs >= (cfg.refreshIntervalMs ?? 5 * 60 * 1000)) void refresh();
    },
    current: (): WorkerDoctorSummary | undefined => summary,
    pending: (): WorkerDoctorSummary | undefined =>
      summary && doctorSignature(summary) !== sentSignature ? summary : undefined,
    markSent(sent: WorkerDoctorSummary): void {
      sentSignature = doctorSignature(sent);
    },
  };
}
