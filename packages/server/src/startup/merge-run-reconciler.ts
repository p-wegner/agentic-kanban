/**
 * #945 — recovery for a merge whose runner died mid-flight: a `tsx watch` reload, a crash, or an
 * intentional restart while the pre-merge gate was running.
 *
 * The failure, observed live on #919 (2026-08-29). A merge was submitted, the gate ran ~15
 * minutes, and a server restart took the process down. Afterwards:
 *
 *  - `GET /api/workspaces/:id/merge-status` returned `{"job": null}` — the running job record
 *    was simply GONE, not marked failed;
 *  - the workspace was left `readyForMerge: true`, `status: idle`, `mergedAt: null`;
 *  - nothing anywhere recorded that a merge had been attempted.
 *
 * So the workspace sat indefinitely, looking armed and healthy to every consumer including the
 * monitor, and only moved because a human noticed `merge-status` had gone from `running` to
 * `null` without master advancing and resubmitted `POST /:id/merge` by hand. This is DISTINCT
 * from a gate that fails — that records an attempt with a reason and is visibly actionable.
 * Here the evidence of the attempt was destroyed along with it.
 *
 * The invariant to restore: **an armed workspace is always either merging, or carries a
 * recorded reason why it is not.**
 *
 * How this pass makes that true. `merge-job.service.ts` now writes a one-row durable marker
 * (`workspace_merge_run`) for the life of a running job and clears it on EVERY terminal
 * transition (one funnel — `finish()`), so a marker with no live job means the runner died.
 * That is the same "boot is the one moment nothing has started yet" argument
 * `merge-train-reconciler.ts` (#906) makes for `merge_trains`, except this pass ALSO runs on an
 * interval — a marker can be orphaned by a crashed request in a still-live process, not only by
 * a restart — so the "no live job" check is a real check here rather than a boot-time tautology.
 *
 * Each orphan is resolved by RECORDING it, never by silently dropping it: a `merge-attempt`
 * note on the issue timeline naming the restart as the cause and how long the lost run had
 * been going. The workspace is deliberately left ARMED (`readyForMerge` untouched) rather than
 * un-armed: the merge never reached a verdict, so nothing was learned that should withdraw the
 * approval, and leaving it armed is what lets the ordinary auto-merge orchestrator re-submit —
 * option (b) of the ticket, reached through the board's existing retry path instead of a
 * second, private one. The note says so, so an operator on a `manual` project knows a retry is
 * theirs to make.
 *
 * What it deliberately does NOT do: infer whether the lost gate had passed. That question is
 * already answered better elsewhere — `reusePersistedGateVerdict` (#893) reuses a PERSISTED
 * pass when the tips and tier still match, so a re-submitted merge does not re-pay a run that
 * completed before the process died. Guessing here would only risk minting a verdict nobody ran.
 */
import type { Database } from "../db/index.js";
import { clearMergeRun, listMergeRuns, type MergeRunRow } from "../repositories/merge-run.repository.js";
import { getWorkspaceById } from "../repositories/workspace-reads.repository.js";
import { insertIssueComment } from "../repositories/issue-comments.repository.js";
import { getMergeJob } from "../services/merge-job.service.js";
import { emptyPassReport, formatPassReportBody, recordActed, recordSkipped, type PassReport } from "../lib/pass-report.js";
import { startPeriodicSweep, type PeriodicSweepHandle } from "../lib/periodic-sweep.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/** How often the sweep runs, beyond the boot pass (defence in depth, same cadence as #906). */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Delay before the boot pass. The default (25s) is kept deliberately rather than shortened:
 * this is precisely the window in which a caller whose request survived the restart — or the
 * auto-merge orchestrator's own first tick — can re-register a live job for the same workspace,
 * and `hasLiveJob` then holds the marker instead of recording a phantom interruption. Recovering
 * a few seconds earlier buys nothing; a workspace that has sat idle since the restart is not
 * getting worse.
 */
const BOOT_DELAY_MS = 25_000;

export type MergeRunReconcileAction = "recover" | "hold";

/**
 * Decide what to do with one marker row. Pure — no DB, no clock read of its own — so the policy
 * is a table of cases rather than four more branches inside the pass (the `decision function`
 * kind, see the server CLAUDE.md).
 *
 * `hasLiveJob` is the ONLY thing that can hold a row. A marker whose in-memory job is still
 * `running` belongs to this process and is doing exactly what it should; anything else is an
 * orphan, however recent. In particular there is deliberately NO minimum-age grace period: a
 * marker written by a live job is always accompanied by a live job (both happen in
 * `startMergeJob`), so an age threshold could only delay recovery, never make it safer.
 */
export function decideMergeRunReconcileAction(
  row: Pick<MergeRunRow, "jobId" | "startedAt">,
  hasLiveJob: boolean,
  nowMs: number,
): { action: MergeRunReconcileAction; reason: string } {
  if (hasLiveJob) {
    return { action: "hold", reason: `job ${row.jobId} is still running in this process` };
  }
  const startedMs = Date.parse(row.startedAt);
  const ranFor = Number.isFinite(startedMs)
    ? `${Math.max(0, Math.round((nowMs - startedMs) / 60_000))} minutes ago`
    : `at ${row.startedAt}`;
  return {
    action: "recover",
    reason: `merge job ${row.jobId} was submitted ${ranFor} and no job record for it exists any more `
      + "— the process running it died before the merge reached a verdict",
  };
}

/**
 * The timeline note an orphaned merge leaves behind. Separated from the pass so its wording —
 * the entire deliverable of this ticket, since the defect was silence — is assertable without a
 * database.
 */
export function describeInterruptedMerge(reason: string, source: string | null, stillArmed: boolean): string {
  const who = source ? ` (submitted by ${source})` : "";
  return `Merge interrupted by a server restart${who}: ${reason}. No verdict was recorded, so this is not a gate `
    + "failure — nothing was learned about the branch. "
    + (stillArmed
      ? "The workspace is still marked ready-for-merge, so an auto-merge pass will re-submit it; on a manual "
        + "project, re-submit with POST /api/workspaces/:id/merge. A pre-merge gate that had already PASSED before "
        + "the restart is reused rather than re-run (#893)."
      : "The workspace is no longer marked ready-for-merge, so it will not be re-submitted automatically.");
}

export interface MergeRunSweepResult extends PassReport {
  /** Workspace ids whose interrupted merge was recorded and released. */
  recovered: string[];
}

export async function reconcileInterruptedMergeRuns(
  opts: {
    /**
     * The connection to sweep. REQUIRED rather than defaulting to the `db` singleton:
     * `startup/` has no persistence boundary and `startup-persistence-boundary-ratchet.test.ts`
     * (#715) freezes the singleton importers shrink-only, so a new sweep takes its database from
     * the composition root (`BackgroundServiceContext.db`) like an injected dependency.
     */
    database: Database;
    nowMs?: number;
    log?: (message: string) => void;
    /** Injected so a test needs no in-memory job registry. Defaults to the real one. */
    hasLiveJob?: (workspaceId: string) => boolean;
    /**
     * Injected so the "workspace is gone" branch is reachable. The FK is `ON DELETE cascade`,
     * so a marker CANNOT outlive its workspace through the database — the branch exists for the
     * read-then-act window (a workspace deleted between this pass's list and its own lookup)
     * and for a future caller that hands rows in, and it is exercised by handing rows in.
     */
    listRows?: (database: Database) => Promise<MergeRunRow[]>;
  },
): Promise<MergeRunSweepResult> {
  const database = opts.database;
  const nowMs = opts.nowMs ?? Date.now();
  const log = opts.log ?? ((message: string) => console.log(`[merge-run-reconciler] ${message}`));
  const hasLiveJob = opts.hasLiveJob ?? ((workspaceId: string) => getMergeJob(workspaceId)?.state === "running");

  const listRows = opts.listRows ?? listMergeRuns;
  const rows = await listRows(database).catch((err) => {
    log(`could not list in-flight merge markers (non-fatal): ${errorMessage(err)}`);
    return [] as MergeRunRow[];
  });
  const result: MergeRunSweepResult = { ...emptyPassReport(rows.length), recovered: [] };

  for (const row of rows) {
    const { action, reason } = decideMergeRunReconcileAction(row, hasLiveJob(row.workspaceId), nowMs);
    if (action === "hold") {
      recordSkipped(result, row.workspaceId, "live job");
      continue;
    }

    // Read the workspace BEFORE clearing, for two reasons: the note needs its issue id, and a
    // workspace that has since been deleted (or has already merged) must not get a note about a
    // merge that no longer means anything — the marker is then just garbage to drop.
    const workspace = await getWorkspaceById(row.workspaceId, database).catch(() => null);
    if (!workspace) {
      await clearMergeRun(row.workspaceId, database).catch(() => {});
      recordActed(result, row.workspaceId, "dropped-orphan-marker");
      log(`dropped the merge marker for workspace ${row.workspaceId} — the workspace no longer exists`);
      continue;
    }
    if (workspace.mergedAt) {
      // The merge LANDED and only the bookkeeping died with the process. Recording a failure
      // for it would be a lie in exactly the direction that matters — an operator would go
      // looking for work that is already on the base branch.
      await clearMergeRun(row.workspaceId, database).catch(() => {});
      recordActed(result, row.workspaceId, "merge-landed");
      log(`workspace ${row.workspaceId} merged at ${workspace.mergedAt} before its marker was cleared — dropping the marker`);
      continue;
    }

    const body = describeInterruptedMerge(reason, row.source, workspace.readyForMerge === true);
    try {
      await insertIssueComment({
        issueId: workspace.issueId,
        workspaceId: row.workspaceId,
        kind: "merge-attempt",
        author: "system",
        body,
        payload: {
          eventType: "warning",
          mergeReason: "merge_interrupted_by_restart",
          jobId: row.jobId,
          startedAt: row.startedAt,
          source: row.source,
          pid: row.pid,
        },
        createdAt: new Date(nowMs).toISOString(),
      }, database);
    } catch (err) {
      // Recording is the whole point of this pass, so a failed note must NOT be followed by
      // clearing the marker — that would destroy the evidence a second time. Leave the row for
      // the next sweep and say why.
      recordSkipped(result, row.workspaceId, "could not record the interrupted merge");
      log(`could not record the interrupted merge for workspace ${row.workspaceId} — leaving the marker for the next pass: ${errorMessage(err)}`);
      continue;
    }

    await clearMergeRun(row.workspaceId, database).catch((err) => {
      // The note landed, so the attempt is no longer invisible. A surviving marker only costs a
      // duplicate note next sweep, which `insertIssueComment` collapses (#738).
      log(`recorded the interrupted merge for workspace ${row.workspaceId} but could not clear its marker: ${errorMessage(err)}`);
    });
    result.recovered.push(row.workspaceId);
    recordActed(result, row.workspaceId, "recorded-interrupted-merge");
    log(`recorded an interrupted merge for workspace ${row.workspaceId} — ${reason}`);
  }

  if (rows.length > 0) log(formatPassReportBody(result));
  return result;
}

let sweep: PeriodicSweepHandle | null = null;

export function startMergeRunReconciler(opts: { database: Database; intervalMs?: number }): void {
  stopMergeRunReconciler();
  sweep = startPeriodicSweep({
    name: "merge-run-reconciler",
    intervalMs: opts.intervalMs ?? SWEEP_INTERVAL_MS,
    bootDelayMs: BOOT_DELAY_MS,
    tick: () => reconcileInterruptedMergeRuns({ database: opts.database }),
  });
}

export function stopMergeRunReconciler(): void {
  sweep?.stop();
  sweep = null;
}
