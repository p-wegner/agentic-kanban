/**
 * Ticket groups (#661): one workspace serves N coupled tickets.
 *
 * Covers the three load-bearing pieces:
 *  - merge fan-out: finalizeMergeCleanup converges MEMBER issues to Done with the lead
 *  - monitor blindness fix: filterIssuesWithLiveGroupWorkspace flags members of a live
 *    group (and stops flagging them once the group workspace closes)
 *  - ticket context: the group's member tickets render in full, with per-ticket commit
 *    discipline, and single-ticket rendering is unchanged
 */
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { issues, projectStatuses, projects, workspaces, workspaceIssueMembers } from "@agentic-kanban/shared/schema";
import { buildTicketContextMarkdown } from "@agentic-kanban/shared/lib/ticket-context";
import { MIGRATION_FILES, MIGRATIONS_DIR } from "./helpers/migrations.js";
import type { TestDb } from "./helpers/test-db.js";
import { finalizeMergeCleanup } from "../services/merge-cleanup.service.js";
import {
  filterIssuesWithLiveGroupWorkspace,
  listMemberIssueIds,
} from "../repositories/workspace-issue-members.repository.js";

const tempClients: ReturnType<typeof createClient>[] = [];

afterEach(async () => {
  for (const client of tempClients.splice(0)) {
    await client.close();
  }
});

async function createGroupTestDb() {
  const dir = mkdtempSync(join(tmpdir(), "ak-ticket-groups-"));
  const client = createClient({ url: `file:${join(dir, "test.db")}` });
  tempClients.push(client);
  for (const file of MIGRATION_FILES) {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf-8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await client.execute(stmt);
    }
  }
  const db = drizzle(client, { schema });
  return { client, db };
}

async function seedGroup(db: TestDb) {
  const now = "2026-08-19T10:00:00.000Z";
  const projectId = randomUUID();
  const inProgressStatusId = randomUUID();
  const doneStatusId = randomUUID();
  const leadIssueId = randomUUID();
  const memberAId = randomUUID();
  const memberBId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    name: "Ticket group test",
    repoPath: "/repo",
    repoName: "repo",
    defaultBranch: "master",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: inProgressStatusId, projectId, name: "In Progress", sortOrder: 2, isDefault: false, createdAt: now },
    { id: doneStatusId, projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: now },
  ]);
  const issueRow = (id: string, n: number, title: string) => ({
    id, issueNumber: n, title, priority: "medium", sortOrder: 0,
    statusId: inProgressStatusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(issues).values([
    issueRow(leadIssueId, 700, "Lead ticket"),
    issueRow(memberAId, 701, "Member A"),
    issueRow(memberBId, 702, "Member B"),
  ]);
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId: leadIssueId,
    branch: "feature/ak-700-lead-ticket",
    workingDir: "/repo/.worktrees/feature_ak-700-lead-ticket",
    baseBranch: "master",
    isDirect: false,
    status: "idle",
    readyForMerge: true,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workspaceIssueMembers).values([
    { workspaceId, issueId: memberAId, createdAt: now },
    { workspaceId, issueId: memberBId, createdAt: now },
  ]);

  return { projectId, leadIssueId, memberAId, memberBId, workspaceId, inProgressStatusId, doneStatusId };
}

describe("ticket groups — merge fan-out", () => {
  it("finalizeMergeCleanup converges every member issue to Done alongside the lead", async () => {
    const { db } = await createGroupTestDb();
    const s = await seedGroup(db);

    await finalizeMergeCleanup({
      database: db,
      workspaceId: s.workspaceId,
      issueId: s.leadIssueId,
      projectId: s.projectId,
      now: "2026-08-19T11:00:00.000Z",
      mergedAt: "2026-08-19T11:00:00.000Z",
      workingDir: null,
    });

    for (const issueId of [s.leadIssueId, s.memberAId, s.memberBId]) {
      const [row] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
      expect(row.statusId).toBe(s.doneStatusId);
    }
  });

  it("is idempotent — a second cleanup pass leaves converged members untouched", async () => {
    const { db } = await createGroupTestDb();
    const s = await seedGroup(db);
    const args = {
      database: db,
      workspaceId: s.workspaceId,
      issueId: s.leadIssueId,
      projectId: s.projectId,
      now: "2026-08-19T11:00:00.000Z",
      mergedAt: "2026-08-19T11:00:00.000Z",
      workingDir: null,
    };
    await finalizeMergeCleanup(args);
    const second = await finalizeMergeCleanup({ ...args, now: "2026-08-19T11:05:00.000Z" });
    expect(second.issueTransitioned).toBe(false);
    const [memberA] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, s.memberAId));
    expect(memberA.statusId).toBe(s.doneStatusId);
  });

  it("respects a deliberate member reopen (recency guard) on catch-up passes", async () => {
    const { db } = await createGroupTestDb();
    const s = await seedGroup(db);
    // The group merged at 11:00; a human reopened member A at 11:10.
    await db.update(workspaces).set({ mergedAt: "2026-08-19T11:00:00.000Z", status: "closed" })
      .where(eq(workspaces.id, s.workspaceId));
    await db.update(issues).set({ statusId: s.inProgressStatusId, statusChangedAt: "2026-08-19T11:10:00.000Z" })
      .where(eq(issues.id, s.memberAId));

    const { reconcileGroupMemberIssues } = await import("../services/merge-cleanup.service.js");
    await reconcileGroupMemberIssues({
      database: db,
      workspaceId: s.workspaceId,
      projectId: s.projectId,
      now: "2026-08-19T11:20:00.000Z",
      mergedAt: "2026-08-19T11:00:00.000Z",
    });

    const [memberA] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, s.memberAId));
    const [memberB] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, s.memberBId));
    expect(memberA.statusId).toBe(s.inProgressStatusId); // reopen respected
    expect(memberB.statusId).toBe(s.doneStatusId); // straggler converged
  });
});

describe("ticket groups — membership queries", () => {
  it("flags members of a LIVE group workspace and releases them once it closes", async () => {
    const { db } = await createGroupTestDb();
    const s = await seedGroup(db);

    const live = await filterIssuesWithLiveGroupWorkspace([s.leadIssueId, s.memberAId, s.memberBId], db);
    expect(live.has(s.memberAId)).toBe(true);
    expect(live.has(s.memberBId)).toBe(true);
    // The lead is tracked by workspaces.issue_id, never by membership rows.
    expect(live.has(s.leadIssueId)).toBe(false);

    await db.update(workspaces).set({ status: "closed" }).where(eq(workspaces.id, s.workspaceId));
    const afterClose = await filterIssuesWithLiveGroupWorkspace([s.memberAId, s.memberBId], db);
    expect(afterClose.size).toBe(0);

    expect((await listMemberIssueIds(s.workspaceId, db)).sort()).toEqual([s.memberAId, s.memberBId].sort());
  });
});

describe("ticket groups — ticket context rendering", () => {
  it("renders every member ticket in full with per-ticket commit discipline", () => {
    const md = buildTicketContextMarkdown({
      issueNumber: 700,
      title: "Lead ticket",
      description: "Lead body",
      groupTickets: [
        { issueNumber: 701, title: "Member A", description: "Body A" },
        { issueNumber: 702, title: "Member B", description: null },
      ],
    });
    expect(md).toContain("# Ticket #700: Lead ticket");
    expect(md).toContain("TICKET GROUP");
    expect(md).toContain("### Ticket #701: Member A");
    expect(md).toContain("Body A");
    expect(md).toContain("### Ticket #702: Member B");
    expect(md).toContain("separate commit per ticket");
    // The board closes the whole group on merge — the agent must be told.
    expect(md).toContain("closes EVERY ticket in the group");
  });

  it("leaves single-ticket rendering unchanged", () => {
    const md = buildTicketContextMarkdown({ issueNumber: 700, title: "Solo", description: "Body" });
    expect(md).toContain("This is the task you are working on.");
    expect(md).not.toContain("TICKET GROUP");
  });
});
