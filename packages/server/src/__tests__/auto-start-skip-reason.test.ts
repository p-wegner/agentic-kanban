import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { issues } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { seedIssue, seedProject } from "./helpers/workflow-test-helpers.js";
import {
  clearAutoStartSkipReason,
  persistAutoStartSkipReason,
} from "../repositories/auto-start-skip.repository.js";

/**
 * #919 — the per-ISSUE skip record that makes "why is #57 not running" answerable in the issue
 * panel. The per-project tally cannot answer it: it is keyed by project, and its project-wide
 * holds name no ticket at all.
 */
describe("auto-start skip reason, per issue (#919)", () => {
  async function seedOne() {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db, "skip-reason");
    const issueId = await seedIssue(db, projectId, statusIds["Todo"], 57, "Why is this not running?");
    return { db, issueId };
  }

  const readBack = async (db: Awaited<ReturnType<typeof seedOne>>["db"], issueId: string) =>
    (await db.select().from(issues).where(eq(issues.id, issueId)))[0];

  it("starts empty — an issue nobody has held has no reason on it", async () => {
    const { db, issueId } = await seedOne();
    const row = await readBack(db, issueId);
    expect(row.lastAutoStartSkipReason).toBeNull();
    expect(row.lastAutoStartSkipAt).toBeNull();
  });

  it("records the reason and when it was decided", async () => {
    const { db, issueId } = await seedOne();
    const at = new Date(Date.now() - 60_000).toISOString();

    expect(await persistAutoStartSkipReason(issueId, { reason: "wip_cap", at }, db)).toBeNull();

    const row = await readBack(db, issueId);
    expect(row.lastAutoStartSkipReason).toBe("wip_cap");
    expect(row.lastAutoStartSkipAt).toBe(at);
  });

  it("the LAST reason wins — a ticket held for a new reason does not keep the old one", async () => {
    const { db, issueId } = await seedOne();
    await persistAutoStartSkipReason(issueId, { reason: "wip_cap", at: "2026-08-29T10:00:00.000Z" }, db);
    await persistAutoStartSkipReason(issueId, { reason: "machine_saturated", at: "2026-08-29T10:30:00.000Z" }, db);

    const row = await readBack(db, issueId);
    expect(row.lastAutoStartSkipReason).toBe("machine_saturated");
    expect(row.lastAutoStartSkipAt).toBe("2026-08-29T10:30:00.000Z");
  });

  it("clears on a start — a running ticket must not still answer 'held for wip_cap'", async () => {
    // The whole point of the field is to answer truthfully; a stale hold on a ticket that IS
    // running contradicts it, so the monitor clears the issues it started this cycle.
    const { db, issueId } = await seedOne();
    await persistAutoStartSkipReason(issueId, { reason: "wip_cap", at: "2026-08-29T10:00:00.000Z" }, db);

    expect(await clearAutoStartSkipReason([issueId], db)).toBeNull();

    const row = await readBack(db, issueId);
    expect(row.lastAutoStartSkipReason).toBeNull();
    expect(row.lastAutoStartSkipAt).toBeNull();
  });

  it("clearing nothing is a no-op, not an empty IN () that clears every issue", async () => {
    const { db, issueId } = await seedOne();
    await persistAutoStartSkipReason(issueId, { reason: "contention_gate", at: "2026-08-29T10:00:00.000Z" }, db);

    expect(await clearAutoStartSkipReason([], db)).toBeNull();

    expect((await readBack(db, issueId)).lastAutoStartSkipReason).toBe("contention_gate");
  });

  it("RETURNS a write failure instead of throwing — the cycle must not abort on a decoration", async () => {
    // Same contract as persistStartScore (#917): the decision has already been made and acted
    // on by the time this runs, so a failed write costs the explanation, never the cycle.
    const exploding = { update: () => { throw new Error("db is gone"); } } as never;

    const err = await persistAutoStartSkipReason("issue-1", { reason: "wip_cap", at: "x" }, exploding);
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain("db is gone");

    const clearErr = await clearAutoStartSkipReason(["issue-1"], exploding);
    expect(clearErr).toBeInstanceOf(Error);
  });
});
