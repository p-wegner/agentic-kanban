/**
 * The progress invariant (#1561): every open ticket of a monitor-driven project has exactly one
 * live DRIVER, or it is a VIOLATION.
 *
 * The board grew one point fix per stall shape (#191, #363, #445, #1205, #1439, #1555-#1559), each
 * found by an operator noticing "the board looks idle" 30-120 min in. This module is the generic
 * replacement: a PURE verdict over a snapshot of one ticket's workspace, so a new stall shape is a
 * new row in `progress-invariant.test.ts`, not a new sweep.
 *
 * A driver is one of:
 *  - a running agent session;
 *  - a merge/gate job younger than its phase's budget that is placed (or queued WITH a reason);
 *  - a scheduled retry whose `nextRetryAt` is in the future AND whose branch sha is still the head
 *    (a backoff recorded against an old sha is void — the tip moved);
 *  - a merge train the workspace belongs to that is assembling/gating;
 *  - an explicit human hold: merge-hold, blocked-by dependency, cooling-down quota, or a workspace
 *    already marked for attention (`blocked`).
 *
 * Everything here is a decision function: no `await`, no db (`decision-function-purity.test.ts`).
 */

/** Minutes of silence a ticket may show before it is a violation, per undriven state. */
export const PROGRESS_BUDGETS_MS = {
  /** A session ended and nothing picked the ticket up. */
  idleAfterSession: 10 * 60_000,
  /** Ready for merge with no job, retry or train: the monitor walk should have started one. */
  readyIdle: 15 * 60_000,
  /** A merge/gate job that never reached a placed phase (no attempt, or `queued` with no reason). */
  gateUnplaced: 10 * 60_000,
  /** A job queued WITH a reason (waiting behind another gate) may wait longer. */
  gateQueuedWithReason: 90 * 60_000,
  gateInstall: 20 * 60_000,
  gateVerify: 60 * 60_000,
  gateFlakeRetry: 60 * 60_000,
  gateSmoke: 30 * 60_000,
  /** `held` phase: the host declined to start; the monitor retries it. */
  gateHeld: 30 * 60_000,
} as const;

/** Slack past a window's projected departure before its members count as undriven again. */
export const TRAIN_WINDOW_SLACK_MS = 5 * 60_000;

export type DriverKind =
  | "running-session"
  | "merge-job"
  | "scheduled-retry"
  | "merge-train"
  | "train-window"
  | "merge-hold"
  | "blocked-by"
  | "quota-cooldown"
  | "attention-marked"
  | "exit-work-pending"
  | "within-budget";

/** The stall shapes the invariant knows. A new shape is a new member plus a test row. */
export type StallShape =
  | "gate-unplaced" // #1555 / #1550: job running, never placed (40 min)
  | "gate-silent" // #1559: job still `running`, its gate died with a worker drain
  | "stale-backoff" // #1556 / #1551: retry scheduled from an old sha
  | "builder-exited-no-commit" // #1557 / #1553: builder ended with nothing committed
  | "builder-exited-committed" // #1439 / #1205 follow-on: committed work, nobody ran the exit check
  | "review-not-running" // In Review, no review session, no launch pending
  | "ready-without-commits" // #363 / #1205: 0-commit branch parked ready
  | "ready-idle" // #191: ready, no job / retry / train / hold, never merged
  | "no-live-workspace"; // #445: open ticket whose workspace is closed unmerged

export type RecoveryAction =
  | "cancel-gate-job"
  | "clear-backoff"
  | "redrive-exit-check"
  | "followup-turn"
  | "relaunch-review"
  /** No generic safe repair: mark for attention straight away. */
  | "escalate";

export type StageName = "in_progress" | "in_review" | "other";

/** What the sweep read about one open ticket's workspace. Plain data: the test table builds these. */
export interface TicketDriverSnapshot {
  issueNumber: number | null;
  workspaceId: string;
  projectId: string;
  stage: StageName;
  workspaceStatus: string;
  readyForMerge: boolean;
  /** `workspaces.updatedAt` — the floor for "undriven since" when no better timestamp exists. */
  workspaceUpdatedAt: string;
  hasRunningSession: boolean;
  lastSessionEndedAt: string | null;
  lastSessionTriggerType: string | null;
  /** null = the git probe could not answer. */
  hasCommits: boolean | null;
  /** A review launch is queued, or the implement-exit check is running/queued in this process. */
  exitWorkPending: boolean;
  mergeJob: {
    state: "running" | "succeeded" | "failed" | "cancelled";
    lastActivityAt: string;
    /** Phase of the newest unfinished gate attempt; null when the job has none. */
    phase: string | null;
    phaseDetail: string | null;
  } | null;
  backoff: { nextRetryAt: string | null; branchSha: string | null } | null;
  branchHeadSha: string | null;
  inActiveTrain: boolean;
  /**
   * Epoch ms of the projected departure (`firstSeenAt + maxWaitMs`) of the accumulating train window
   * this workspace is pending in; null/absent when it is in no window (#1653).
   */
  trainWindowDepartsAtMs?: number | null;
  hold: "merge-hold" | "blocked-by" | "quota-cooldown" | null;
}

export type ProgressVerdict =
  | { driven: true; driver: DriverKind }
  | {
      driven: false;
      shape: StallShape;
      recovery: RecoveryAction;
      /** ISO time since which nothing drove the ticket. */
      since: string;
      /** The last known state, in operator words, for the `[progress-invariant]` log line. */
      detail: string;
    };

function ms(iso: string | null | undefined): number {
  if (!iso) return Number.NaN;
  return Date.parse(iso);
}

function gateBudgetMs(phase: string | null, phaseDetail: string | null): number {
  switch (phase) {
    case null:
      return PROGRESS_BUDGETS_MS.gateUnplaced;
    case "queued":
      return phaseDetail ? PROGRESS_BUDGETS_MS.gateQueuedWithReason : PROGRESS_BUDGETS_MS.gateUnplaced;
    case "held":
      return PROGRESS_BUDGETS_MS.gateHeld;
    case "install":
      return PROGRESS_BUDGETS_MS.gateInstall;
    case "flake-retry":
      return PROGRESS_BUDGETS_MS.gateFlakeRetry;
    case "smoke":
      return PROGRESS_BUDGETS_MS.gateSmoke;
    default:
      return PROGRESS_BUDGETS_MS.gateVerify;
  }
}

/** Latest finite timestamp, as ISO; falls back to `fallback`. */
function latestIso(candidates: Array<string | null | undefined>, fallback: string): string {
  let best = Number.NaN;
  for (const c of candidates) {
    const t = ms(c);
    if (Number.isFinite(t) && (Number.isNaN(best) || t > best)) best = t;
  }
  return Number.isNaN(best) ? fallback : new Date(best).toISOString();
}

function violation(
  shape: StallShape,
  recovery: RecoveryAction,
  sinceIso: string,
  detail: string,
): ProgressVerdict {
  return { driven: false, shape, recovery, since: sinceIso, detail };
}

/** Is the scheduled retry a real driver? Future `nextRetryAt` AND a sha that is still the head. */
function backoffIsLive(s: TicketDriverSnapshot, nowMs: number): boolean {
  const b = s.backoff;
  if (!b || !b.nextRetryAt) return false;
  const next = ms(b.nextRetryAt);
  if (!Number.isFinite(next) || next <= nowMs) return false;
  return !(b.branchSha && s.branchHeadSha && b.branchSha !== s.branchHeadSha);
}

/** The undriven-merge-job half of the verdict (job `running`, but not demonstrably alive). */
function decideMergeJob(s: TicketDriverSnapshot, nowMs: number): ProgressVerdict {
  const job = s.mergeJob!;
  const budget = gateBudgetMs(job.phase, job.phaseDetail);
  const last = ms(job.lastActivityAt);
  if (Number.isFinite(last) && nowMs - last < budget) return { driven: true, driver: "merge-job" };
  const unplaced = job.phase === null || (job.phase === "queued" && !job.phaseDetail);
  return violation(
    unplaced ? "gate-unplaced" : "gate-silent",
    "cancel-gate-job",
    job.lastActivityAt,
    `merge job running, phase ${job.phase ?? "none (never placed)"}, last activity ${job.lastActivityAt} (budget ${Math.round(budget / 60_000)}m)`,
  );
}

/**
 * #1653: a ready ticket pending in an accumulating train window is driven by that window until its
 * projected departure (plus slack). Without this the 15-min `readyIdle` budget escalated every
 * member of a window that waits longer (sprint: 30 min), which dropped the window and its clock.
 */
function isWindowDriven(s: TicketDriverSnapshot, nowMs: number): boolean {
  if (!s.readyForMerge || s.mergeJob?.state === "running") return false;
  const departs = s.trainWindowDepartsAtMs;
  return typeof departs === "number" && Number.isFinite(departs) && nowMs < departs + TRAIN_WINDOW_SLACK_MS;
}

/** Ready-for-merge ticket with no job: which retry/train/hold, if any, is driving it? */
function decideReady(s: TicketDriverSnapshot, nowMs: number): ProgressVerdict {
  if (backoffIsLive(s, nowMs)) return { driven: true, driver: "scheduled-retry" };
  const since = latestIso([s.workspaceUpdatedAt], s.workspaceUpdatedAt);
  if (nowMs - ms(since) < PROGRESS_BUDGETS_MS.readyIdle) return { driven: true, driver: "within-budget" };
  const next = ms(s.backoff?.nextRetryAt);
  if (s.backoff && Number.isFinite(next) && next > nowMs) {
    // A future retry, but recorded against another sha: the tip moved, so the block is void.
    return violation(
      "stale-backoff",
      "clear-backoff",
      since,
      `retry scheduled for ${s.backoff.nextRetryAt} from sha ${s.backoff.branchSha}, but the branch head is ${s.branchHeadSha}`,
    );
  }
  if (s.hasCommits === false) {
    return violation("ready-without-commits", "escalate", since, "ready for merge but the branch has no commits ahead of base");
  }
  return violation("ready-idle", "escalate", since, "ready for merge; no merge job, live retry, train or hold is driving it");
}

/** In Progress / In Review ticket whose workspace is open and idle. */
function decideIdleStage(s: TicketDriverSnapshot, nowMs: number): ProgressVerdict {
  if (s.exitWorkPending) return { driven: true, driver: "exit-work-pending" };
  const since = latestIso([s.lastSessionEndedAt], s.workspaceUpdatedAt);
  if (nowMs - ms(since) < PROGRESS_BUDGETS_MS.idleAfterSession) return { driven: true, driver: "within-budget" };
  const last = `last session (${s.lastSessionTriggerType ?? "builder"}) ended ${s.lastSessionEndedAt ?? "never"}`;
  if (s.stage === "in_review") {
    return violation("review-not-running", "relaunch-review", since, `In Review with no running review session; ${last}`);
  }
  if (s.hasCommits === true) {
    return violation("builder-exited-committed", "redrive-exit-check", since, `In Progress with commits, no running session or pending check; ${last}`);
  }
  if (s.hasCommits === false) {
    return violation("builder-exited-no-commit", "followup-turn", since, `In Progress, builder exited with no commit; ${last}`);
  }
  // The git probe could not answer: no evidence to act on, only to surface.
  return violation("builder-exited-no-commit", "escalate", since, `In Progress, no running session and commits unknown; ${last}`);
}

/**
 * DECISION (pure): does this ticket have a live driver? `{driven: true}` names it; otherwise the
 * verdict carries the stall shape, the generic recovery for the state it is in, and since when.
 */
export function decideTicketDriver(s: TicketDriverSnapshot, nowMs: number): ProgressVerdict {
  if (s.hasRunningSession) return { driven: true, driver: "running-session" };
  if (s.hold === "merge-hold") return { driven: true, driver: "merge-hold" };
  if (s.hold === "blocked-by") return { driven: true, driver: "blocked-by" };
  if (s.hold === "quota-cooldown") return { driven: true, driver: "quota-cooldown" };
  if (s.workspaceStatus === "blocked") return { driven: true, driver: "attention-marked" };
  if (s.inActiveTrain) return { driven: true, driver: "merge-train" };
  if (isWindowDriven(s, nowMs)) return { driven: true, driver: "train-window" };
  if (s.workspaceStatus === "closed") {
    return violation(
      "no-live-workspace",
      "escalate",
      s.workspaceUpdatedAt,
      "open ticket whose workspace is closed without landing",
    );
  }
  if (s.mergeJob?.state === "running") return decideMergeJob(s, nowMs);
  if (s.readyForMerge) return decideReady(s, nowMs);
  if (s.stage === "other") return { driven: true, driver: "within-budget" };
  return decideIdleStage(s, nowMs);
}

/** Per-ticket recovery bookkeeping state. */
export interface RecoveryState {
  recoveredAtMs: number | null;
  escalated: boolean;
}

/** A ticket is recovered at most once per this window. */
export const RECOVERY_COOLDOWN_MS = 60 * 60_000;
/** A recovery that did not restore a driver within this long escalates. */
export const ESCALATE_AFTER_RECOVERY_MS = 15 * 60_000;

export type RecoveryStep = "recover" | "escalate" | "wait" | "none";

/**
 * DECISION (pure): what to do about a violation, given what was already done for this ticket.
 * `escalate`-recovery shapes go straight to attention; the rest recover once, then escalate if the
 * recovery did not restore a driver.
 */
export function decideRecoveryStep(
  verdict: Extract<ProgressVerdict, { driven: false }>,
  state: RecoveryState | undefined,
  nowMs: number,
): RecoveryStep {
  if (state?.escalated) return "none";
  if (verdict.recovery === "escalate") return "escalate";
  if (!state || state.recoveredAtMs === null) return "recover";
  const since = nowMs - state.recoveredAtMs;
  if (since >= RECOVERY_COOLDOWN_MS) return "recover";
  if (since >= ESCALATE_AFTER_RECOVERY_MS) return "escalate";
  return "wait";
}
