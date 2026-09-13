import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issues, projects, projectStatuses, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { countActiveWip, countWipCapacity } from "../startup/monitor-auto-start.js";
import { decideStartSlots } from "../services/start-slot-decision.js";

/**
 * Regression for #690: provider usage-limit / zero-output launch failures must
 * NOT occupy WIP capacity. Such workspaces are persisted as `blocked` (codex
 * usage-limit) or `idle` (zero-output launch failure) — both with a stopped,
 * zero-token launch-failure session and zero diff. The old auto-start WIP count
 * (`status != 'closed'`) treated them as active, so the board showed In-Progress
 * issues but zero working agents and refused to auto-start anything.
 *
 * `countActiveWip` must count only workspaces actively running an agent.
 */

async function seed(db: TestDb) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    name: "WIP Capacity Project",
    repoPath: "/tmp/wip-capacity",
    repoName: "wip-capacity",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  const inProgressId = randomUUID();
  await db.insert(projectStatuses).values({
    id: inProgressId,
    projectId,
    name: "In Progress",
    sortOrder: 0,
    isDefault: false,
    createdAt: now,
  });

  return { projectId, inProgressId, now };
}

let issueCounter = 1;
async function addIssue(db: TestDb, projectId: string, statusId: string, now: string) {
  const id = randomUUID();
  await db.insert(issues).values({
    id,
    issueNumber: issueCounter++,
    title: "WIP issue",
    issueType: "task",
    sortOrder: 0,
    statusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function addWorkspace(db: TestDb, issueId: string, status: string, now: string) {
  const id = randomUUID();
  await db.insert(workspaces).values({
    id,
    issueId,
    branch: "feature/test",
    workingDir: "/tmp/wip-capacity/.worktrees/test",
    baseBranch: "main",
    status,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe("countActiveWip — launch failures do not occupy WIP (#690)", () => {
  it("does NOT count a codex usage-limit (blocked) workspace as active WIP", async () => {
    const { db } = createTestDb();
    const { projectId, inProgressId, now } = await seed(db);
    const issueId = await addIssue(db, projectId, inProgressId, now);

    // A codex usage-limit launch: workspace persisted as `blocked`, with a stopped
    // launch-failure session carrying the simulated provider failure message + zero diff.
    const wsId = await addWorkspace(db, issueId, "blocked", now);
    const start = new Date(Date.now() - 60 * 60 * 1000);
    const end = new Date(start.getTime() + 3500); // ~3.5s, like the observed failures
    await db.insert(sessions).values({
      id: randomUUID(),
      workspaceId: wsId,
      executor: "codex",
      status: "stopped",
      startedAt: start.toISOString(),
      endedAt: end.toISOString(),
      exitCode: "1",
      stats: JSON.stringify({
        rateLimited: true,
        rateLimitKind: "codex-usage-limit",
        retryAfter: "Jun 7th, 2026 1:47 AM",
        failureReason:
          "You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again at Jun 7th, 2026 1:47 AM.",
        launchFailure: true,
        inputTokens: 0,
        outputTokens: 0,
      }),
    });

    expect(await countActiveWip(db, inProgressId)).toBe(0);
  });

  it("does NOT count a zero-output (idle) launch failure as active WIP", async () => {
    const { db } = createTestDb();
    const { projectId, inProgressId, now } = await seed(db);
    const issueId = await addIssue(db, projectId, inProgressId, now);

    const wsId = await addWorkspace(db, issueId, "idle", now);
    const start = new Date(Date.now() - 60 * 60 * 1000);
    const end = new Date(start.getTime() + 500); // <=1s, zero-output
    await db.insert(sessions).values({
      id: randomUUID(),
      workspaceId: wsId,
      executor: "claude-code",
      status: "stopped",
      startedAt: start.toISOString(),
      endedAt: end.toISOString(),
      exitCode: "1",
      stats: JSON.stringify({ launchFailure: true, inputTokens: 0, outputTokens: 0 }),
    });

    expect(await countActiveWip(db, inProgressId)).toBe(0);
  });

  it("counts a genuinely active workspace as WIP", async () => {
    const { db } = createTestDb();
    const { projectId, inProgressId, now } = await seed(db);
    const issueId = await addIssue(db, projectId, inProgressId, now);
    await addWorkspace(db, issueId, "active", now);

    expect(await countActiveWip(db, inProgressId)).toBe(1);
  });

  it("reports inactive stale workspaces separately from active WIP", async () => {
    const { db } = createTestDb();
    const { projectId, inProgressId, now } = await seed(db);

    const activeIssue = await addIssue(db, projectId, inProgressId, now);
    await addWorkspace(db, activeIssue, "active", now);

    for (const status of ["idle", "closed", "blocked"]) {
      const staleIssue = await addIssue(db, projectId, inProgressId, now);
      await addWorkspace(db, staleIssue, status, now);
    }

    await expect(countWipCapacity(db, inProgressId)).resolves.toEqual({
      active: 1,
      inactiveStale: 3,
      reserved: 0,
    });
  });

  it("frees capacity: a blocked + an active issue count as 1, not 2", async () => {
    // The observed bug: four blocked workspaces made WIP look full (>=limit) so
    // no new work started. With the fix, only genuinely-active work counts.
    const { db } = createTestDb();
    const { projectId, inProgressId, now } = await seed(db);

    const blockedIssue = await addIssue(db, projectId, inProgressId, now);
    await addWorkspace(db, blockedIssue, "blocked", now);

    const activeIssue = await addIssue(db, projectId, inProgressId, now);
    await addWorkspace(db, activeIssue, "active", now);

    expect(await countActiveWip(db, inProgressId)).toBe(1);
  });

  // --- #713 regression tests: launch-failed workspace exclusion from auto-start WIP ---

  it("workspace whose session stopped within seconds of creation does NOT count as active WIP", async () => {
    // Requirement 1: agent launched, session stopped within seconds of workspace
    // creation (launch-failure signature). Session exit handler sets workspace to
    // "idle" with launch-failure stats. The old `status != 'closed'` check would
    // have counted this as active WIP, blocking all auto-starts.
    const { db } = createTestDb();
    const { projectId, inProgressId, now } = await seed(db);
    const issueId = await addIssue(db, projectId, inProgressId, now);

    const wsId = await addWorkspace(db, issueId, "idle", now);
    // Session started at workspace creation time, stopped 5s later — quick failure
    const createdAt = new Date(now);
    await db.insert(sessions).values({
      id: randomUUID(),
      workspaceId: wsId,
      executor: "claude-code",
      status: "stopped",
      startedAt: createdAt.toISOString(),
      endedAt: new Date(createdAt.getTime() + 5000).toISOString(),
      exitCode: "1",
      stats: JSON.stringify({ launchFailure: true, inputTokens: 0, outputTokens: 0 }),
    });

    expect(await countActiveWip(db, inProgressId)).toBe(0);
  });

  it("excluding failed launches frees WIP capacity so the monitor can fill remaining slots", async () => {
    // Requirement 3: WIP limit = 3, with 1 active + 2 failed-launch workspaces.
    // The monitor checks `wipLimit - countActiveWip` for available slots.
    // If failed launches inflated the count, slotsAvailable would be 0 (stall).
    // With the fix, only the genuinely active workspace counts → 2 slots available.
    const { db } = createTestDb();
    const { projectId, inProgressId, now } = await seed(db);

    // 1 genuinely active workspace — counts toward WIP
    const activeIssue = await addIssue(db, projectId, inProgressId, now);
    await addWorkspace(db, activeIssue, "active", now);

    // 2 failed-launch workspaces — must NOT count toward WIP
    const blockedIssue = await addIssue(db, projectId, inProgressId, now);
    const blockedWsId = await addWorkspace(db, blockedIssue, "blocked", now);
    await db.insert(sessions).values({
      id: randomUUID(),
      workspaceId: blockedWsId,
      executor: "codex",
      status: "stopped",
      startedAt: new Date(Date.now() - 3600000).toISOString(),
      endedAt: new Date(Date.now() - 3596500).toISOString(),
      exitCode: "1",
      stats: JSON.stringify({
        launchFailure: true,
        rateLimited: true,
        rateLimitKind: "codex-usage-limit",
        inputTokens: 0,
        outputTokens: 0,
      }),
    });

    const idleIssue = await addIssue(db, projectId, inProgressId, now);
    const idleWsId = await addWorkspace(db, idleIssue, "idle", now);
    await db.insert(sessions).values({
      id: randomUUID(),
      workspaceId: idleWsId,
      executor: "claude-code",
      status: "stopped",
      startedAt: now,
      endedAt: new Date(new Date(now).getTime() + 500).toISOString(),
      exitCode: "1",
      stats: JSON.stringify({ launchFailure: true, inputTokens: 0, outputTokens: 0 }),
    });

    // Only the genuinely active workspace counts → WIP = 1, not 3
    // With WIP limit 3: 2 slots available for auto-start (wipLimit - currentWip = 2)
    expect(await countActiveWip(db, inProgressId)).toBe(1);
  });

  it("all In-Progress workspaces are failed launches: zero WIP, full capacity available", async () => {
    // Edge case of requirement 3: every In-Progress workspace is a failed launch.
    // Under the old `status != 'closed'` check this would return N, blocking all
    // auto-starts. With the fix, WIP = 0 so the monitor fills all available slots.
    const { db } = createTestDb();
    const { projectId, inProgressId, now } = await seed(db);

    // Blocked workspace (e.g. codex usage-limit failure)
    const issue1 = await addIssue(db, projectId, inProgressId, now);
    await addWorkspace(db, issue1, "blocked", now);

    // Idle workspace (e.g. zero-output launch failure)
    const issue2 = await addIssue(db, projectId, inProgressId, now);
    await addWorkspace(db, issue2, "idle", now);

    expect(await countActiveWip(db, inProgressId)).toBe(0);
  });
});

describe("countWipCapacity reservations prevent a consecutive-cycle WIP overshoot (#1137)", () => {
  /**
   * Regression for #1137: with WIP=2, five monitor cycles fired back-to-back launched five
   * workspaces before the WIP tally caught up, because `countWipCapacity` only saw a start
   * once its workspace row (and the issue's move to In Progress) landed at the END of
   * provisioning — 80s to 8+ minutes after the launch. A burst of cycles within that window
   * each read a stale `active` count and each spent the same free slot.
   *
   * This simulates that burst directly at the mechanism under test: N cycles run
   * back-to-back against a WIP=2 project, each deciding to start via the real
   * `decideStartSlots`, with the status transition to In Progress DELIBERATELY delayed (the
   * launched issue's workspace row never lands during the simulated burst) — so each cycle's
   * `countWipCapacity` reads the same landed-row count unless the reservation registry
   * (`reservedIssueIds`, the create-job claim's stand-in here) is consulted.
   */
  it("never starts more than the WIP limit across a burst of cycles when the status transition is delayed", async () => {
    const { db } = createTestDb();
    const { projectId, inProgressId, now } = await seed(db);
    const wipLimit = 2;

    // Five candidate issues, none started yet, none with a workspace row — exactly the Todo
    // pull loop's starting position for a burst of five independent tickets becoming eligible
    // at once (the ak-1130..ak-1136 observation).
    const candidateIssueIds = await Promise.all(
      Array.from({ length: 5 }, () => addIssue(db, projectId, inProgressId, now)),
    );

    // The reservation registry: a `Set` standing in for the real process-wide create-job
    // registry (`listRunningCreateJobIssueIds`) — deliberately never drained during the burst,
    // simulating the status transition never landing within the simulated window.
    const reserved = new Set<string>();

    let started = 0;
    for (const issueId of candidateIssueIds) {
      // Each cycle re-reads capacity fresh, exactly as `runInProgressBackfill`/`runTodoPull` do.
      const capacity = await countWipCapacity(db, inProgressId, Array.from(reserved));
      const decision = decideStartSlots({
        wipLimit,
        active: capacity.active,
        machineCapacity: { tier: "0", hold: false, reason: "test", freeGb: 99 },
        maxNewStartsPerCycle: 1,
        startedThisCycle: 0,
        fleetOverflow: false,
      });
      if (decision.holdReason !== null) continue;
      // A start: claim the issue (stand-in for `claimIssueForAutoStart`) — its workspace row
      // does NOT land this cycle, simulating the 80s-8min provisioning window.
      reserved.add(issueId);
      started++;
    }

    expect(started).toBeLessThanOrEqual(wipLimit);
    expect(started).toBe(wipLimit);
  });

  it("existing single-cycle maxNewStartsPerCycle behaviour is unchanged (no reservations in play)", async () => {
    const { db } = createTestDb();
    const { projectId, inProgressId, now } = await seed(db);
    await addIssue(db, projectId, inProgressId, now);

    const capacity = await countWipCapacity(db, inProgressId);
    const decision = decideStartSlots({
      wipLimit: 5,
      active: capacity.active,
      machineCapacity: { tier: "0", hold: false, reason: "test", freeGb: 99 },
      maxNewStartsPerCycle: 1,
      startedThisCycle: 1,
      fleetOverflow: false,
    });

    expect(decision.holdReason).toBe("start_cap");
    expect(decision.slots).toBe(0);
  });

  it("a ticket group's several member issues sharing one reservation still count as ONE against the limit", async () => {
    // Ticket group (#661): the group's workspace is keyed by the LEAD issue only — a member
    // never gets its own workspace row or its own create-job claim. So reserving just the
    // lead's issue id (as the real launch path does) must not inflate `reserved` beyond 1
    // even though the group covers several issues.
    const { db } = createTestDb();
    const { projectId, inProgressId, now } = await seed(db);
    const leadIssueId = await addIssue(db, projectId, inProgressId, now);
    await addIssue(db, projectId, inProgressId, now); // member — deliberately NOT reserved

    const capacity = await countWipCapacity(db, inProgressId, [leadIssueId]);
    expect(capacity.active).toBe(1);
    expect(capacity.reserved).toBe(1);
  });
});
