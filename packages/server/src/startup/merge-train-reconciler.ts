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
 * #1181: that argument holds ONLY at boot. The same sweep also runs every ten minutes, and
 * there a `gating` row may well have a live job in this very process — so the periodic pass
 * consults the in-process registry (`services/merge-train-live-registry.ts`) and skips any row
 * whose job is registered, or whose project already has a registered train. The registry is
 * empty at boot by construction, which is what keeps the boot rule intact without a flag.
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
import type { BoardEventSink } from "../services/board-events.js";
import {
  getMergeTrain,
  listMergeTrainsInStates,
  updateMergeTrainState,
  type MergeTrainRow,
} from "../repositories/merge-train.repository.js";
import { getAllProjects } from "../repositories/project.repository.js";
import { emptyPassReport, formatPassReportBody, recordActed, recordSkipped, type PassReport } from "../lib/pass-report.js";
import { startPeriodicSweep, type PeriodicSweepHandle } from "../lib/periodic-sweep.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { listWorktrees, removeWorktree, worktreeDirLeafForBranch } from "@agentic-kanban/shared/lib/git-service";
import { removeWorktreeUnlessShared } from "@agentic-kanban/shared/lib/worktree-claim";
import { parentTrainLabel, trainRefName } from "../services/merge-train.service.js";
import {
  findLiveMergeTrainForProject,
  snapshotLiveMergeTrains,
  type LiveMergeTrainSnapshot,
} from "../services/merge-train-live-registry.js";
import { getHeldWorkspaceIdsAmong } from "../repositories/merge-hold.repository.js";

/** How often the reconciler sweeps for stranded trains (defence in depth beyond the boot pass). */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export type MergeTrainReconcileAction = "resume" | "abandon";

/**
 * #1181 — is this `assembling`/`gating` row one the sweep must leave alone because THIS
 * process is still running it (or running another train for the same project)? Pure over the
 * registry snapshot, so the "boot rule" and the "live rule" are testable side by side.
 *
 * The boot pass needs no special case: the registry is empty when the process starts, so
 * every row is stranded there by construction — which is exactly the #906 header's argument,
 * now scoped to the one moment it is true. On a PERIODIC sweep the same rule abandoned a live
 * train mid-gate (measured 2026-09-16: a 28-minute gate discarded at minute 8, and the
 * re-assembly then died waiting on the repo lock the live job still held).
 *
 * A same-project sibling is skipped too: resuming it would abandon it and mint a new train for
 * a project that already has one in flight — which `beginMergeTrain` would refuse anyway, but
 * only AFTER the reconciler had already written the "superseded" verdict onto the row.
 */
export function decideMergeTrainLiveSkip(
  row: Pick<MergeTrainRow, "id" | "projectId" | "startedAt">,
  live: LiveMergeTrainSnapshot,
  nowMs: number,
): { reason: string } | null {
  const ageMinutes = Math.max(0, Math.round((nowMs - Date.parse(row.startedAt)) / 60_000));
  if (live.has(row.id)) {
    return { reason: `live in this process (age ${ageMinutes}m)` };
  }
  const sibling = findLiveMergeTrainForProject(live, row.projectId);
  if (sibling) {
    return { reason: `another train (${sibling.trainId}, ${sibling.label}) for project ${row.projectId} is live in this process — not resuming a second one` };
  }
  return null;
}

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
      : "no live job for this row is registered in this process — re-running the batch from its member set",
  };
}

const RESUME_ATTEMPT_RE = /resume attempt (\d+)/;

function countPriorResumeAttempts(reconciledReason: string | null | undefined): number {
  if (!reconciledReason) return 0;
  const match = RESUME_ATTEMPT_RE.exec(reconciledReason);
  return match ? Number.parseInt(match[1], 10) : 0;
}

/**
 * #1183 — union two rows' member sets, de-duplicated and order-preserving. Malformed JSON on
 * either side degrades to the OTHER row's members rather than throwing, since a parse failure
 * here must not stop the coalesced resume from including at least the row that parsed.
 */
function unionMemberWorkspaceIds(rows: Pick<MergeTrainRow, "memberWorkspaceIds">[]): string[] {
  const seen = new Set<string>();
  const union: string[] = [];
  for (const row of rows) {
    let members: string[];
    try {
      members = JSON.parse(row.memberWorkspaceIds) as string[];
    } catch {
      continue;
    }
    for (const id of members) {
      if (!seen.has(id)) {
        seen.add(id);
        union.push(id);
      }
    }
  }
  return union;
}

export interface MergeTrainSweepResult extends PassReport {
  resumed: string[];
  abandoned: string[];
  /** #1181 — rows left untouched because this process is still running them (or a same-project sibling). */
  skippedLive: string[];
}

/**
 * #1181 — apply {@link decideMergeTrainLiveSkip} to one row and book the outcome. Returns true
 * when the row must be left alone. Split out so the sweep loop itself does not grow.
 */
function skipIfLive(
  row: MergeTrainRow,
  live: LiveMergeTrainSnapshot,
  nowMs: number,
  result: MergeTrainSweepResult,
  log: (message: string) => void,
): boolean {
  const skip = decideMergeTrainLiveSkip(row, live, nowMs);
  if (!skip) return false;
  result.skippedLive.push(row.id);
  recordSkipped(result, row.id, "live-in-process");
  log(`skipping train ${row.id} (${row.label}, project ${row.projectId}) — ${skip.reason}`);
  return true;
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
    /**
     * #1181 — the train jobs live in THIS process. Defaults to the real registry; a test passes
     * an empty map to simulate a fresh process (the boot pass) or a populated one for a sweep.
     */
    liveTrains?: LiveMergeTrainSnapshot;
    /** #1186 — broadcasts `merge_train_changed` when a stranded row is abandoned here. */
    boardEvents?: BoardEventSink;
  } = {},
): Promise<MergeTrainSweepResult> {
  const database = opts.database;
  const now = opts.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const live = opts.liveTrains ?? snapshotLiveMergeTrains();
  const log = opts.log ?? ((message: string) => console.log(`[merge-train-reconciler] ${message}`));

  const rows = await listMergeTrainsInStates(["assembling", "gating"], database).catch(() => [] as MergeTrainRow[]);
  const result: MergeTrainSweepResult = { ...emptyPassReport(rows.length), resumed: [], abandoned: [], skippedLive: [] };

  // #1183 — group by project BEFORE deciding resume/abandon, so two stranded rows for the same
  // project resolve as one coalesced resume rather than each other's `already_in_flight` refusal
  // (`beginMergeTrain` refuses whenever ANY other assembling/gating row exists for the project —
  // see its header comment — so resuming row A while row B still sits in the table always lost,
  // regardless of processing order). A row still gets its OWN abandon decision first — an
  // exhausted retry count must still abandon that row rather than being smuggled into a group
  // resume — and only the rows that individually decided "resume" are coalesced.
  const byProject = new Map<string, MergeTrainRow[]>();
  for (const row of rows) {
    if (skipIfLive(row, live, nowMs, result, log)) continue;
    const ref = `train ${row.id} (${row.label}, project ${row.projectId})`;

    // #1164 — a stranded train with a HELD member must not be resumed (it would re-gate the
    // very workspace the operator parked) or abandoned (that would discard the rest of the
    // train's assembly over one held member) — it is left exactly as found, for the operator
    // to release explicitly. Checked BEFORE grouping, so a held row is never coalesced away.
    let memberWorkspaceIds: string[] = [];
    try {
      memberWorkspaceIds = JSON.parse(row.memberWorkspaceIds) as string[];
    } catch {
      memberWorkspaceIds = [];
    }
    const heldMembers = await getHeldWorkspaceIdsAmong(memberWorkspaceIds, database);
    if (heldMembers.size > 0) {
      recordSkipped(result, row.id, `left on hold — member(s) held: ${[...heldMembers].join(", ")}`);
      log(`skipped ${ref} — held member(s): ${[...heldMembers].join(", ")}`);
      continue;
    }

    const list = byProject.get(row.projectId) ?? [];
    list.push(row);
    byProject.set(row.projectId, list);
  }

  for (const projectRows of byProject.values()) {
    const toResume: { row: MergeTrainRow; reason: string }[] = [];
    for (const row of projectRows) {
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
        opts.boardEvents?.broadcast(row.projectId, "merge_train_changed");
        result.abandoned.push(row.id);
        recordActed(result, row.id, "abandoned");
        log(`abandoned ${ref} — ${abandonReason}`);
        continue;
      }
      toResume.push({ row, reason });
    }

    if (toResume.length === 0) continue;

    // The lead row is whichever survives to carry the coalesced resume; the rest are abandoned
    // as superseded BEFORE the lead's `runTrain` runs, so `beginMergeTrain`'s project-wide
    // `already_in_flight` check (which counts every assembling/gating row, this one included)
    // sees only the lead when it re-enters — exactly the same ordering the single-row path
    // already relied on for the row it resumes.
    const [lead, ...siblings] = toResume;
    const leadPriorAttempts = countPriorResumeAttempts(lead.row.reconciledReason);
    const resumeReason = siblings.length > 0
      ? `resume attempt ${leadPriorAttempts + 1}: ${lead.reason} — coalesced with ${siblings.length} other stranded row(s) for this project (${siblings.map((s) => s.row.id).join(", ")}) into one resume`
      : `resume attempt ${leadPriorAttempts + 1}: ${lead.reason}`;

    for (const { row: sibling } of siblings) {
      const supersededReason = `superseded — coalesced into a single resume with train ${lead.row.id} for project ${sibling.projectId} rather than resuming separately and hitting the project's in-flight refusal`;
      await updateMergeTrainState(sibling.id, {
        state: "abandoned",
        reconciledReason: supersededReason,
        finishedAt: now,
      }, database);
      opts.boardEvents?.broadcast(sibling.projectId, "merge_train_changed");
      log(`abandoned train ${sibling.id} (${sibling.label}, project ${sibling.projectId}) — ${supersededReason}`);
    }

    const mergedRow: MergeTrainRow = siblings.length > 0
      ? { ...lead.row, memberWorkspaceIds: JSON.stringify(unionMemberWorkspaceIds(toResume.map((t) => t.row))) }
      : lead.row;
    const ref = `train ${lead.row.id} (${lead.row.label}, project ${lead.row.projectId})`;
    log(`resuming ${ref} — ${resumeReason}`);
    try {
      await opts.runTrain!(mergedRow);
      for (const { row } of toResume) {
        result.resumed.push(row.id);
        recordActed(result, row.id, "resumed");
      }
      // A successful `runTrain` is expected to drive the row to its own terminal state
      // (landed/red) itself — it is the same code path a fresh request takes. Only stamp the
      // attempt marker if it is SOMEHOW still non-terminal afterwards (re-read from the DB,
      // not the stale `row` captured before the resume ran), so a future sweep can see this
      // was already tried once — and so we never clobber a terminal state `runTrain` just
      // persisted back to `assembling`/`gating`, which would re-queue an already-landed train
      // for resume forever.
      const after = await getMergeTrain(lead.row.id, database).catch(() => undefined);
      if (after && (after.state === "assembling" || after.state === "gating")) {
        await updateMergeTrainState(lead.row.id, { state: after.state, reconciledReason: resumeReason }, database).catch(() => undefined);
      }
    } catch (err) {
      const failReason = `resume attempt ${leadPriorAttempts + 1} failed: ${errorMessage(err)}`;
      await updateMergeTrainState(lead.row.id, {
        state: "abandoned",
        reconciledReason: failReason,
        finishedAt: now,
      }, database).catch(() => undefined);
      opts.boardEvents?.broadcast(lead.row.projectId, "merge_train_changed");
      result.abandoned.push(lead.row.id);
      recordActed(result, lead.row.id, "abandoned-after-resume-error");
      log(`abandoned ${ref} — ${failReason}`);
      // The siblings were already abandoned as superseded above, before the resume ran — that
      // write stands regardless of how the coalesced resume turns out. Account for them here
      // too, so a failed resume still reports every row the pass looked at.
      for (const { row: sibling } of siblings) {
        result.abandoned.push(sibling.id);
        recordActed(result, sibling.id, "coalesced-and-superseded");
      }
    }
  }

  log(formatPassReportBody(result));
  return result;
}

let sweep: PeriodicSweepHandle | null = null;

export function startMergeTrainReconciler(
  opts: {
    intervalMs?: number;
    runTrain?: (row: MergeTrainRow) => Promise<void>;
    boardEvents?: BoardEventSink;
    /**
     * #1208 — injected rather than read from the module-level `db` singleton: `startup/` has a
     * shrink-only ratchet on files that import that VALUE
     * (`startup-persistence-boundary-ratchet.test.ts`), because a module holding the singleton
     * connection has no seam to swap or fake in a test. The one production caller
     * (`background-services.ts`) already receives `db` in its own `start({ db })` args, so this
     * is a straight pass-through, not a new dependency.
     */
    database: Database;
  },
): void {
  stopMergeTrainReconciler();
  sweep = startPeriodicSweep({
    name: "merge-train-reconciler",
    intervalMs: opts.intervalMs ?? SWEEP_INTERVAL_MS,
    tick: async () => {
      const reconciled = await reconcileStrandedMergeTrains({
        database: opts.database,
        runTrain: opts.runTrain,
        boardEvents: opts.boardEvents,
      });
      const worktrees = await sweepStaleTrainWorktrees({ database: opts.database });
      return { ...reconciled, staleWorktreesRemoved: worktrees.removed.length };
    },
  });
}

export function stopMergeTrainReconciler(): void {
  sweep?.stop();
  sweep = null;
}

/**
 * #1208 — remove a train's staging worktree (`.worktrees/<repo>/train/kanban_train_<label>`)
 * once its row is terminal, and sweep away any such directory a crashed process left behind
 * with no live row to account for it at all.
 *
 * The per-attempt `finally` in `merge-queue-train.ts`'s `runGate` already removes its own
 * worktree on every NORMAL exit (gate finishes, gate throws, cancel). What it cannot cover is
 * the process dying mid-gate (killed by pid, an unhandled crash) — the `finally` never runs,
 * and the directory is orphaned with nothing left in the DB naming it (the train ref and the
 * worktree are both scratch state with no `workspaces` row). This sweep is the boot-time (and
 * periodic, defence-in-depth) recovery for exactly that gap, mirroring how
 * `reconcileStrandedMergeTrains` recovers the DB ROW half of the same crash.
 *
 * Matching a worktree back to a row: the leaf is `worktreeDirLeafForBranch("kanban/train/<label
 * of the ATTEMPT>")` (see `worktree.ts`), and an attempt's label is the row's label plus zero or
 * more trailing bisect letters (`parentTrainLabel` strips them). So a worktree's directory name
 * belongs to a project's train row when `parentTrainLabel` of the decoded label equals that
 * row's `label`. Unknown labels (matching no row of ANY state, not just the active ones) are
 * reported rather than removed — a directory this sweep cannot positively attribute is exactly
 * the case `removeWorktreeUnlessShared`'s design already refuses to guess about.
 */
export interface StaleTrainWorktreeSweepResult extends PassReport {
  removed: Array<{ projectId: string; path: string }>;
  /** A directory under the train namespace whose label matched no `merge_trains` row at all. */
  unknown: Array<{ projectId: string; path: string }>;
}

export async function sweepStaleTrainWorktrees(
  opts: { database: Database; log?: (message: string) => void; dryRun?: boolean },
): Promise<StaleTrainWorktreeSweepResult> {
  // `removeWorktreeUnlessShared`'s claim check reads `workspaces`, so this needs a real
  // database. REQUIRED (not defaulted to the module-level `db` singleton) — importing that
  // VALUE here would trip `startup-persistence-boundary-ratchet.test.ts`'s shrink-only count of
  // `startup/` files that hold the singleton connection with no seam to swap or fake it.
  const database = opts.database;
  const log = opts.log ?? ((message: string) => console.log(`[merge-train-reconciler] ${message}`));
  const result: StaleTrainWorktreeSweepResult = { ...emptyPassReport(0), removed: [], unknown: [] };

  // One read for every project's rows, in EVERY state — not just the active ones, since a
  // worktree must be attributable to a TERMINAL row (landed/red/abandoned) before it may be
  // removed, and to an active one (assembling/gating/landing) before it is skipped rather than
  // reported as unknown.
  const rows = await listMergeTrainsInStates(
    ["assembling", "gating", "landing", "landed", "red", "abandoned"],
    database,
  ).catch(() => [] as MergeTrainRow[]);
  // Keyed by `projectId::<sanitized leaf>` — the leaf `worktreeDirLeafForBranch` derives from
  // the row's OWN label, per-project since two different projects' trains both start their
  // per-day sequence at `01` and would otherwise collide on the same label (`train/2026-09-19-01`
  // is not unique across projects, only within one). Keying by leaf means recovering the label
  // from a directory name never has to reverse the sanitization — it only has to reproduce it
  // (scoped to the worktree's own project, resolved from ITS repoPath below) and look it up.
  const rowsByProject = new Map<string, Map<string, MergeTrainRow>>();
  for (const row of rows) {
    const leaf = worktreeDirLeafForBranch(trainRefName(parentTrainLabel(row.label)));
    const forProject = rowsByProject.get(row.projectId) ?? new Map<string, MergeTrainRow>();
    forProject.set(leaf, row);
    rowsByProject.set(row.projectId, forProject);
  }

  const projects = await getAllProjects(database, { includeArchived: true }).catch(() => []);
  for (const project of projects) {
    if (!project.repoPath) continue;
    const worktrees = await listWorktrees(project.repoPath).catch(() => []);
    const rowByLeaf = rowsByProject.get(project.id);
    for (const wt of worktrees) {
      const leaf = wt.path.split(/[\\/]/).filter(Boolean).pop() ?? "";
      if (!leaf.startsWith("kanban_train_")) continue;
      result.scanned++;
      const owner = rowByLeaf?.get(leaf);
      if (!owner) {
        result.unknown.push({ projectId: project.id, path: wt.path });
        recordSkipped(result, wt.path, "unknown-label");
        log(`train worktree ${wt.path} (project ${project.id}) matches no merge_trains row of any state — leaving it for manual inspection`);
        continue;
      }
      if (owner.state === "assembling" || owner.state === "gating" || owner.state === "landing") {
        recordSkipped(result, wt.path, "row-still-active");
        continue;
      }
      if (opts.dryRun) {
        result.removed.push({ projectId: project.id, path: wt.path });
        recordActed(result, wt.path, "would-remove");
        log(`would remove stale train staging worktree ${wt.path} (project ${project.id}, train ${owner.id} terminal: ${owner.state})`);
        continue;
      }
      const outcome = await removeWorktreeUnlessShared({
        database,
        workingDir: wt.path,
        label: "merge-train-stale-sweep",
        removeWorktree: () => removeWorktree(project.repoPath, wt.path),
      }).catch((err) => ({ removed: false as const, reason: "remove-failed" as const, message: errorMessage(err), error: err }));
      if (outcome.removed) {
        result.removed.push({ projectId: project.id, path: wt.path });
        recordActed(result, wt.path, "removed");
        log(`removed stale train staging worktree ${wt.path} (project ${project.id}, train ${owner.id} terminal: ${owner.state})`);
      } else {
        recordSkipped(result, wt.path, outcome.reason);
        log(`could not remove stale train worktree ${wt.path}: ${outcome.message}`);
      }
    }
  }

  return result;
}
