import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  decideRecoveryStep,
  decideTicketDriver,
  ESCALATE_AFTER_RECOVERY_MS,
  RECOVERY_COOLDOWN_MS,
  type ProgressVerdict,
  type RecoveryAction,
  type StallShape,
  type TicketDriverSnapshot,
} from "../services/progress-invariant.js";
import {
  resetProgressInvariantStateForTests,
  runProgressInvariantPass,
  type ProgressRecoveryPort,
} from "../startup/progress-invariant-sweep.js";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const ahead = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

function snap(over: Partial<TicketDriverSnapshot>): TicketDriverSnapshot {
  return {
    issueNumber: 1,
    workspaceId: "ws-1",
    projectId: "p-1",
    stage: "in_progress",
    workspaceStatus: "idle",
    readyForMerge: false,
    workspaceUpdatedAt: ago(120),
    hasRunningSession: false,
    lastSessionEndedAt: ago(60),
    lastSessionTriggerType: "implement",
    hasCommits: true,
    exitWorkPending: false,
    mergeJob: null,
    backoff: null,
    branchHeadSha: "head-new",
    inActiveTrain: false,
    hold: null,
    ...over,
  };
}

const READY: Partial<TicketDriverSnapshot> = { stage: "in_review", readyForMerge: true };

/** Today's stall shapes: state in -> no driver -> the recovery chosen. A new shape is a new row. */
const VIOLATION_TABLE: Array<{ name: string; state: Partial<TicketDriverSnapshot>; shape: StallShape; recovery: RecoveryAction }> = [
  {
    name: "#1550 gate job running, never placed (40 min)",
    state: { ...READY, issueNumber: 1550, mergeJob: { state: "running", lastActivityAt: ago(40), phase: null, phaseDetail: null } },
    shape: "gate-unplaced",
    recovery: "cancel-gate-job",
  },
  {
    name: "#1555 gate queued with no reason",
    state: { ...READY, mergeJob: { state: "running", lastActivityAt: ago(40), phase: "queued", phaseDetail: null } },
    shape: "gate-unplaced",
    recovery: "cancel-gate-job",
  },
  {
    name: "#1559 gate killed by a worker drain, job stays running",
    state: { ...READY, mergeJob: { state: "running", lastActivityAt: ago(95), phase: "verify", phaseDetail: null } },
    shape: "gate-silent",
    recovery: "cancel-gate-job",
  },
  {
    name: "#1551 / #1556 backoff scheduled from an old sha",
    state: {
      ...READY,
      issueNumber: 1551,
      backoff: { nextRetryAt: ahead(30), branchSha: "head-old" },
      branchHeadSha: "head-new",
    },
    shape: "stale-backoff",
    recovery: "clear-backoff",
  },
  {
    name: "#1553 / #1557 builder exited with no commit",
    state: { issueNumber: 1553, hasCommits: false, lastSessionEndedAt: ago(30) },
    shape: "builder-exited-no-commit",
    recovery: "followup-turn",
  },
  {
    name: "#1439 committed work after a watchdog kill",
    state: { hasCommits: true, lastSessionEndedAt: ago(30) },
    shape: "builder-exited-committed",
    recovery: "redrive-exit-check",
  },
  {
    name: "In Review with no review session (stranded review)",
    state: { stage: "in_review", lastSessionEndedAt: ago(30), lastSessionTriggerType: "implement" },
    shape: "review-not-running",
    recovery: "relaunch-review",
  },
  {
    name: "#363 / #1205 0-commit branch parked ready",
    state: { ...READY, hasCommits: false, workspaceUpdatedAt: ago(60) },
    shape: "ready-without-commits",
    recovery: "escalate",
  },
  {
    name: "#191 ready, stale base, never merged",
    state: { ...READY, workspaceUpdatedAt: ago(60) },
    shape: "ready-idle",
    recovery: "escalate",
  },
  {
    name: "#445 closed-unmerged loop ticket",
    state: { workspaceStatus: "closed" },
    shape: "no-live-workspace",
    recovery: "escalate",
  },
];

const DRIVEN_TABLE: Array<{ name: string; state: Partial<TicketDriverSnapshot>; driver: string }> = [
  { name: "running session", state: { hasRunningSession: true }, driver: "running-session" },
  { name: "session just ended (within budget)", state: { lastSessionEndedAt: ago(2) }, driver: "within-budget" },
  {
    name: "gate placed and active",
    state: { ...READY, mergeJob: { state: "running", lastActivityAt: ago(20), phase: "verify", phaseDetail: null } },
    driver: "merge-job",
  },
  {
    name: "gate queued WITH a reason (behind another gate)",
    state: { ...READY, mergeJob: { state: "running", lastActivityAt: ago(40), phase: "queued", phaseDetail: "waiting behind #1549" } },
    driver: "merge-job",
  },
  {
    name: "retry in the future from the current sha",
    state: { ...READY, backoff: { nextRetryAt: ahead(30), branchSha: "head-new" }, branchHeadSha: "head-new" },
    driver: "scheduled-retry",
  },
  { name: "assembling train", state: { ...READY, inActiveTrain: true }, driver: "merge-train" },
  { name: "merge-hold", state: { ...READY, hold: "merge-hold" }, driver: "merge-hold" },
  { name: "blocked-by dependency", state: { hold: "blocked-by" }, driver: "blocked-by" },
  { name: "quota cooldown", state: { hold: "quota-cooldown" }, driver: "quota-cooldown" },
  { name: "already marked for attention", state: { workspaceStatus: "blocked" }, driver: "attention-marked" },
  { name: "implement-exit check queued", state: { exitWorkPending: true }, driver: "exit-work-pending" },
];

describe("decideTicketDriver", () => {
  it.each(VIOLATION_TABLE)("$name -> no driver, $shape, recovery $recovery", ({ state, shape, recovery }) => {
    const verdict = decideTicketDriver(snap(state), NOW);
    expect(verdict.driven).toBe(false);
    if (verdict.driven) return;
    expect(verdict.shape).toBe(shape);
    expect(verdict.recovery).toBe(recovery);
    expect(verdict.detail.length).toBeGreaterThan(0);
  });

  it.each(DRIVEN_TABLE)("$name is a driver", ({ state, driver }) => {
    expect(decideTicketDriver(snap(state), NOW)).toEqual({ driven: true, driver });
  });

  it("produces the violation within one cycle after the budget, not before", () => {
    const state = { ...READY, mergeJob: { state: "running" as const, lastActivityAt: ago(9), phase: null, phaseDetail: null } };
    expect(decideTicketDriver(snap(state), NOW).driven).toBe(true); // 9m < 10m unplaced budget
    expect(decideTicketDriver(snap(state), NOW + 2 * 60_000).driven).toBe(false); // next 2-minute cycle
  });
});

describe("decideRecoveryStep", () => {
  const recoverable = decideTicketDriver(snap({ hasCommits: false }), NOW) as Extract<ProgressVerdict, { driven: false }>;
  const escalating = decideTicketDriver(snap({ workspaceStatus: "closed" }), NOW) as Extract<ProgressVerdict, { driven: false }>;

  it("recovers first, waits for it to take, escalates if it did not, recovers again after the hour", () => {
    expect(decideRecoveryStep(recoverable, undefined, NOW)).toBe("recover");
    const state = { recoveredAtMs: NOW, escalated: false };
    expect(decideRecoveryStep(recoverable, state, NOW + 60_000)).toBe("wait");
    expect(decideRecoveryStep(recoverable, state, NOW + ESCALATE_AFTER_RECOVERY_MS)).toBe("escalate");
    expect(decideRecoveryStep(recoverable, state, NOW + RECOVERY_COOLDOWN_MS)).toBe("recover");
  });

  it("shapes with no generic repair go straight to attention, once", () => {
    expect(decideRecoveryStep(escalating, undefined, NOW)).toBe("escalate");
    expect(decideRecoveryStep(escalating, { recoveredAtMs: NOW, escalated: true }, NOW + 1)).toBe("none");
  });
});

describe("runProgressInvariantPass", () => {
  let recovery: ProgressRecoveryPort;
  let logs: string[];
  beforeEach(() => {
    resetProgressInvariantStateForTests();
    logs = [];
    recovery = {
      cancelGateJob: vi.fn(),
      clearBackoff: vi.fn(async () => {}),
      redriveExitCheck: vi.fn(async () => {}),
      relaunchReview: vi.fn(async () => {}),
      followUpBuilder: vi.fn(async () => {}),
      escalate: vi.fn(async () => {}),
    };
  });
  const run = (snapshots: TicketDriverSnapshot[], nowMs = NOW) =>
    runProgressInvariantPass({ recovery, nowMs, log: (m) => logs.push(m), loadSnapshots: async () => snapshots });

  it("replays the 2026-10-17 states and applies the hand recovery for each", async () => {
    const report = await run([
      snap({ issueNumber: 1550, workspaceId: "ws-1550", ...READY, mergeJob: { state: "running", lastActivityAt: ago(40), phase: null, phaseDetail: null } }),
      snap({ issueNumber: 1551, workspaceId: "ws-1551", ...READY, backoff: { nextRetryAt: ahead(30), branchSha: "old" }, branchHeadSha: "new" }),
      snap({ issueNumber: 1553, workspaceId: "ws-1553", hasCommits: false }),
      snap({ issueNumber: 1559, workspaceId: "ws-1559", ...READY, mergeJob: { state: "running", lastActivityAt: ago(95), phase: "verify", phaseDetail: null } }),
      snap({ issueNumber: 1600, workspaceId: "ws-1600", hasRunningSession: true }),
    ]);
    expect(report.scanned).toBe(5);
    expect(report.acted).toBe(4);
    expect(report.skipped).toBe(1);
    expect(report.violations).toEqual(["#1550", "#1551", "#1553", "#1559"]);
    expect(recovery.cancelGateJob).toHaveBeenCalledWith("ws-1550", expect.any(String));
    expect(recovery.cancelGateJob).toHaveBeenCalledWith("ws-1559", expect.any(String));
    expect(recovery.clearBackoff).toHaveBeenCalledWith("ws-1551");
    expect(recovery.followUpBuilder).toHaveBeenCalledWith("ws-1553", expect.stringContaining("without any commit"));
    expect(logs.some((l) => l.startsWith("#1550 has no driver since "))).toBe(true);
  });

  it("recovers once, then escalates when the ticket is still undriven", async () => {
    const stuck = snap({ hasCommits: false });
    await run([stuck]);
    await run([stuck], NOW + 60_000);
    expect(recovery.followUpBuilder).toHaveBeenCalledTimes(1);
    expect(recovery.escalate).not.toHaveBeenCalled();
    const report = await run([stuck], NOW + ESCALATE_AFTER_RECOVERY_MS);
    expect(recovery.escalate).toHaveBeenCalledTimes(1);
    expect(report.escalated).toEqual(["#1"]);
    await run([stuck], NOW + ESCALATE_AFTER_RECOVERY_MS + 120_000);
    expect(recovery.escalate).toHaveBeenCalledTimes(1);
    expect(recovery.followUpBuilder).toHaveBeenCalledTimes(1);
  });

  it("a recovery that throws is neither acted nor skipped (unaccounted)", async () => {
    recovery.followUpBuilder = vi.fn(async () => { throw new Error("no channel"); });
    const report = await run([snap({ hasCommits: false })]);
    expect(report.scanned).toBe(1);
    expect(report.acted + report.skipped).toBe(0);
    expect(logs.some((l) => l.includes("failed: no channel"))).toBe(true);
  });
});
