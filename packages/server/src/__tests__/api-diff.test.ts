import { describe, it, expect, beforeAll } from "vitest";
import * as schema from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { TestDb } from "./helpers/test-db.js";
import {
  createTestApp,
  createTestAppWithBoardEvents,
  createProjectDirectly,
  createStatusDirectly,
} from "./helpers/api-test-helpers.js";

describe("Diff Comments API", () => {
  const { app, db: database } = createTestApp();
  let workspaceId: string;

  beforeAll(async () => {
    const projectId = await createProjectDirectly(database, { name: "Comments Test Project" });
    const statusId = await createStatusDirectly(database, projectId, "Todo", 0);

    const issueRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Comment test issue", statusId, projectId }),
    });
    const issueId = (await issueRes.json()).id;

    const wsRes = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId, branch: "feature/comments" }),
    });
    workspaceId = (await wsRes.json()).id;
  });

  it("POST creates a comment", async () => {
    const res = await app.request(`/api/workspaces/${workspaceId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filePath: "src/index.ts",
        lineNumNew: 10,
        side: "new",
        body: "Looks good",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.filePath).toBe("src/index.ts");
    expect(body.body).toBe("Looks good");
    expect(body.workspaceId).toBe(workspaceId);
    expect(body.id).toBeDefined();
  });

  it("POST requires filePath and body", async () => {
    const res = await app.request(`/api/workspaces/${workspaceId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lineNumNew: 5 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain("filePath and body are required");
  });

  it("POST returns 404 for missing workspace", async () => {
    const res = await app.request(`/api/workspaces/${randomUUID()}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: "a.ts", body: "test" }),
    });
    expect(res.status).toBe(404);
  });

  it("GET lists comments for workspace", async () => {
    const res = await app.request(`/api/workspaces/${workspaceId}/comments`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body[0].filePath).toBeDefined();
  });

  it("GET filters by filePath", async () => {
    // Create another comment on a different file
    await app.request(`/api/workspaces/${workspaceId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: "src/other.ts", body: "Another comment" }),
    });

    const res = await app.request(`/api/workspaces/${workspaceId}/comments?filePath=src/index.ts`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.every((c: { filePath: string }) => c.filePath === "src/index.ts")).toBe(true);
  });

  it("PATCH updates a comment", async () => {
    // Create a comment
    const createRes = await app.request(`/api/workspaces/${workspaceId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: "a.ts", body: "Original" }),
    });
    const { id } = await createRes.json();

    const res = await app.request(`/api/workspaces/${workspaceId}/comments/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Updated" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.id).toBe(id);

    // Verify update
    const comments = await (await app.request(`/api/workspaces/${workspaceId}/comments`)).json();
    const updated = comments.find((c: { id: string }) => c.id === id);
    expect(updated.body).toBe("Updated");
  });

  it("PATCH requires body", async () => {
    const res = await app.request(`/api/workspaces/${workspaceId}/comments/${randomUUID()}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH returns 404 for missing comment", async () => {
    const res = await app.request(`/api/workspaces/${workspaceId}/comments/${randomUUID()}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE removes a comment", async () => {
    const createRes = await app.request(`/api/workspaces/${workspaceId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: "b.ts", body: "To delete" }),
    });
    const { id } = await createRes.json();

    const res = await app.request(`/api/workspaces/${workspaceId}/comments/${id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);

    // Verify gone
    const comments = await (await app.request(`/api/workspaces/${workspaceId}/comments`)).json();
    expect(comments.find((c: { id: string }) => c.id === id)).toBeUndefined();
  });

  it("DELETE returns 404 for missing comment", async () => {
    const res = await app.request(`/api/workspaces/${workspaceId}/comments/${randomUUID()}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("POST creates an unresolved comment by default", async () => {
    const res = await app.request(`/api/workspaces/${workspaceId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: "resolve.ts", body: "default state" }),
    });
    const body = await res.json() as any;
    expect(body.resolvedAt).toBeNull();
  });

  it("PATCH resolve marks a comment resolved, then reopens it", async () => {
    const createRes = await app.request(`/api/workspaces/${workspaceId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: "resolve.ts", body: "Please fix" }),
    });
    const { id } = await createRes.json();

    // Resolve
    const resolveRes = await app.request(`/api/workspaces/${workspaceId}/comments/${id}/resolve`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolved: true }),
    });
    expect(resolveRes.status).toBe(200);
    const resolved = await resolveRes.json() as any;
    expect(resolved.id).toBe(id);
    expect(resolved.resolvedAt).not.toBeNull();
    expect(typeof resolved.resolvedAt).toBe("string");

    // Verify persisted via GET
    const listed = await (await app.request(`/api/workspaces/${workspaceId}/comments`)).json();
    expect(listed.find((c: { id: string }) => c.id === id).resolvedAt).not.toBeNull();

    // Reopen
    const reopenRes = await app.request(`/api/workspaces/${workspaceId}/comments/${id}/resolve`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolved: false }),
    });
    expect(reopenRes.status).toBe(200);
    const reopened = await reopenRes.json() as any;
    expect(reopened.resolvedAt).toBeNull();
  });

  it("PATCH resolve requires a boolean resolved field", async () => {
    const createRes = await app.request(`/api/workspaces/${workspaceId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: "resolve.ts", body: "missing flag" }),
    });
    const { id } = await createRes.json();

    const res = await app.request(`/api/workspaces/${workspaceId}/comments/${id}/resolve`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH resolve returns 404 for missing comment", async () => {
    const res = await app.request(`/api/workspaces/${workspaceId}/comments/${randomUUID()}/resolve`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolved: true }),
    });
    expect(res.status).toBe(404);
  });

  it("GET lists carry the resolvedAt field for each comment", async () => {
    const createRes = await app.request(`/api/workspaces/${workspaceId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: "list-state.ts", body: "has resolvedAt" }),
    });
    const { id } = await createRes.json();

    const listed = await (await app.request(`/api/workspaces/${workspaceId}/comments`)).json();
    const found = listed.find((c: { id: string }) => c.id === id);
    expect(found).toBeDefined();
    expect(found).toHaveProperty("resolvedAt");
    expect(found.resolvedAt).toBeNull();
  });
});

