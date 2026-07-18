/**
 * #94 — repo-aware epic decomposition: confirmEpicDecomposition carries each child's
 * (validated) target repo onto the child as a `repo:<name>` tag, and only does so for
 * multi-repo projects (single-repo behaviour is unchanged).
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { confirmEpicDecomposition } from "../services/issue-ai.service.js";

type Db = ReturnType<typeof createTestDb>["db"];

async function seedProject(db: Db) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId, name: "P", repoPath: "/tmp/web", repoName: "web",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  const statusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: statusId, projectId, name: "Backlog", sortOrder: 0, isDefault: true, createdAt: now,
  });
  return { projectId, statusId };
}

async function addSiblingRepo(db: Db, projectId: string, name: string, path: string) {
  await db.insert(schema.repos).values({ id: randomUUID(), projectId, workspaceId: null, path, name });
}

async function insertEpic(db: Db, projectId: string, statusId: string) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(schema.issues).values({
    id, issueNumber: 1, title: "Meta epic", priority: "medium",
    sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  return id;
}

/** The repo-tag names linked to a given issue. */
async function repoTagsFor(db: Db, issueId: string): Promise<string[]> {
  const links = await db.select().from(schema.issueTags).where(eq(schema.issueTags.issueId, issueId));
  if (links.length === 0) return [];
  const tagRows = await db.select().from(schema.tags).where(inArray(schema.tags.id, links.map((l) => l.tagId)));
  return tagRows.map((t) => t.name).filter((n) => n.startsWith("repo:")).sort();
}

describe("confirmEpicDecomposition — repo-aware fan-out (#94)", () => {
  it("tags each child with repo:<targetRepo> in a multi-repo project (validated, canonical)", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    await addSiblingRepo(db, projectId, "api", "/tmp/api");
    const parentId = await insertEpic(db, projectId, statusId);

    const result = await confirmEpicDecomposition(
      {
        issueId: parentId,
        projectId,
        children: [
          { tempId: "t1", title: "Frontend work", priority: "medium", targetRepo: "web" },
          { tempId: "t2", title: "Backend work", priority: "medium", targetRepo: "API" }, // canonicalizes
          { tempId: "t3", title: "Unknown repo", priority: "medium", targetRepo: "mobile" }, // dropped
          { tempId: "t4", title: "No repo", priority: "medium" }, // unassigned
        ],
        dependencies: [],
      },
      db as any,
    );

    const byTemp = new Map(result.createdIssues.map((c) => [c.tempId, c.id]));
    expect(await repoTagsFor(db, byTemp.get("t1")!)).toEqual(["repo:web"]);
    expect(await repoTagsFor(db, byTemp.get("t2")!)).toEqual(["repo:api"]);
    expect(await repoTagsFor(db, byTemp.get("t3")!)).toEqual([]);
    expect(await repoTagsFor(db, byTemp.get("t4")!)).toEqual([]);

    // The repo tag is auto-created once and reused (no duplicate repo:web rows).
    const webTags = await db.select().from(schema.tags).where(like(schema.tags.name, "repo:web"));
    expect(webTags).toHaveLength(1);
  });

  it("applies no repo tags for a single-repo project (no behaviour change)", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    const parentId = await insertEpic(db, projectId, statusId);

    const result = await confirmEpicDecomposition(
      {
        issueId: parentId,
        projectId,
        children: [{ tempId: "t1", title: "Some work", priority: "medium", targetRepo: "web" }],
        dependencies: [],
      },
      db as any,
    );

    expect(await repoTagsFor(db, result.createdIssues[0].id)).toEqual([]);
  });
});
