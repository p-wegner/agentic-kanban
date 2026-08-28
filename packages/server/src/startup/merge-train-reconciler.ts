/**
 * #906 — recovery for a `merge_trains` row left in `assembling` or `gating` when the process
 * that was running it died: a `tsx watch` reload, a crash, or an intentional restart mid-gate.
 *
 * A train's whole lifecycle runs inside ONE in-process async generator
 * (`runTrainStrategy` in `merge-queue.service.ts`), driven by a single HTTP request holding
 * an SSE stream open. There is no session row, no PID, no heartbeat for it the way a workspace
 * agent has — the request IS the job. So the instant this reconciler's boot pass runs, any row
 * still `assembling`/`gating` is DEFINITIONALLY orphaned: the process that would be running it
 * either died (this restart) or never existed in this process's lifetime. There is no "is it
 * still running" check to make, unlike the born-blocked/install-staleness reconcilers, which
 * must distinguish a live runner from a dead one — a merge train has no live-runner case to
 * distinguish AT BOOT, since boot is the one moment nothing has started yet.
 *
 * The decision is therefore just: can the batch still be resumed cheaply, or must it be
 * abandoned with a reason? A train ref (`kanban/train/<label>`) is scratch and is always
 * deleted in `runTrainAttempt`'s `finally` — but that `finally` only runs if the process lives
 * long enough to reach it, so a dead-mid-gate train may have left its ref behind. Resuming
 * means re-running `runTrainStrategy` from scratch for the SAME member set: assembly is cheap
 * (a few `--no-ff` merges), so re-assembling onto a fresh ref costs little and cannot lose
 * work — the members' own branches are untouched by an interrupted train (assembly only ever
 * writes to the disposable train ref, per `merge-train.service.ts`'s header). What can NOT be
 * resumed is a train whose members are no longer viable, which is why this reconciler holds
 * NO built-in retry cap of its own — a member that keeps producing an unresumable train will
 * hit the ordinary queue/gate failure paths on its next real attempt, exactly like any other
 * merge.
 *
 * `abandoned` is spelled the same way {@link recordSkipped}/`decideBornBlockedAction` spell an
 * unrecoverable state: a NAMED terminal outcome with a reason, never a silent drop. The row
 * stays in the table (readable by `GET /api/merge-trains`) rather than being deleted, so the
 * history a "Merge train" panel shows includes the abandonment.
 */
import type { Database } from "../db/index.js";
import {
  getMergeTrain,
  listMergeTrainsInStates,
  updateMergeTrainState,
  type MergeTrainRow,
} from "../repositories/merge-train.repository.js";
import { emptyPassReport, formatPassReportBody, recordActed, type PassReport } from "../lib/pass-report.js";
import { startPeriodicSweep, type PeriodicSweepHandle } from "../lib/periodic-sweep.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/** How often the reconciler sweeps for stranded trains (defence in depth beyond the boot pass). */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export type MergeTrainReconcileAction = "resume" | "abandon";

/**
 * Decide what to do with one stranded train row. Pure — no DB, no git — so the policy is
 * testable without either.
 *
 * `attempt` lets a caller cap how many times a resume may be retried for the SAME train id,
 * without the reconciler itself needing to track state across sweeps: `reconciledReason`
 * already carries a `resume attempt N` marker once a row has been resumed at least once (see
 * {@link reconcileStrandedMergeTrains}), so re-parsing it here is enough to bound retries.
 */
export function decideMergeTrainReconcileAction(
  row: Pick<MergeTrainRow, "reconciledReason">,
  maxResumeAttempts = 2,
): { action: MergeTrainReconcileAction; reason: string } {
  const priorAttempts = countPriorResumeAttempts(row.reconciledReason);
  if (priorAttempts >= maxResumeAttempts) {
    return {
      action: "abandon",
      reason: `resumed ${priorAttempts} time(s) already without landing — giving up rather than retrying indefinitely`,
    };
  }
  return {
    action: "resume",
    reason: priorAttempts > 0
      ? `retrying (attempt ${priorAttempts + 1}) after a previous resume also left it stranded`
      : "no live job can exist for a row found at server boot — re-running the batch from its member set",
  };
}

const RESUME_ATTEMPT_RE = /resume attempt (\d+)/;

function countPriorResumeAttempts(reconciledReason: string | null | undefined): number {
  if (!reconciledReason) return 0;
  const match = RESUME_ATTEMPT_RE.exec(reconciledReason);
  return match ? Number.parseInt(match[1], 10) : 0;
}

export interface MergeTrainSweepResult extends PassReport {
  resumed: string[];
  abandoned: string[];
}

/**
 * Sweep every `assembling`/`gating` row and resolve it — resume by re-invoking the caller's
 * train runner, or mark `abandoned` with a reason.
 *
 * `runTrain` is injected rather than imported: this module lives in `startup/`, and
 * `merge-queue.service.ts`'s `executeQueue`/`runTrainStrategy` needs a `boardEvents` +
 * `getSessionManager` wiring this sweep does not otherwise need, exactly the shape
 * `born-blocked-reconciler.ts` uses `runSetup` for. Absent (the default), a stranded row is
 * marked `abandoned` outright — resuming is a caller opt-in, never assumed.
 */
export async function reconcileStrandedMergeTrains(
  opts: {
    database?: Database;
    now?: string;
    maxResumeAttempts?: number;
    log?: (message: string) => void;
    /** Re-run the batch for a stranded row's member set. Returning normally means "resumed". */
    runTrain?: (row: MergeTrainRow) => Promise<void>;
  } = {},
): Promise<MergeTrainSweepResult> {
  const database = opts.database;
  const now = opts.now ?? new Date().toISOString();
  const log = opts.log ?? ((message: string) => console.log(`[merge-train-reconciler] ${message}`));

  const rows = await listMergeTrainsInStates(["assembling", "gating"], database).catch(() => [] as MergeTrainRow[]);
  const result: MergeTrainSweepResult = { ...emptyPassReport(rows.length), resumed: [], abandoned: [] };

  for (const row of rows) {
    const { action, reason } = decideMergeTrainReconcileAction(row, opts.maxResumeAttempts);
    const ref = `train ${row.id} (${row.label}, project ${row.projectId})`;

    if (action === "abandon" || !opts.runTrain) {
      const abandonReason = action === "abandon"
        ? reason
        : `no resume runner configured — ${reason}`;
      await updateMergeTrainState(row.id, {
        state: "abandoned",
        reconciledReason: abandonReason,
        finishedAt: now,
      }, database);
      result.abandoned.push(row.id);
      recordActed(result, row.id, "abandoned");
      log(`abandoned ${ref} — ${abandonReason}`);
      continue;
    }

    const priorAttempts = countPriorResumeAttempts(row.reconciledReason);
    const resumeReason = `resume attempt ${priorAttempts + 1}: ${reason}`;
    log(`resuming ${ref} — ${resumeReason}`);
    try {
      await opts.runTrain(row);
      result.resumed.push(row.id);
      recordActed(result, row.id, "resumed");
      // A successful `runTrain` is expected to drive the row to its own terminal state
      // (landed/red) itself — it is the same code path a fresh request takes. Only stamp the
      // attempt marker if it is SOMEHOW still non-terminal afterwards (re-read from the DB,
      // not the stale `row` captured before the resume ran), so a future sweep can see this
      // was already tried once — and so we never clobber a terminal state `runTrain` just
      // persisted back to `assembling`/`gating`, which would re-queue an already-landed train
      // for resume forever.
      const after = await getMergeTrain(row.id, database).catch(() => undefined);
      if (after && (after.state === "assembling" || after.state === "gating")) {
        await updateMergeTrainState(row.id, { state: after.state, reconciledReason: resumeReason }, database).catch(() => undefined);
      }
    } catch (err) {
      const failReason = `resume attempt ${priorAttempts + 1} failed: ${errorMessage(err)}`;
      await updateMergeTrainState(row.id, {
        state: "abandoned",
        reconciledReason: failReason,
        finishedAt: now,
      }, database).catch(() => undefined);
      result.abandoned.push(row.id);
      recordActed(result, row.id, "abandoned-after-resume-error");
      log(`abandoned ${ref} — ${failReason}`);
    }
  }

  log(formatPassReportBody(result));
  return result;
}

let sweep: PeriodicSweepHandle | null = null;

export function startMergeTrainReconciler(
  opts: { intervalMs?: number; runTrain?: (row: MergeTrainRow) => Promise<void> } = {},
): void {
  stopMergeTrainReconciler();
  sweep = startPeriodicSweep({
    name: "merge-train-reconciler",
    intervalMs: opts.intervalMs ?? SWEEP_INTERVAL_MS,
    tick: () => reconcileStrandedMergeTrains({ runTrain: opts.runTrain }),
  });
}

export function stopMergeTrainReconciler(): void {
  sweep?.stop();
  sweep = null;
}
