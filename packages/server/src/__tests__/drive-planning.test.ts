/**
 * #1072 — a drive started from a target sentence must be able to acquire a scope.
 *
 * Before this, `metaIssueId` could only be set at creation time, so a target-only drive was a
 * permanent 0/0 whose dashboard told the operator to do something the board offered nowhere.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import {
  buildEpicDescription,
  deriveEpicTitle,
  MAX_EPIC_TITLE_LENGTH,
  planDrive,
} from "../services/drive-planning.service.js";
import { DriveError } from "../services/drive.service.js";

type Db = ReturnType<typeof createTestDb>["db"];

async function seedProject(db: Db, { withBacklog = true } = {}) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId, name: "P", repoPath: "/tmp/p", repoName: "p",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  await db.insert(schema.projectStatuses).values({
    id: randomUUID(), projectId, name: withBacklog ? "Backlog" : "Inbox",
    sortOrder: 0, isDefault: true, createdAt: now,
  });
  return projectId;
}

async function seedDrive(db: Db, projectId: string, over: Record<string, unknown> = {}) {
  const id = randomUUID();
  await db.insert(schema.drives).values({
    id, projectId, metaIssueId: null, target: "Ship the jira sync plugin",
    completionContract: null, status: "active",
    startedAt: new Date().toISOString(), finishedAt: null, ...over,
  });
  return id;
}

describe("planDrive (#1072)", () => {
  it("seeds an epic from the target and links the drive to it", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const driveId = await seedDrive(db, projectId);

    const result = await planDrive(projectId, driveId, db as never);

    expect(result.existing).toBe(false);
    expect(result.issue.title).toBe("Ship the jira sync plugin");
    expect(result.issue.issueNumber).toBe(1);

    // The drive is now scopeable — this pointer is the ONLY thing the dashboard reads.
    const [drive] = await db.select().from(schema.drives).where(eq(schema.drives.id, driveId));
    expect(drive.metaIssueId).toBe(result.issue.id);

    // The full target survives in the body even when the title is trimmed, and the epic
    // lands in Backlog so an auto-start pass cannot grab it before decomposition.
    const [issue] = await db.select().from(schema.issues).where(eq(schema.issues.id, result.issue.id));
    expect(issue.description).toContain("Ship the jira sync plugin");
    const [status] = await db
      .select().from(schema.projectStatuses).where(eq(schema.projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Backlog");
  });

  it("tags the epic `epic`, exactly as a hand-decomposed one is", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const driveId = await seedDrive(db, projectId);

    const { issue } = await planDrive(projectId, driveId, db as never);

    const links = await db.select().from(schema.issueTags).where(eq(schema.issueTags.issueId, issue.id));
    expect(links).toHaveLength(1);
    const [tag] = await db.select().from(schema.tags).where(eq(schema.tags.id, links[0].tagId));
    expect(tag.name).toBe("epic");
  });

  it("is idempotent — a second plan returns the same epic, never a rival one", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const driveId = await seedDrive(db, projectId);

    const first = await planDrive(projectId, driveId, db as never);
    const second = await planDrive(projectId, driveId, db as never);

    expect(second.existing).toBe(true);
    expect(second.issue.id).toBe(first.issue.id);
    // A second epic would silently split the drive's scope, since the dashboard reads
    // `metaIssueId` alone and would never see the other one's children.
    const issues = await db.select().from(schema.issues);
    expect(issues).toHaveLength(1);
  });

  it("can be re-planned after its epic is deleted", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const driveId = await seedDrive(db, projectId);
    const first = await planDrive(projectId, driveId, db as never);

    // `drives.meta_issue_id` is `on delete set null`, so deleting the epic cannot leave a
    // dangling pointer — it releases the drive. This is why `planDrive` needs no dangling-id
    // recovery branch: the only way to lose the epic is the one that also clears the link.
    // The tag link is a restricting FK — real deletion goes through the cascade-delete path,
    // which clears it first. Mirror that here rather than exercising a half-delete.
    await db.delete(schema.issueTags).where(eq(schema.issueTags.issueId, first.issue.id));
    await db.delete(schema.issues).where(eq(schema.issues.id, first.issue.id));
    const [released] = await db.select().from(schema.drives).where(eq(schema.drives.id, driveId));
    expect(released.metaIssueId).toBeNull();

    const second = await planDrive(projectId, driveId, db as never);
    expect(second.existing).toBe(false);
    expect(second.issue.id).not.toBe(first.issue.id);
  });

  it("falls back to the default status when the project has no Backlog column", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db, { withBacklog: false });
    const driveId = await seedDrive(db, projectId);

    const { issue } = await planDrive(projectId, driveId, db as never);
    const [row] = await db.select().from(schema.issues).where(eq(schema.issues.id, issue.id));
    expect(row.statusId).toBeTruthy();
  });

  it("refuses a drive belonging to another project", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const other = await seedProject(db);
    const driveId = await seedDrive(db, projectId);

    await expect(planDrive(other, driveId, db as never)).rejects.toThrow(DriveError);
  });

  it("refuses an unknown drive", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    await expect(planDrive(projectId, randomUUID(), db as never)).rejects.toThrow(/not found/i);
  });
});

describe("deriveEpicTitle", () => {
  it("keeps a short target verbatim", () => {
    expect(deriveEpicTitle("  Ship   the sync  ")).toBe("Ship the sync");
  });

  it("truncates a long target at a word boundary, never mid-word", () => {
    const target =
      "Create a valid jira integration sync with all expected parts as a plugin, extend the plugin system as needed";
    const title = deriveEpicTitle(target);
    expect(title.length).toBeLessThanOrEqual(MAX_EPIC_TITLE_LENGTH + 1); // + the ellipsis
    expect(title.endsWith("…")).toBe(true);
    // The cut lands on a boundary: dropping the ellipsis leaves a prefix of the target.
    expect(target.startsWith(title.slice(0, -1))).toBe(true);
  });

  it("hard-cuts a target with no early word boundary", () => {
    const title = deriveEpicTitle("a".repeat(200));
    expect(title).toBe(`${"a".repeat(MAX_EPIC_TITLE_LENGTH)}…`);
  });
});

describe("buildEpicDescription", () => {
  it("promotes the completion contract to its own section", () => {
    const body = buildEpicDescription("Ship it", "All children Done AND master contains the work");
    expect(body).toContain("## Drive target");
    expect(body).toContain("## Completion contract");
    expect(body).toContain("All children Done AND master contains the work");
  });

  it("omits the contract section when the drive carries none", () => {
    expect(buildEpicDescription("Ship it", null)).not.toContain("## Completion contract");
    expect(buildEpicDescription("Ship it", "   ")).not.toContain("## Completion contract");
  });
});
