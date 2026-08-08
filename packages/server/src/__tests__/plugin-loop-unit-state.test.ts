/**
 * #357 / #360 — the post-approval statement must be TRUE, not merely present.
 *
 * #357's "say something" half is verified working; its implicit "and it must be true" half was not:
 * on 2 of 3 live approvals the butler said the opposite of what the board had just done. The cause
 * (#360) is that the sentences came from `startOutcomes`, which is built from `created` only — so
 * whenever another advance queued behind the resolve won the lock and created the unit first, this
 * advance reported `skippedExisting`, handed the butler an empty list, and the fallback branch
 * asserted that nothing was planned. The habitloop instance offered to "create and launch" a ticket
 * that already existed and was 80s from a live workspace.
 *
 * These tests pin the two properties the fix has to have:
 *   1. if it says started, a workspace (or an in-flight launch) demonstrably exists;
 *   2. if it says nothing is running, it NAMES why and asserts no cause it has not checked.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createTestDb } from "./helpers/test-db.js";
import { resetCreateJobs, startCreateJob } from "../services/create-job.service.js";
import {
  describeExistingUnits,
  describePlannedUnitState,
  MAX_REPORTED_EXISTING_UNITS,
  resolvePlannedUnitState,
} from "../services/plugin-loop-unit-state.js";
import * as schema from "@agentic-kanban/shared/schema";

afterEach(() => resetCreateJobs());

async function seedIssue(db: ReturnType<typeof createTestDb>["db"], issueNumber: number): Promise<string> {
  const projectId = "proj-1";
  const statusId = "status-1";
  await db.insert(schema.projects).values({
    id: projectId, name: "p", repoPath: "/tmp/p", repoName: "p",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  await db.insert(schema.projectStatuses).values({
    id: statusId, projectId, name: "In Progress", sortOrder: 1, isDefault: false,
  });
  const issueId = `issue-${issueNumber}`;
  await db.insert(schema.issues).values({
    id: issueId, projectId, statusId, title: `unit ${issueNumber}`, issueNumber,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  return issueId;
}

async function seedWorkspace(
  db: ReturnType<typeof createTestDb>["db"],
  issueId: string,
  overrides: Partial<typeof schema.workspaces.$inferInsert> = {},
): Promise<void> {
  await db.insert(schema.workspaces).values({
    id: `ws-${Math.random().toString(36).slice(2)}`,
    issueId,
    branch: "feature/ak-6-step",
    status: "active",
    createdAt: "2026-08-08T19:45:41.893Z",
    updatedAt: "2026-08-08T19:45:41.893Z",
    ...overrides,
  });
}

describe("resolvePlannedUnitState (#360)", () => {
  it("reports an OPEN workspace — the state the butler denied existed", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db, 6);
    await seedWorkspace(db, issueId, { status: "active" });
    const state = await resolvePlannedUnitState(issueId, db);
    expect(state).toMatchObject({ kind: "workspace-open", workspaceStatus: "active", branch: "feature/ak-6-step" });
  });

  it("reports a MERGED branch when every workspace is closed and one landed", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db, 6);
    await seedWorkspace(db, issueId, { status: "closed", mergedAt: "2026-08-08T20:06:58.224Z" });
    expect(await resolvePlannedUnitState(issueId, db)).toMatchObject({
      kind: "workspace-merged", mergedAt: "2026-08-08T20:06:58.224Z",
    });
  });

  it("reports PROVISIONING while a launch is in flight and no row exists yet", async () => {
    // This is the 80-120s window that produced the false message: the workspace row's insert and
    // the issue's move to In Progress are ONE transaction at the END of provisioning, so for the
    // whole window "no row" is indistinguishable from "nothing will start" without this registry.
    const { db } = createTestDb();
    const issueId = await seedIssue(db, 6);
    startCreateJob(issueId, "2026-08-08T19:44:30.000Z");
    expect(await resolvePlannedUnitState(issueId, db)).toEqual({
      kind: "provisioning", startedAt: "2026-08-08T19:44:30.000Z",
    });
  });

  it("prefers a real workspace row over a stale running create job", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db, 6);
    startCreateJob(issueId);
    await seedWorkspace(db, issueId, { status: "idle" });
    expect((await resolvePlannedUnitState(issueId, db)).kind).toBe("workspace-open");
  });

  it("distinguishes 'closed and never merged' from 'never had a workspace'", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db, 6);
    await seedWorkspace(db, issueId, { status: "closed", mergedAt: null });
    expect(await resolvePlannedUnitState(issueId, db)).toMatchObject({ kind: "workspace-closed-unmerged" });

    const other = createTestDb();
    const bare = await seedIssue(other.db, 7);
    expect(await resolvePlannedUnitState(bare, other.db)).toEqual({ kind: "no-workspace" });
  });

  it("reads the NEWEST workspace when a relaunch left an older one behind", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db, 6);
    await seedWorkspace(db, issueId, { status: "closed", mergedAt: "2026-08-08T20:06:58.224Z", createdAt: "2026-08-08T19:45:41.893Z" });
    await seedWorkspace(db, issueId, { status: "idle", branch: "feature/ak-6-step-r2", createdAt: "2026-08-08T20:22:16.923Z" });
    // The `-r2` relaunch row is open, so it is what describes what is happening now (#361's shape).
    expect(await resolvePlannedUnitState(issueId, db)).toMatchObject({
      kind: "workspace-open", branch: "feature/ak-6-step-r2",
    });
  });
});

describe("describePlannedUnitState (#357) — falsifiable wording", () => {
  const ref = { issueId: "issue-6", issueNumber: 6 };

  it("names the workspace when it claims one exists", () => {
    const text = describePlannedUnitState(ref, {
      kind: "workspace-open", branch: "feature/ak-6", workspaceStatus: "active", createdAt: "2026-08-08T19:45:41.893Z",
    });
    expect(text).toContain("#6");
    expect(text).toContain("feature/ak-6");
    expect(text).toContain("EXISTS");
    // The bar: it must never invite a redundant advance the way habitloop's message did.
    expect(text).toContain("does not need to be started again");
  });

  it("names WHY nothing is visible, and asserts no cause it has not checked", () => {
    const text = describePlannedUnitState(ref, { kind: "no-workspace" });
    expect(text).toContain("NO workspace");
    expect(text).toContain("no launch in flight");
    // The retracted claim. It was false on 2 of 3 approvals and is what made the message harmful.
    expect(text).not.toContain("waiting on something else");
  });

  it("never claims an agent is running or generating (#354's over-claim)", () => {
    const states = [
      { kind: "workspace-open", branch: "b", workspaceStatus: "active", createdAt: "t" },
      { kind: "workspace-merged", branch: "b", mergedAt: "t" },
      { kind: "workspace-closed-unmerged", branch: "b" },
      { kind: "provisioning", startedAt: "t" },
      { kind: "no-workspace" },
    ] as const;
    for (const state of states) {
      const text = describePlannedUnitState(ref, state).toLowerCase();
      expect(text, `"${state.kind}" must not claim generation`).not.toContain("generating");
      expect(text, `"${state.kind}" must not claim the agent is running`).not.toContain("agent is running");
    }
  });
});

describe("describeExistingUnits (#360)", () => {
  it("produces one sentence per already-ticketed unit — never an empty list", async () => {
    // The empty list IS the bug: it is what routed the butler into the "nothing was planned" branch.
    const { db } = createTestDb();
    const issueId = await seedIssue(db, 6);
    await seedWorkspace(db, issueId, { status: "active" });
    const lines = await describeExistingUnits([{ issueId, issueNumber: 6 }], db);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("#6");
  });

  it("returns an empty list only when there are no already-ticketed units", async () => {
    const { db } = createTestDb();
    expect(await describeExistingUnits([], db)).toEqual([]);
  });

  it("caps itemisation and says how many it did not itemise", async () => {
    // A fan-out loop can report a whole 24-unit round as skippedExisting on EVERY monitor cycle;
    // one DB read each would put that on a path the monitor walks continuously (#359).
    const { db } = createTestDb();
    const refs = [];
    for (let i = 1; i <= MAX_REPORTED_EXISTING_UNITS + 3; i++) {
      refs.push({ issueId: await seedIssueInto(db, i), issueNumber: i });
    }
    const lines = await describeExistingUnits(refs, db);
    expect(lines).toHaveLength(MAX_REPORTED_EXISTING_UNITS + 1);
    expect(lines.at(-1)).toContain("3 further unit(s)");
  });

  // Seeding many issues needs the project/status rows created only once.
  async function seedIssueInto(db: ReturnType<typeof createTestDb>["db"], n: number): Promise<string> {
    if (n === 1) return seedIssue(db, 1);
    const issueId = `issue-${n}`;
    await db.insert(schema.issues).values({
      id: issueId, projectId: "proj-1", statusId: "status-1", title: `unit ${n}`, issueNumber: n,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    return issueId;
  }
});
