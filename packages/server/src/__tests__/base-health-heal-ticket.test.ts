/**
 * #1016 — land-then-heal's disclosure channel: when the base-health sweep goes red on a project
 * whose effective `redBasePolicy` is `allow-file-debt-ticket`, ONE `heal` ticket carries the
 * failing-suite list instead of N per-branch gates rediscovering it.
 *
 * The acceptance criteria of the ticket, one `it` each: a forced red sweep files exactly one
 * ticket, a second red sweep updates it (still one), a green sweep closes it, and a project on
 * `block` gets nothing at all.
 *
 * The policy is deliberately driven through the PREF here (`risk_posture_<projectId>`), not by
 * injecting a posture object: the whole point of #1015's resolver is that the red-base decision
 * is read in exactly one place, and a test that injected the answer would pass with the
 * resolver bypassed.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issueComments, issues, issueTags, preferences, projects, tags } from "@agentic-kanban/shared/schema";
import { healTicketExternalKey, HEAL_TICKET_TAG } from "@agentic-kanban/shared/lib/heal-ticket-key";
import { createTestDb } from "./helpers/test-db.js";
import { initializeProjectStatuses } from "../repositories/issue.repository.js";
import { invalidatePreferencesCache } from "../repositories/preferences.repository.js";
import { reconcileBaseHealthHealTicket } from "../services/base-health-heal-ticket.service.js";

const RED_SUITES = [
  "packages/server/src/__tests__/merge-gate.test.ts",
  "packages/shared/__tests__/git-exec-single-spawn.test.ts",
];

describe("base-health heal ticket (#1016)", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let projectId: string;
  let statusIds: Record<string, string>;

  async function setPosture(level: string): Promise<void> {
    await db.delete(preferences).where(eq(preferences.key, `risk_posture_${projectId}`));
    await db.insert(preferences).values({
      key: `risk_posture_${projectId}`,
      value: level,
      updatedAt: new Date().toISOString(),
    });
    invalidatePreferencesCache();
  }

  async function sweep(outcome: "red" | "green" | "timeout", failedSuites: string[] | null = null) {
    return reconcileBaseHealthHealTicket({
      projectId,
      outcome,
      sha: outcome === "green" ? "beef1234beef1234beef1234beef1234beef1234" : "cafe9876cafe9876cafe9876cafe9876cafe9876",
      branch: "master",
      failedSuites,
      healthRowId: "sweep-row-1",
      message: outcome === "red" ? "2 failed | 781 passed" : undefined,
    }, db);
  }

  async function healRows() {
    return db
      .select()
      .from(issues)
      .where(eq(issues.externalKey, healTicketExternalKey(projectId)));
  }

  beforeEach(async () => {
    ({ db } = createTestDb());
    invalidatePreferencesCache();
    projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      name: "heal-fixture",
      repoPath: "C:/repo",
      repoName: "repo",
      createdAt: new Date().toISOString(),
    });
    statusIds = await initializeProjectStatuses(projectId, new Date().toISOString(), db);
    // `sprint` is the level whose `redBasePolicy` is `allow-file-debt-ticket`.
    await setPosture("sprint");
  });

  it("files exactly one heal ticket on a red sweep — tagged, critical, top of the backlog", async () => {
    // A pre-existing backlog issue, so "top of the backlog" is an assertion about ORDER rather
    // than about the constant 0 an empty project would produce either way.
    await db.insert(issues).values({
      id: randomUUID(), issueNumber: 1, title: "some other work", description: null,
      priority: "medium", issueType: "task", skipAutoReview: false, estimate: null,
      sortOrder: 0, statusId: statusIds.Todo, projectId,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    const result = await sweep("red", RED_SUITES);
    expect(result.action).toBe("created");

    const rows = await healRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].priority).toBe("critical");
    expect(rows[0].sortOrder).toBeLessThan(0);
    expect(rows[0].title).toContain("2 failing suites");
    // The body is the whole point of the ticket: the suites, the sha, and the way back to the
    // sweep row that produced the verdict.
    for (const suite of RED_SUITES) expect(rows[0].description).toContain(suite);
    expect(rows[0].description).toContain("cafe9876cafe9876cafe9876cafe9876cafe9876");
    expect(rows[0].description).toContain("sweep-row-1");

    const linked = await db
      .select({ name: tags.name })
      .from(issueTags)
      .innerJoin(tags, eq(issueTags.tagId, tags.id))
      .where(eq(issueTags.issueId, rows[0].id));
    expect(linked.map((t) => t.name)).toContain(HEAL_TICKET_TAG);
  });

  it("updates the open ticket on a second red sweep instead of filing another", async () => {
    const first = await sweep("red", RED_SUITES);
    expect(first.action).toBe("created");

    const second = await sweep("red", ["packages/server/src/__tests__/only-one-now.test.ts"]);
    expect(second.action).toBe("updated");
    expect(second.issueId).toBe(first.issueId);

    const rows = await healRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toContain("1 failing suite");
    expect(rows[0].description).toContain("only-one-now.test.ts");
    // The superseded list is gone — the ticket describes the CURRENT red, not a union of every
    // red the base ever had.
    expect(rows[0].description).not.toContain("merge-gate.test.ts");
  });

  it("closes the heal ticket, with a comment, when a sweep goes green", async () => {
    const filed = await sweep("red", RED_SUITES);
    const closed = await sweep("green", []);
    expect(closed.action).toBe("closed");
    expect(closed.issueId).toBe(filed.issueId);

    const rows = await healRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].statusId).toBe(statusIds.Done);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, filed.issueId!));
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("GREEN");

    // A green sweep with nothing open is a no-op, not a second close.
    expect((await sweep("green", [])).action).toBe("noop");
  });

  it("files a fresh ticket for a NEW red episode once the previous one is closed", async () => {
    await sweep("red", RED_SUITES);
    await sweep("green", []);
    const reopened = await sweep("red", RED_SUITES);
    expect(reopened.action).toBe("created");

    // Two rows share the key — the invariant is "at most one OPEN heal ticket", which keeps a
    // legible history of episodes rather than reopening one ticket forever.
    const rows = await healRows();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.statusId !== statusIds.Done)).toHaveLength(1);
  });

  it("files nothing for a project whose red-base policy is 'block'", async () => {
    await setPosture("strict");
    const result = await sweep("red", RED_SUITES);
    expect(result.action).toBe("skipped_policy");
    expect(result.reason).toContain("block");
    expect(await healRows()).toHaveLength(0);
  });

  it("files nothing for 'allow-known-debt' either — only the debt-ticket policy files", async () => {
    await setPosture("fast");
    expect((await sweep("red", RED_SUITES)).action).toBe("skipped_policy");
    expect(await healRows()).toHaveLength(0);
  });

  it("files nothing for a project with no posture chosen at all", async () => {
    await db.delete(preferences).where(eq(preferences.key, `risk_posture_${projectId}`));
    invalidatePreferencesCache();
    expect((await sweep("red", RED_SUITES)).action).toBe("skipped_policy");
    expect(await healRows()).toHaveLength(0);
  });

  it("neither files nor closes on a probe that produced no verdict", async () => {
    expect((await sweep("timeout")).action).toBe("skipped_no_verdict");
    expect(await healRows()).toHaveLength(0);

    await sweep("red", RED_SUITES);
    // A timeout AFTER a red must not close the open ticket: it observed nothing.
    expect((await sweep("timeout")).action).toBe("skipped_no_verdict");
    const rows = await healRows();
    expect(rows[0].statusId).not.toBe(statusIds.Done);
  });
});
