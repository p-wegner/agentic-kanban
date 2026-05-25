import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { createRoutes } from "../routes/index.js";
import type { SessionManager } from "../services/session.manager.js";
import * as schema from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_FILES = [
  "../../../shared/drizzle/0000_flawless_trauma.sql",
  "../../../shared/drizzle/0001_magical_johnny_storm.sql",
  "../../../shared/drizzle/0002_bent_may_parker.sql",
  "../../../shared/drizzle/0003_tough_lightspeed.sql",
  "../../../shared/drizzle/0004_boring_wind_dancer.sql",
  "../../../shared/drizzle/0005_silky_frog_thor.sql",
  "../../../shared/drizzle/0006_wide_ogun.sql",
  "../../../shared/drizzle/0007_diff_comments.sql",
  "../../../shared/drizzle/0008_direct_workspace.sql",
  "../../../shared/drizzle/0009_requires_review.sql",
  "../../../shared/drizzle/0010_session_messages_cascade.sql",
  "../../../shared/drizzle/0011_timestamps.sql",
  "../../../shared/drizzle/0012_session_stats.sql",
  "../../../shared/drizzle/0013_plan_mode.sql",
  "../../../shared/drizzle/0014_issue_dependencies.sql",
  "../../../shared/drizzle/0015_ai_reviewed_status.sql",
  "../../../shared/drizzle/0016_skip_auto_review.sql",
  "../../../shared/drizzle/0017_agent_config.sql",
  "../../../shared/drizzle/0018_agent_skills.sql",
  "../../../shared/drizzle/0019_workspace_skill.sql",
  "../../../shared/drizzle/0023_dependency_types.sql",
  "../../../shared/drizzle/0020_setup_script.sql",
  "../../../shared/drizzle/0021_project_skills.sql",
  "../../../shared/drizzle/0022_teardown_script.sql",
  "../../../shared/drizzle/0024_setup_enabled.sql",
  "../../../shared/drizzle/0025_provider_session_id.sql",
  "../../../shared/drizzle/0026_ready_for_merge.sql",
  "../../../shared/drizzle/0027_estimate_field.sql",
  "../../../shared/drizzle/0028_perf_indexes_conflict_cache.sql",
  "../../../shared/drizzle/0029_issue_artifacts.sql",
  "../../../shared/drizzle/0030_thorough_review.sql",
  "../../../shared/drizzle/0031_scheduled_runs.sql",
  "../../../shared/drizzle/0032_diff_stat_cache.sql",
  "../../../shared/drizzle/0033_backlog_status.sql",
  "../../../shared/drizzle/0034_session_pid.sql",
  "../../../shared/drizzle/0035_session_trigger.sql",
  "../../../shared/drizzle/0036_scheduled_runs_cron.sql",
  "../../../shared/drizzle/0037_workspace_provider.sql",
  "../../../shared/drizzle/0038_pending_plan_path.sql",
  "../../../shared/drizzle/0039_nullable_default_branch.sql",
  "../../../shared/drizzle/0040_direct_workspace_base_commit.sql",
  "../../../shared/drizzle/0041_builtin_tags.sql",
];

function createTestApp() {
  const client = createClient({ url: ":memory:" });
  for (const file of MIGRATION_FILES) {
    const sql = readFileSync(resolve(__dirname, file), "utf-8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      client.execute(stmt);
    }
  }

  const database = drizzle(client, { schema });
  const app = new Hono();

  const mockSessionManager = {
    startSession: async () => "mock-session-id",
    stopSession: async () => true,
    subscribe: () => {},
    unsubscribe: () => {},
    wsRoute: () => () => {},
  } as unknown as SessionManager;

  app.route("/api", createRoutes(database, () => mockSessionManager));
  return { app, db: database };
}

// Helper: create a project + status so we can create issues
async function createProjectAndStatus(
  database: ReturnType<typeof drizzle<typeof schema>>,
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
