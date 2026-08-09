/**
 * #351 / #354 / #357 — a gate approval must START what it planned, and must REPORT what it did.
 *
 * Approval is an event; before this it depended on a poll — the freshly created ticket sat in
 * Backlog until some later monitor cycle reached its `auto-start` phase. Measured on `kassenbuch`,
 * that hop was 2m30s in the best observed case and 26-28 minutes in earlier rounds, and the worst
 * case is a whole cycle plus the next cycle's productive phases (cycles measured 450-600s, running
 * back-to-back). Making the cycle faster shortens it; it cannot remove it.
 *
 * The reporting half matters just as much, because the two previous failures were BOTH reporting
 * failures in opposite directions: the butler asserted "State: generating" for a ticket parked in
 * Backlog with no workspace (#354), and after a UI approval it said nothing at all (#357). So every
 * outcome here is a distinct, falsifiable sentence — never one optimistic phrasing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { projectStatuses, projects } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import { describeLoopStartOutcome, startPlannedLoopTickets } from "../services/plugin-loop-start.service.js";
import type { StartPolicy } from "../services/start-policy.service.js";
import { claimIssueForAutoStart, isAutoStartClaimed } from "../services/auto-start-claim.js";
import { resetCreateJobs } from "../services/create-job.service.js";

function policy(overrides: Partial<StartPolicy> = {}): StartPolicy {
  return {
    mode: "monitor",
    autoStartUnblocked: true,
    postMergeCascade: false,
    postMergeFollowups: false,
    backlogRefill: false,
    scheduledRuns: true,
    wip: { activeAgentsTarget: 2, backlogFloor: 10, maxNewStartsPerCycle: 3, refillFocus: "balanced" },
    source: "start_mode",
    ...overrides,
  } as StartPolicy;
}

async function seedProject(db: ReturnType<typeof createTestDb>["db"], withInProgressLane = true) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "P", repoPath: "/tmp/p", defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  const lanes = withInProgressLane ? ["Backlog", "In Progress", "Done"] : ["Backlog", "Done"];
  for (const name of lanes) {
    await db.insert(projectStatuses).values({
      id: randomUUID(), projectId, name, sortOrder: lanes.indexOf(name), createdAt: now,
    });
  }
  return projectId;
}

const TICKETS = [{ issueId: "issue-a", issueNumber: 5 }];

describe("#351: the advance path starts the ticket it just planned", () => {
  // The advance path now CLAIMS the issue in the shared create-job registry (#366), so each test
  // must start from an empty registry or a previous test's claim would refuse the next launch.
  beforeEach(() => resetCreateJobs());

  it("launches the planned ticket immediately and reports `starting`", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const createWorkspace = vi.fn(async () => ({ id: "ws-1" }) as never);

    const outcomes = await startPlannedLoopTickets({
      database: db as unknown as Database,
      projectId,
      policy: policy(),
      tickets: TICKETS,
      createWorkspace,
    });

    expect(createWorkspace).toHaveBeenCalledWith({ issueId: "issue-a" });
    expect(outcomes).toEqual([{ issueId: "issue-a", issueNumber: 5, outcome: "starting" }]);
    // Never "running"/"generating": provisioning takes minutes, so claiming a live agent here would
    // be the #354 over-claim with a different author.
    const sentence = describeLoopStartOutcome(outcomes[0]);
    expect(sentence).toMatch(/starting now/);
    expect(sentence).not.toMatch(/generating|is running/);
  });

  it("a `manual`-mode loop is untouched, and the report SAYS nothing will start", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const createWorkspace = vi.fn(async () => ({ id: "ws-1" }) as never);

    const outcomes = await startPlannedLoopTickets({
      database: db as unknown as Database,
      projectId,
      policy: policy({ mode: "manual", autoStartUnblocked: false }),
      tickets: TICKETS,
      createWorkspace,
    });

    // `resolveStartPolicy` stays the single source of truth (decision 008) — `manual` is a real
    // kill-switch and this path must not become a way around it.
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({ outcome: "queued-manual", startMode: "manual" });
    // This is the branch the user explicitly asked for: tell me, and offer to start it.
    expect(describeLoopStartOutcome(outcomes[0])).toMatch(/will NOT start on its own/);
  });

  it("respects WIP and names the count instead of claiming a start", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const createWorkspace = vi.fn(async () => ({ id: "ws-1" }) as never);

    // Three planned units, a target of 2, nothing else running: two start, the third is queued
    // with the numbers in the message rather than a bare "queued".
    const outcomes = await startPlannedLoopTickets({
      database: db as unknown as Database,
      projectId,
      policy: policy({ wip: { activeAgentsTarget: 2, backlogFloor: 10, maxNewStartsPerCycle: 3, refillFocus: "balanced" } }),
      tickets: [
        { issueId: "i1", issueNumber: 1 },
        { issueId: "i2", issueNumber: 2 },
        { issueId: "i3", issueNumber: 3 },
      ],
      createWorkspace,
    });

    expect(outcomes.map((o) => o.outcome)).toEqual(["starting", "starting", "queued-wip"]);
    expect(createWorkspace).toHaveBeenCalledTimes(2);
    expect(describeLoopStartOutcome(outcomes[2])).toMatch(/2 of 2 agent slots/);
  });

  it("declines rather than starting past an unmeasurable cap when there is no In Progress lane", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db, false);
    const createWorkspace = vi.fn(async () => ({ id: "ws-1" }) as never);

    const outcomes = await startPlannedLoopTickets({
      database: db as unknown as Database,
      projectId,
      policy: policy(),
      tickets: TICKETS,
      createWorkspace,
    });

    expect(createWorkspace).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({ outcome: "queued-no-starter" });
  });

  it("degrades honestly when no workspace creator was injected", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);

    const outcomes = await startPlannedLoopTickets({
      database: db as unknown as Database,
      projectId,
      policy: policy(),
      tickets: TICKETS,
    });

    expect(outcomes[0]).toMatchObject({ outcome: "queued-no-starter" });
  });

  it("a rejected launch cannot become an unhandled rejection", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    // The launch is fired, not awaited (provisioning is minutes long), so its rejection handler
    // must be attached synchronously — this server logs unhandled rejections as [fatal].
    const createWorkspace = vi.fn(async () => { throw new Error("no default branch"); });

    const outcomes = await startPlannedLoopTickets({
      database: db as unknown as Database,
      projectId,
      policy: policy(),
      tickets: TICKETS,
      createWorkspace: createWorkspace as never,
    });

    expect(outcomes[0].outcome).toBe("starting");
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe("#366 round 8: the advance path READS the claim it writes", () => {
  beforeEach(() => resetCreateJobs());

  it("declines to provision when another automatic starter already holds the claim", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const createWorkspace = vi.fn(async () => ({ id: "ws-1" }) as never);

    // The monitor's auto-start pass got there first and is mid-provisioning. For the whole
    // provisioning window the workspaces table still holds no row, so the table-based check this
    // path used to rely on reads "no workspace" — which is how one issue ended up with two
    // workspaces sharing a single worktree and two agents writing the same files.
    claimIssueForAutoStart("issue-a");

    const outcomes = await startPlannedLoopTickets({
      database: db as unknown as Database,
      projectId,
      policy: policy(),
      tickets: TICKETS,
      createWorkspace,
    });

    expect(createWorkspace).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({ outcome: "queued-in-flight" });
    expect(describeLoopStartOutcome(outcomes[0])).toMatch(/already being started/);
  });

  it("holds the claim while its own launch provisions, so a concurrent starter is refused", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    // Never resolves: models the 80s-to-8-minute provisioning window in which the duplicate
    // starters used to fire.
    const createWorkspace = vi.fn(() => new Promise<never>(() => {}));

    await startPlannedLoopTickets({
      database: db as unknown as Database,
      projectId,
      policy: policy(),
      tickets: TICKETS,
      createWorkspace: createWorkspace as never,
    });

    expect(isAutoStartClaimed("issue-a")).toBe(true);
    expect(claimIssueForAutoStart("issue-a")).toBeNull();
  });

  it("does not claim anything when the policy declines the start", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);

    await startPlannedLoopTickets({
      database: db as unknown as Database,
      projectId,
      policy: policy({ mode: "manual", autoStartUnblocked: false }),
      tickets: TICKETS,
      createWorkspace: vi.fn(async () => ({ id: "ws-1" }) as never),
    });

    // A declined start must not leave a claim behind — that would wedge the issue against the
    // monitor's next pass, converting one bug into another.
    expect(isAutoStartClaimed("issue-a")).toBe(false);
  });
});
