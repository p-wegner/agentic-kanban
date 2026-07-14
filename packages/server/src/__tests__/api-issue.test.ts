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

describe("Issues API", () => {
  const { app, db: database } = createTestApp();
  let projectId: string;
  let statusId: string;

  beforeAll(async () => {
    projectId = await createProjectDirectly(database, { name: "Issue Test Project" });
    statusId = await createStatusDirectly(database, projectId, "Todo", 0);
  });

  it("POST /api/issues creates an issue", async () => {
    const res = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test issue",
        priority: "high",
        statusId,
        projectId,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.title).toBe("Test issue");
  });

  it("GET /api/issues returns issues with statusName", async () => {
    const res = await app.request(`/api/issues?projectId=${projectId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.length).toBe(1);
    expect(body[0].statusName).toBe("Todo");
  });

  it("GET /api/issues requires projectId", async () => {
    const res = await app.request("/api/issues");
    expect(res.status).toBe(400);
  });

  it("GET /api/issues?statusName= filters to matching issues and leaves unfiltered path unchanged", async () => {
    const p = await createProjectDirectly(database, { name: "StatusFilter Project" });
    const todoId = await createStatusDirectly(database, p, "Todo", 0);
    const inProgressId = await createStatusDirectly(database, p, "In Progress", 1);

    // Create one issue in each status
    await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Todo issue", statusId: todoId, projectId: p }),
    });
    await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "In Progress issue", statusId: inProgressId, projectId: p }),
    });

    // Filtered: only "In Progress"
    const filtered = await app.request(`/api/issues?projectId=${p}&statusName=In%20Progress`);
    expect(filtered.status).toBe(200);
    const filteredBody = await filtered.json() as any[];
    expect(filteredBody.length).toBe(1);
    expect(filteredBody[0].statusName).toBe("In Progress");
    expect(filteredBody[0].title).toBe("In Progress issue");

    // Unfiltered: both issues returned
    const all = await app.request(`/api/issues?projectId=${p}`);
    expect(all.status).toBe(200);
    const allBody = await all.json() as any[];
    expect(allBody.length).toBe(2);

    // Non-matching status returns empty array
    const none = await app.request(`/api/issues?projectId=${p}&statusName=Done`);
    expect(none.status).toBe(200);
    const noneBody = await none.json() as any[];
    expect(noneBody.length).toBe(0);
  });

  it("PATCH /api/issues/:id updates an issue", async () => {
    // Create issue
    const createRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "To update", statusId, projectId }),
    });
    const { id } = await createRes.json();

    // Update it
    const res = await app.request(`/api/issues/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Updated title" }),
    });
    expect(res.status).toBe(200);

    // Verify
    const issues = await (
      await app.request(`/api/issues?projectId=${projectId}`)
    ).json();
    const updated = issues.find((i: { id: string }) => i.id === id);
    expect(updated.title).toBe("Updated title");
  });

  it("DELETE /api/issues/:id deletes an issue", async () => {
    const createRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "To delete", statusId, projectId }),
    });
    const { id } = await createRes.json();

    const res = await app.request(`/api/issues/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.success).toBe(true);
  });

  it("DELETE /api/issues/:id removes incoming dependencies", async () => {
    const targetRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Dependency target", statusId, projectId }),
    });
    const sourceRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Dependency source", statusId, projectId }),
    });
    const target = await targetRes.json() as any;
    const source = await sourceRes.json() as any;

    await database.insert(schema.issueDependencies).values({
      id: randomUUID(),
      issueId: source.id,
      dependsOnId: target.id,
      type: "depends_on",
      createdAt: new Date().toISOString(),
    });

    const res = await app.request(`/api/issues/${target.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const dependencyRows = await database
      .select()
      .from(schema.issueDependencies)
      .where(eq(schema.issueDependencies.dependsOnId, target.id));
    expect(dependencyRows).toHaveLength(0);
  });

  it("DELETE /api/issues/:id removes issue rows that also reference workspaces", async () => {
    const createRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Issue with attachments", statusId, projectId }),
    });
    const issue = await createRes.json() as any;
    const now = new Date().toISOString();
    const showdownId = randomUUID();
    const workspaceId = randomUUID();

    await database.insert(schema.showdowns).values({
      id: showdownId,
      issueId: issue.id,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(schema.workspaces).values({
      id: workspaceId,
      issueId: issue.id,
      branch: "feature/delete-attachments",
      showdownId,
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(schema.issueArtifacts).values({
      id: randomUUID(),
      issueId: issue.id,
      workspaceId,
      type: "text",
      content: "proof",
      createdAt: now,
    });
    await database.insert(schema.issueComments).values({
      id: randomUUID(),
      issueId: issue.id,
      workspaceId,
      kind: "note",
      author: "user",
      body: "delete me",
      createdAt: now,
    });

    const res = await app.request(`/api/issues/${issue.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const issueRows = await database.select().from(schema.issues).where(eq(schema.issues.id, issue.id));
    const workspaceRows = await database.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    const artifactRows = await database.select().from(schema.issueArtifacts).where(eq(schema.issueArtifacts.issueId, issue.id));
    const commentRows = await database.select().from(schema.issueComments).where(eq(schema.issueComments.issueId, issue.id));
    const showdownRows = await database.select().from(schema.showdowns).where(eq(schema.showdowns.id, showdownId));
    expect(issueRows).toHaveLength(0);
    expect(workspaceRows).toHaveLength(0);
    expect(artifactRows).toHaveLength(0);
    expect(commentRows).toHaveLength(0);
    expect(showdownRows).toHaveLength(0);
  });

  it("GET /api/issues/:id/workspaces carries serviceState parsed like the details DTO", async () => {
    const createRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Service state issue", statusId, projectId }),
    });
    const issue = await createRes.json() as any;
    const now = new Date().toISOString();

    const upState = {
      composeProjectName: "ak-1f3a9c2b-ws-b3d9f01a2c4e",
      ports: { db: 54187 },
      envFilePath: "C:/wt/x/.kanban/services.env",
      status: "up",
      updatedAt: now,
    };
    const withStackId = randomUUID();
    const noStackId = randomUUID();
    const corruptId = randomUUID();
    for (const [id, serviceState] of [
      [withStackId, JSON.stringify(upState)],
      [noStackId, null],
      // Corrupt / shape-less JSON must degrade to null, not crash the list.
      [corruptId, "{not json"],
    ] as const) {
      await database.insert(schema.workspaces).values({
        id,
        issueId: issue.id,
        branch: `feature/svc-${id.slice(0, 8)}`,
        serviceState,
        createdAt: now,
        updatedAt: now,
      });
    }

    const res = await app.request(`/api/issues/${issue.id}/workspaces`);
    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    const byId = new Map(body.map((w) => [w.id, w]));

    // The list row must carry the field (client hydration self-retires on this),
    // parsed to the same shape the details projection returns.
    const withStack = byId.get(withStackId);
    expect(withStack.serviceState).toMatchObject({
      composeProjectName: "ak-1f3a9c2b-ws-b3d9f01a2c4e",
      ports: { db: 54187 },
      status: "up",
    });
    // No stack and corrupt JSON both surface as an explicit null (not undefined).
    expect(byId.get(noStackId).serviceState).toBeNull();
    expect(byId.get(corruptId).serviceState).toBeNull();
    expect("serviceState" in byId.get(noStackId)).toBe(true);
  });

  it("GET /api/issues/:id/showdown returns 200 with null when no showdown exists", async () => {
    // The issue detail panel probes this on every open. "No showdown" is the
    // normal case, so it must NOT 404 (a 404 floods the browser console).
    const createRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "No showdown here", statusId, projectId }),
    });
    const issue = await createRes.json() as any;

    const res = await app.request(`/api/issues/${issue.id}/showdown`);
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it("POST /api/issues creates issue with estimate", async () => {
    const res = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Estimated issue", statusId, projectId, estimate: "M" }),
    });
    expect(res.status).toBe(201);
    const { id } = await res.json() as any;

    const list = await (await app.request(`/api/issues?projectId=${projectId}`)).json() as any[];
    const created = list.find((i: any) => i.id === id);
    expect(created.estimate).toBe("M");
  });

  it("POST /api/issues defaults estimate to null", async () => {
    const res = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "No estimate", statusId, projectId }),
    });
    const { id } = await res.json() as any;

    const list = await (await app.request(`/api/issues?projectId=${projectId}`)).json() as any[];
    const created = list.find((i: any) => i.id === id);
    expect(created.estimate).toBeNull();
  });

  it("PATCH /api/issues/:id sets estimate", async () => {
    const createRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Patch estimate", statusId, projectId }),
    });
    const { id } = await createRes.json() as any;

    const patchRes = await app.request(`/api/issues/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estimate: "XL" }),
    });
    expect(patchRes.status).toBe(200);

    const list = await (await app.request(`/api/issues?projectId=${projectId}`)).json() as any[];
    const updated = list.find((i: any) => i.id === id);
    expect(updated.estimate).toBe("XL");
  });

  it("PATCH /api/issues/:id clears estimate", async () => {
    const createRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Clear estimate", statusId, projectId, estimate: "S" }),
    });
    const { id } = await createRes.json() as any;

    await app.request(`/api/issues/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estimate: null }),
    });

    const list = await (await app.request(`/api/issues?projectId=${projectId}`)).json() as any[];
    const updated = list.find((i: any) => i.id === id);
    expect(updated.estimate).toBeNull();
  });

  it("GET /api/issues returns estimate field", async () => {
    const createRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "With estimate", statusId, projectId, estimate: "XS" }),
    });
    const { id } = await createRes.json() as any;

    const list = await (await app.request(`/api/issues?projectId=${projectId}`)).json() as any[];
    const issue = list.find((i: any) => i.id === id);
    expect(issue).toHaveProperty("estimate");
    expect(issue.estimate).toBe("XS");
  });

  it("POST /api/issues persists externalKey and externalUrl", async () => {
    const res = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Linked issue",
        statusId,
        projectId,
        externalKey: "PROJ-123",
        externalUrl: "https://tracker.example.com/browse/PROJ-123",
      }),
    });
    expect(res.status).toBe(201);
    const { id } = await res.json() as any;

    const list = await (await app.request(`/api/issues?projectId=${projectId}`)).json() as any[];
    const created = list.find((i: any) => i.id === id);
    expect(created.externalKey).toBe("PROJ-123");
    expect(created.externalUrl).toBe("https://tracker.example.com/browse/PROJ-123");
  });

  it("POST /api/issues defaults external fields to null", async () => {
    const res = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "No external link", statusId, projectId }),
    });
    const { id } = await res.json() as any;

    const list = await (await app.request(`/api/issues?projectId=${projectId}`)).json() as any[];
    const created = list.find((i: any) => i.id === id);
    expect(created.externalKey).toBeNull();
    expect(created.externalUrl).toBeNull();
  });

  it("POST /api/issues rejects a non-http externalUrl", async () => {
    const res = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Bad link",
        statusId,
        projectId,
        externalUrl: "javascript:alert(1)",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH /api/issues/:id sets and clears external fields", async () => {
    const createRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Patch external", statusId, projectId }),
    });
    const { id } = await createRes.json() as any;

    const patchRes = await app.request(`/api/issues/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalKey: "LIN-7", externalUrl: "http://linear.app/issue/LIN-7" }),
    });
    expect(patchRes.status).toBe(200);

    let list = await (await app.request(`/api/issues?projectId=${projectId}`)).json() as any[];
    let updated = list.find((i: any) => i.id === id);
    expect(updated.externalKey).toBe("LIN-7");
    expect(updated.externalUrl).toBe("http://linear.app/issue/LIN-7");

    const clearRes = await app.request(`/api/issues/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalKey: "", externalUrl: null }),
    });
    expect(clearRes.status).toBe(200);

    list = await (await app.request(`/api/issues?projectId=${projectId}`)).json() as any[];
    updated = list.find((i: any) => i.id === id);
    expect(updated.externalKey).toBeNull();
    expect(updated.externalUrl).toBeNull();
  });

  it("PATCH /api/issues/:id rejects a non-http externalUrl", async () => {
    const createRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Patch bad link", statusId, projectId }),
    });
    const { id } = await createRes.json() as any;

    const res = await app.request(`/api/issues/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalUrl: "ftp://example.com/file" }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH /api/issues/:id persists sortOrder for in-column reorder", async () => {
    const aRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Card A", statusId, projectId }),
    });
    const bRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Card B", statusId, projectId }),
    });
    const cRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Card C", statusId, projectId }),
    });
    const { id: aId } = await aRes.json() as any;
    const { id: bId } = await bRes.json() as any;
    const { id: cId } = await cRes.json() as any;

    // Assign explicit sortOrders so the ordering is deterministic
    for (const [id, order] of [[aId, 100], [bId, 200], [cId, 300]] as [string, number][]) {
      const r = await app.request(`/api/issues/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sortOrder: order }),
      });
      expect(r.status).toBe(200);
    }

    // Move C before B: new sortOrder midpoint = 150
    const reorderRes = await app.request(`/api/issues/${cId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sortOrder: 150 }),
    });
    expect(reorderRes.status).toBe(200);

    // Verify persisted sort order survives a fresh fetch
    const list = await (await app.request(`/api/issues?projectId=${projectId}`)).json() as any[];
    const c = list.find((i: any) => i.id === cId);
    expect(c.sortOrder).toBe(150);

    // Verify the board endpoint also reflects the new order (sortOrder ascending)
    const board = await (await app.request(`/api/projects/${projectId}/board`)).json() as any;
    const col = board.find((s: any) => s.id === statusId);
    const ids = col.issues.map((i: any) => i.id);
    // After reorder: A(100) < C(150) < B(200)
    expect(ids.indexOf(aId)).toBeLessThan(ids.indexOf(cId));
    expect(ids.indexOf(cId)).toBeLessThan(ids.indexOf(bId));
  });
});

describe("Issue by-number resolution (AK-572)", () => {
  const { app, db: database } = createTestApp();

  it("GET /api/issues?issueNumber=N returns only the matching issue for the given project", async () => {
    const now = new Date().toISOString();
    const projectA = await createProjectDirectly(database, { name: "AK-572 Project A" });
    const projectB = await createProjectDirectly(database, { name: "AK-572 Project B" });
    const statusA = await createStatusDirectly(database, projectA, "Todo", 0);
    const statusB = await createStatusDirectly(database, projectB, "Todo", 0);

    const issueAId = randomUUID();
    const issueBId = randomUUID();
    // Both projects have an issue with number 42 — the filter must be project-scoped
    await database.insert(schema.issues).values({
      id: issueAId, projectId: projectA, statusId: statusA, issueNumber: 42,
      title: "Issue 42 in project A", priority: "medium", issueType: "task", sortOrder: 0,
      createdAt: now, updatedAt: now,
    });
    await database.insert(schema.issues).values({
      id: issueBId, projectId: projectB, statusId: statusB, issueNumber: 42,
      title: "Issue 42 in project B", priority: "medium", issueType: "task", sortOrder: 0,
      createdAt: now, updatedAt: now,
    });

    const resA = await app.request(`/api/issues?projectId=${projectA}&issueNumber=42`);
    expect(resA.status).toBe(200);
    const bodyA = await resA.json() as any;
    expect(Array.isArray(bodyA)).toBe(true);
    expect(bodyA.length).toBe(1);
    expect(bodyA[0].id).toBe(issueAId);

    const resB = await app.request(`/api/issues?projectId=${projectB}&issueNumber=42`);
    expect(resB.status).toBe(200);
    const bodyB = await resB.json() as any;
    expect(Array.isArray(bodyB)).toBe(true);
    expect(bodyB.length).toBe(1);
    expect(bodyB[0].id).toBe(issueBId);
  });

  it("GET /api/issues?issueNumber=N returns empty array when no match", async () => {
    const p = await createProjectDirectly(database, { name: "AK-572 Empty Project" });
    const res = await app.request(`/api/issues?projectId=${p}&issueNumber=9999`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });
});

