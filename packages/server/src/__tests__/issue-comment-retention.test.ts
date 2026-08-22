import { describe, it, expect } from "vitest";
import { projects, projectStatuses, issues, workspaces, issueComments } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import {
  planCommentRetention,
  runCommentRetention,
  DEFAULT_RETAIN_DAYS,
} from "../services/issue-comment-retention.service.js";

type Db = ReturnType<typeof createTestDb>["db"];

const NOW = "2026-08-22T00:00:00.000Z";
/** ISO timestamp `days` before NOW. */
const daysAgo = (days: number) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();

const STATUSES = { done: "Done", cancelled: "Cancelled", open: "In Progress", weird: "Triaging" } as const;

async function seed(db: Db) {
  await db.insert(projects).values({ id: "proj-1", name: "p", repoPath: "/tmp/p" });
  for (const [key, name] of Object.entries(STATUSES)) {
    await db.insert(projectStatuses).values({ id: `status-${key}`, projectId: "proj-1", name, sortOrder: 1 });
  }
  let n = 0;
  // `issues.status_id` is NOT NULL, so a status-less issue is not representable — the
  // fail-closed path that matters in practice is an UNRECOGNISED status name.
  const issue = async (statusKey: keyof typeof STATUSES) => {
    const id = `issue-${++n}`;
    await db.insert(issues).values({
      id,
      issueNumber: n,
      title: `T${n}`,
      statusId: `status-${statusKey}`,
      projectId: "proj-1",
    });
    return id;
  };
  return { issue };
}

/** Insert straight into the table so the write-path dedup does not collapse the fixtures. */
async function comment(
  db: Db,
  args: { id: string; issueId: string; kind: string; author: string; createdAt: string; workspaceId?: string; body?: string },
) {
  await db.insert(issueComments).values({
    id: args.id,
    issueId: args.issueId,
    workspaceId: args.workspaceId ?? null,
    kind: args.kind,
    author: args.author,
    body: args.body ?? `body-${args.id}`,
    payload: null,
    createdAt: args.createdAt,
  });
}

const remainingIds = async (db: Db) =>
  (await db.select().from(issueComments)).map((r) => r.id).sort();

describe("issue-comment retention (#738)", () => {
  it("sweeps old machine merge-attempts on a closed issue but keeps the newest of the thread", async () => {
    const { db } = createTestDb();
    const { issue } = await seed(db);
    const done = await issue("done");
    for (let i = 0; i < 4; i++) {
      await comment(db, { id: `old-${i}`, issueId: done, kind: "merge-attempt", author: "system", createdAt: daysAgo(90 - i) });
    }

    const plan = await planCommentRetention({ now: NOW }, db);
    expect(plan.eligibleRows).toBe(4);
    expect(plan.protectedByThreadFloor).toBe(1);
    expect(plan.deletableRows).toBe(3);
    expect(plan.retainDays).toBe(DEFAULT_RETAIN_DAYS);

    const result = await runCommentRetention({ now: NOW, dryRun: false }, db);
    expect(result.deleted).toBe(3);
    // The newest of the thread survives, so the last known state stays readable.
    expect(await remainingIds(db)).toEqual(["old-3"]);
  });

  it("NEVER sweeps a human comment, however old and however closed the issue", async () => {
    const { db } = createTestDb();
    const { issue } = await seed(db);
    const done = await issue("done");
    await comment(db, { id: "human-1", issueId: done, kind: "note", author: "user", createdAt: daysAgo(400) });
    await comment(db, { id: "human-2", issueId: done, kind: "merge-attempt", author: "user", createdAt: daysAgo(400) });

    const plan = await planCommentRetention({ now: NOW }, db);
    expect(plan.deletableRows).toBe(0);
    await runCommentRetention({ now: NOW, dryRun: false }, db);
    expect(await remainingIds(db)).toEqual(["human-1", "human-2"]);
  });

  it("keeps a row whose provenance is UNKNOWN — an unrecognised author or kind fails CLOSED", async () => {
    const { db } = createTestDb();
    const { issue } = await seed(db);
    const done = await issue("done");
    // Unknown author (the column is plain text, so this is possible).
    await comment(db, { id: "unknown-author", issueId: done, kind: "merge-attempt", author: "robot-9000", createdAt: daysAgo(400) });
    // Known machine author, but a kind not on the sweepable list.
    await comment(db, { id: "unknown-kind", issueId: done, kind: "some-future-kind", author: "system", createdAt: daysAgo(400) });
    // Known machine author writing a `note` — content, not a repeated state report.
    await comment(db, { id: "system-note", issueId: done, kind: "note", author: "system", createdAt: daysAgo(400) });
    // agent/butler are machines but their comments are written content.
    await comment(db, { id: "agent-note", issueId: done, kind: "merge-attempt", author: "agent", createdAt: daysAgo(400) });
    await comment(db, { id: "butler-note", issueId: done, kind: "merge-attempt", author: "butler", createdAt: daysAgo(400) });

    expect((await planCommentRetention({ now: NOW }, db)).deletableRows).toBe(0);
    await runCommentRetention({ now: NOW, dryRun: false }, db);
    expect(await remainingIds(db)).toEqual(["agent-note", "butler-note", "system-note", "unknown-author", "unknown-kind"]);
  });

  it("keeps comments on an issue that is not in a terminal status, or whose status name is unrecognised", async () => {
    const { db } = createTestDb();
    const { issue } = await seed(db);
    const open = await issue("open");
    const weird = await issue("weird");
    const cancelled = await issue("cancelled");
    for (const [id, issueId] of [["open-a", open], ["weird-a", weird]] as const) {
      await comment(db, { id, issueId, kind: "merge-attempt", author: "system", createdAt: daysAgo(400) });
      await comment(db, { id: `${id}-2`, issueId, kind: "merge-attempt", author: "system", createdAt: daysAgo(399) });
    }
    // Cancelled IS terminal, so this one is sweepable down to the floor.
    await comment(db, { id: "cancelled-a", issueId: cancelled, kind: "merge-attempt", author: "system", createdAt: daysAgo(400) });
    await comment(db, { id: "cancelled-b", issueId: cancelled, kind: "merge-attempt", author: "system", createdAt: daysAgo(399) });

    const plan = await planCommentRetention({ now: NOW }, db);
    expect(plan.deletableRows).toBe(1);
    await runCommentRetention({ now: NOW, dryRun: false }, db);
    expect(await remainingIds(db)).toEqual([
      "cancelled-b", "open-a", "open-a-2", "weird-a", "weird-a-2",
    ]);
  });

  it("keeps comments younger than the retention window", async () => {
    const { db } = createTestDb();
    const { issue } = await seed(db);
    const done = await issue("done");
    await comment(db, { id: "fresh-1", issueId: done, kind: "merge-attempt", author: "system", createdAt: daysAgo(1) });
    await comment(db, { id: "fresh-2", issueId: done, kind: "merge-attempt", author: "system", createdAt: daysAgo(2) });
    await comment(db, { id: "old-1", issueId: done, kind: "merge-attempt", author: "system", createdAt: daysAgo(200) });
    await comment(db, { id: "old-2", issueId: done, kind: "merge-attempt", author: "system", createdAt: daysAgo(201) });

    // Only the two old ones are eligible, and the newer of those is the thread floor.
    const plan = await planCommentRetention({ now: NOW }, db);
    expect(plan.eligibleRows).toBe(2);
    expect(plan.deletableRows).toBe(1);
    await runCommentRetention({ now: NOW, dryRun: false }, db);
    expect(await remainingIds(db)).toEqual(["fresh-1", "fresh-2", "old-1"]);
  });

  it("counts the floor per (issue, kind, workspace) thread, never once for the whole issue", async () => {
    const { db } = createTestDb();
    const { issue } = await seed(db);
    const done = await issue("done");
    await db.insert(workspaces).values({ id: "ws-1", issueId: done, branch: "feature/a", status: "closed" });
    await db.insert(workspaces).values({ id: "ws-2", issueId: done, branch: "feature/b", status: "closed" });
    for (const ws of ["ws-1", "ws-2"]) {
      for (let i = 0; i < 3; i++) {
        await comment(db, { id: `${ws}-${i}`, issueId: done, workspaceId: ws, kind: "merge-attempt", author: "system", createdAt: daysAgo(100 - i) });
      }
    }
    const plan = await planCommentRetention({ now: NOW }, db);
    expect(plan.protectedByThreadFloor).toBe(2);
    expect(plan.deletableRows).toBe(4);
  });

  it("is DRY by default — a plain call reports without deleting", async () => {
    const { db } = createTestDb();
    const { issue } = await seed(db);
    const done = await issue("done");
    for (let i = 0; i < 3; i++) {
      await comment(db, { id: `old-${i}`, issueId: done, kind: "merge-attempt", author: "system", createdAt: daysAgo(100 - i) });
    }
    const result = await runCommentRetention({ now: NOW }, db);
    expect(result.dryRun).toBe(true);
    expect(result.deleted).toBe(0);
    expect(result.plan.deletableRows).toBe(2);
    expect(await remainingIds(db)).toEqual(["old-0", "old-1", "old-2"]);
  });

  it("refuses a keep-per-thread floor of 0, so retention can never empty a thread", async () => {
    const { db } = createTestDb();
    await seed(db);
    await expect(planCommentRetention({ now: NOW, keepPerThread: 0 }, db)).rejects.toThrow(/keepPerThread/);
  });
});
