import { describe, it, expect, beforeAll } from "vitest";
import { createRoutes } from "../routes/index.js";
import * as schema from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createMockSessionManager } from "./helpers/mocks.js";

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api", createRoutes(db, () => createMockSessionManager()));
  });
}

// Helper: create a project + status so we can create issues
async function createProjectAndStatus(
  database: TestDb,
  name = "Tag Test Project",
) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await database.insert(schema.projects).values({
    id: projectId,
    name,
    repoPath: `/tmp/${name.replace(/\s+/g, "-")}`,
    repoName: name.replace(/\s+/g, "-"),
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  const statusId = randomUUID();
  await database.insert(schema.projectStatuses).values({
    id: statusId,
    projectId,
    name: "Todo",
    sortOrder: 0,
    isDefault: true,
    createdAt: now,
  });

  return { projectId, statusId };
}

describe("Tags API - CRUD", () => {
  const { app } = createTestApp();

  it("GET /api/tags returns empty list initially", async () => {
    const res = await app.request("/api/tags");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toEqual([]);
  });

  it("POST /api/tags creates a tag", async () => {
    const res = await app.request("/api/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bug", color: "#ff0000" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.name).toBe("bug");
    expect(body.color).toBe("#ff0000");
    expect(body.id).toBeDefined();
  });

  it("POST /api/tags requires a name", async () => {
    const res = await app.request("/api/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color: "#00ff00" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain("name is required");
  });

  it("POST /api/tags rejects duplicate name with 409", async () => {
    await app.request("/api/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "duplicate-tag" }),
    });

    const res = await app.request("/api/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "duplicate-tag" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toContain("already exists");
  });

  it("POST /api/tags rejects name that matches a builtin tag with 409", async () => {
    const { app: isolatedApp, db: isolatedDb } = createTestApp();

    // Seed a builtin tag
    await isolatedDb.insert(schema.tags).values({
      id: randomUUID(),
      name: "builtin-unique",
      color: "#F59E0B",
      isBuiltin: true,
      createdAt: new Date().toISOString(),
    });

    const res = await isolatedApp.request("/api/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "builtin-unique" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toContain("built-in tag");
  });

  it("POST /api/tags creates a tag without color", async () => {
    const res = await app.request("/api/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "feature" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.name).toBe("feature");
    expect(body.color).toBeNull();
  });

  it("GET /api/tags returns all created tags", async () => {
    const res = await app.request("/api/tags");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.length).toBeGreaterThanOrEqual(2);

    const names = body.map((t: { name: string }) => t.name);
    expect(names).toContain("bug");
    expect(names).toContain("feature");
  });

  it("PATCH /api/tags/:id updates tag name", async () => {
    const createRes = await app.request("/api/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "to-update" }),
    });
    const { id } = await createRes.json();

    const res = await app.request(`/api/tags/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "updated-name" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.id).toBe(id);

    // Verify update
    const tags = await (await app.request("/api/tags")).json();
    const updated = tags.find((t: { id: string }) => t.id === id);
    expect(updated.name).toBe("updated-name");
  });

  it("PATCH /api/tags/:id updates tag color", async () => {
    const createRes = await app.request("/api/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "color-test", color: "#111111" }),
    });
    const { id } = await createRes.json();

    const res = await app.request(`/api/tags/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color: "#222222" }),
    });
    expect(res.status).toBe(200);

    const tags = await (await app.request("/api/tags")).json();
    const updated = tags.find((t: { id: string }) => t.id === id);
    expect(updated.color).toBe("#222222");
  });

  it("PATCH /api/tags/:id rejects empty update", async () => {
    const createRes = await app.request("/api/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "no-update" }),
    });
    const { id } = await createRes.json();

    const res = await app.request(`/api/tags/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain("No fields to update");
  });

  it("DELETE /api/tags/:id deletes a tag", async () => {
    const createRes = await app.request("/api/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "to-delete" }),
    });
    const { id } = await createRes.json();

    const res = await app.request(`/api/tags/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);

    // Verify gone
    const tags = await (await app.request("/api/tags")).json();
    const deleted = tags.find((t: { id: string }) => t.id === id);
    expect(deleted).toBeUndefined();
  });
});

describe("Tags API - Issue Associations", () => {
  const { app, db: database } = createTestApp();

  it("deleting a tag removes its issue associations", async () => {
    const { projectId, statusId } = await createProjectAndStatus(database, "Tag Assoc Project");

    // Create a tag
    const tagRes = await app.request("/api/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "assoc-test-tag", color: "#ff00ff" }),
    });
    const tag = await tagRes.json();

    // Create an issue
    const issueRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Tag association issue", statusId, projectId }),
    });
    const issue = await issueRes.json();

    // Associate tag with issue
    const assocRes = await app.request(`/api/issues/${issue.id}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tagId: tag.id }),
    });
    expect(assocRes.status).toBe(201);

    // Verify association exists
    const issueTags = await (
      await app.request(`/api/issues/${issue.id}/tags`)
    ).json();
    expect(issueTags.length).toBe(1);
    expect(issueTags[0].name).toBe("assoc-test-tag");

    // Delete the tag
    await app.request(`/api/tags/${tag.id}`, { method: "DELETE" });

    // Verify issue no longer has the tag
    const issueTagsAfter = await (
      await app.request(`/api/issues/${issue.id}/tags`)
    ).json();
    expect(issueTagsAfter).toEqual([]);
  });

  it("issue tag associations work end-to-end (assign, list, remove)", async () => {
    const { projectId, statusId } = await createProjectAndStatus(database, "E2E Tag Project");

    // Create two tags
    const tag1Res = await app.request("/api/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "e2e-tag-1", color: "#aabbcc" }),
    });
    const tag1 = await tag1Res.json();

    const tag2Res = await app.request("/api/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "e2e-tag-2", color: "#ddeeff" }),
    });
    const tag2 = await tag2Res.json();

    // Create an issue
    const issueRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Multi-tag issue", statusId, projectId }),
    });
    const issue = await issueRes.json();

    // Assign both tags
    await app.request(`/api/issues/${issue.id}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tagId: tag1.id }),
    });
    await app.request(`/api/issues/${issue.id}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tagId: tag2.id }),
    });

    // Verify both tags
    const tags = await (
      await app.request(`/api/issues/${issue.id}/tags`)
    ).json();
    expect(tags.length).toBe(2);

    // Remove one tag
    await app.request(`/api/issues/${issue.id}/tags/${tag1.id}`, {
      method: "DELETE",
    });

    // Verify only one remains
    const remaining = await (
      await app.request(`/api/issues/${issue.id}/tags`)
    ).json();
    expect(remaining.length).toBe(1);
    expect(remaining[0].name).toBe("e2e-tag-2");
  });

  it("POST /api/issues/:id/tags requires tagId", async () => {
    const { projectId, statusId } = await createProjectAndStatus(database, "Tag Validation Project");
    const issueRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Tag validation issue", statusId, projectId }),
    });
    const issue = await issueRes.json();

    const res = await app.request(`/api/issues/${issue.id}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain("tagId is required");
  });

  it("deleting an issue does not delete associated tags", async () => {
    const { projectId, statusId } = await createProjectAndStatus(database, "Tag Issue Delete Project");

    // Create tag
    const tagRes = await app.request("/api/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "persistent-tag", color: "#333333" }),
    });
    const tag = await tagRes.json();

    // Create issue and associate
    const issueRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Issue to delete", statusId, projectId }),
    });
    const issue = await issueRes.json();

    await app.request(`/api/issues/${issue.id}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tagId: tag.id }),
    });

    // Delete the issue
    await app.request(`/api/issues/${issue.id}`, { method: "DELETE" });

    // Verify the tag still exists
    const tags = await (await app.request("/api/tags")).json();
    const found = tags.find((t: { id: string }) => t.id === tag.id);
    expect(found).toBeDefined();
    expect(found.name).toBe("persistent-tag");
  });
});

describe("Tags API - Built-in tag protection", () => {
  const { app, db: database } = createTestApp();

  async function createBuiltinTag(name: string) {
    const { randomUUID } = await import("node:crypto");
    const id = randomUUID();
    await database.insert(schema.tags).values({
      id,
      name,
      color: "#F59E0B",
      isBuiltin: true,
      createdAt: new Date().toISOString(),
    });
    return id;
  }

  it("GET /api/tags includes isBuiltin field", async () => {
    const res = await app.request("/api/tags");
    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    // All returned tags should have the isBuiltin property
    for (const tag of body) {
      expect(typeof tag.isBuiltin === "boolean" || tag.isBuiltin === 0 || tag.isBuiltin === 1).toBe(true);
    }
  });

  it("DELETE /api/tags/:id rejects built-in tag with 403", async () => {
    const id = await createBuiltinTag("needs-visual-verification-test");
    const res = await app.request(`/api/tags/${id}`, { method: "DELETE" });
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error).toContain("Built-in tags cannot be deleted");
  });

  it("PATCH /api/tags/:id rejects built-in tag rename with 403", async () => {
    const id = await createBuiltinTag("builtin-rename-test");
    const res = await app.request(`/api/tags/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "renamed" }),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error).toContain("Built-in tags cannot be modified");
  });

  it("POST /api/tags/merge rejects merging away built-in tag with 403", async () => {
    const builtinId = await createBuiltinTag("builtin-merge-source");
    const regularRes = await app.request("/api/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "merge-target" }),
    });
    const { id: targetId } = await regularRes.json();

    const res = await app.request("/api/tags/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetId, sourceIds: [builtinId] }),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error).toContain("Built-in tags cannot be merged away");
  });

  it("non-builtin tags can still be deleted normally", async () => {
    const createRes = await app.request("/api/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "deletable-tag" }),
    });
    const { id } = await createRes.json();

    const res = await app.request(`/api/tags/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
  });

  it("non-builtin tags can still be renamed normally", async () => {
    const createRes = await app.request("/api/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "renamable-tag" }),
    });
    const { id } = await createRes.json();

    const res = await app.request(`/api/tags/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "renamed-tag" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("ensureBuiltinTags", () => {
  it("creates needs-visual-verification as a builtin tag on a fresh DB", async () => {
    const { ensureBuiltinTags, BUILTIN_TAGS } = await import("../db/seed.js");
    const { db: database } = createTestDb();

    await ensureBuiltinTags(database as any);

    const result = await database.select().from(schema.tags);
    for (const builtin of BUILTIN_TAGS) {
      const found = result.find((t) => t.name === builtin.name);
      expect(found).toBeDefined();
      expect(found!.isBuiltin).toBe(true);
      expect(found!.color).toBe(builtin.color);
    }
  });

  it("is idempotent � running twice does not create duplicate tags", async () => {
    const { ensureBuiltinTags } = await import("../db/seed.js");
    const { db: database } = createTestDb();

    await ensureBuiltinTags(database as any);
    await ensureBuiltinTags(database as any);

    const result = await database.select().from(schema.tags);
    const nvv = result.filter((t) => t.name === "needs-visual-verification");
    expect(nvv.length).toBe(1);
  });

  it("marks existing non-builtin needs-visual-verification tag as builtin", async () => {
    const { ensureBuiltinTags } = await import("../db/seed.js");
    const { db: database } = createTestDb();

    // Insert needs-visual-verification WITHOUT isBuiltin (simulates pre-migration DB)
    await database.insert(schema.tags).values({
      id: randomUUID(),
      name: "needs-visual-verification",
      color: "#F59E0B",
      isBuiltin: false,
      createdAt: new Date().toISOString(),
    });

    await ensureBuiltinTags(database as any);

    const result = await database.select().from(schema.tags);
    const nvv = result.find((t) => t.name === "needs-visual-verification");
    expect(nvv).toBeDefined();
    expect(nvv!.isBuiltin).toBe(true);
  });

  it("does not remove or alter existing non-builtin tags", async () => {
    const { ensureBuiltinTags } = await import("../db/seed.js");
    const { db: database } = createTestDb();

    await database.insert(schema.tags).values({
      id: randomUUID(),
      name: "my-custom-tag",
      color: "#ff0000",
      isBuiltin: false,
      createdAt: new Date().toISOString(),
    });

    await ensureBuiltinTags(database as any);

    const result = await database.select().from(schema.tags);
    const custom = result.find((t) => t.name === "my-custom-tag");
    expect(custom).toBeDefined();
    expect(custom!.isBuiltin).toBe(false);
  });
});
