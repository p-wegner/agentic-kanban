/**
 * #400: conditional GET (ETag/304) on the two list endpoints the client polls
 * frequently — GET /api/projects and GET /api/workspaces. A repeated unchanged
 * GET with If-None-Match answers 304 with no body; any data change produces a
 * different ETag and a full 200 again.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { projects, projectStatuses, issues, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createProjectsRoute } from "../routes/projects.js";
import { createWorkspacesRoute } from "../routes/workspaces.js";
import { conditionalJsonResponse, computeBodyEtag } from "../services/board-etag-cache.service.js";

let db: TestDb;
let projectId: string;
let workspaceId: string;

beforeEach(async () => {
  ({ db } = createTestDb());
  const now = new Date().toISOString();
  projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "Etag List Test", repoPath: "/tmp/etag-list-test", repoName: "etag-list-test",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });

  const statusId = randomUUID();
  const issueId = randomUUID();
  workspaceId = randomUUID();
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: 1, title: "T", priority: "medium", sortOrder: 0,
    statusId, projectId, issueType: "feature", createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-1", workingDir: "/tmp/etag-list-test/.worktrees/ak-1",
    baseBranch: "main", isDirect: false, status: "idle", createdAt: now, updatedAt: now,
  });
});

function projectsApp() {
  const app = new Hono();
  app.route("/api/projects", createProjectsRoute(db));
  return app;
}

function workspacesApp() {
  const app = new Hono();
  app.route("/api/workspaces", createWorkspacesRoute(db));
  return app;
}

async function get(app: Hono, path: string, etag?: string) {
  const res = await app.request(path, {
    headers: etag ? { "If-None-Match": etag } : undefined,
  });
  return { status: res.status, etag: res.headers.get("ETag"), body: await res.text() };
}

describe("GET /api/projects conditional GET (#400)", () => {
  it("serves an ETag and answers a repeated unchanged GET with a bodyless 304", async () => {
    const app = projectsApp();

    const first = await get(app, "/api/projects");
    expect(first.status).toBe(200);
    expect(first.etag).toBeTruthy();
    expect(JSON.parse(first.body)).toHaveLength(1);

    const second = await get(app, "/api/projects", first.etag!);
    expect(second.status).toBe(304);
    expect(second.etag).toBe(first.etag);
    expect(second.body).toBe("");
  });

  it("a data change (project renamed) changes the ETag and returns a full 200", async () => {
    const app = projectsApp();
    const first = await get(app, "/api/projects");

    await db.update(projects).set({ name: "Renamed" }).where(eq(projects.id, projectId));

    const after = await get(app, "/api/projects", first.etag!);
    expect(after.status).toBe(200);
    expect(after.etag).toBeTruthy();
    expect(after.etag).not.toBe(first.etag);
    expect(JSON.parse(after.body)[0].name).toBe("Renamed");

    // The new ETag then 304s again.
    const again = await get(app, "/api/projects", after.etag!);
    expect(again.status).toBe(304);
  });

  it("a stale/foreign If-None-Match gets a full 200 with the current ETag", async () => {
    const app = projectsApp();
    const res = await get(app, "/api/projects", '"deadbeefdeadbeef"');
    expect(res.status).toBe(200);
    expect(res.etag).toBeTruthy();
  });
});

describe("GET /api/workspaces conditional GET (#400)", () => {
  it("serves an ETag and answers a repeated unchanged GET with a bodyless 304", async () => {
    const app = workspacesApp();
    const path = `/api/workspaces?projectId=${projectId}`;

    const first = await get(app, path);
    expect(first.status).toBe(200);
    expect(first.etag).toBeTruthy();
    expect(JSON.parse(first.body)).toHaveLength(1);

    const second = await get(app, path, first.etag!);
    expect(second.status).toBe(304);
    expect(second.etag).toBe(first.etag);
    expect(second.body).toBe("");
  });

  it("a data change (workspace status) changes the ETag and returns a full 200", async () => {
    const app = workspacesApp();
    const path = `/api/workspaces?projectId=${projectId}`;
    const first = await get(app, path);

    await db.update(workspaces).set({ status: "active" }).where(eq(workspaces.id, workspaceId));

    const after = await get(app, path, first.etag!);
    expect(after.status).toBe(200);
    expect(after.etag).not.toBe(first.etag);
    expect(JSON.parse(after.body)[0].status).toBe("active");
  });

  it("different query shapes hash independently", async () => {
    const app = workspacesApp();
    const all = await get(app, `/api/workspaces?projectId=${projectId}`);
    const filtered = await get(app, `/api/workspaces?projectId=${projectId}&status=closed`);
    expect(filtered.status).toBe(200);
    // The filtered list is empty, so its ETag differs from the full list's.
    expect(filtered.etag).not.toBe(all.etag);
    // Cross-shape conditional GET must not 304.
    const cross = await get(app, `/api/workspaces?projectId=${projectId}&status=closed`, all.etag!);
    expect(cross.status).toBe(200);
  });

  it("the missing-parameter 400 is unaffected", async () => {
    const app = workspacesApp();
    const res = await app.request("/api/workspaces");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/projects/:id/graph conditional GET (G15)", () => {
  it("serves an ETag, answers a repeated unchanged GET with a bodyless 304, and ships no issue descriptions", async () => {
    const app = projectsApp();
    const path = `/api/projects/${projectId}/graph`;

    const first = await get(app, path);
    expect(first.status).toBe(200);
    expect(first.etag).toBeTruthy();
    const payload = JSON.parse(first.body) as { nodes: Record<string, unknown>[] };
    expect(payload.nodes).toHaveLength(1);
    // G15a payload diet: the graph select must not ship description bodies.
    for (const node of payload.nodes) {
      expect(node).not.toHaveProperty("description");
    }

    const second = await get(app, path, first.etag!);
    expect(second.status).toBe(304);
    expect(second.etag).toBe(first.etag);
    expect(second.body).toBe("");
  });

  it("a data change (issue retitled) changes the ETag and returns a full 200", async () => {
    const app = projectsApp();
    const path = `/api/projects/${projectId}/graph`;
    const first = await get(app, path);

    await db.update(issues).set({ title: "Renamed" }).where(eq(issues.projectId, projectId));

    const after = await get(app, path, first.etag!);
    expect(after.status).toBe(200);
    expect(after.etag).not.toBe(first.etag);
    expect((JSON.parse(after.body) as { nodes: { title: string }[] }).nodes[0].title).toBe("Renamed");
  });
});

/**
 * #426 — a header set on a handler-returned raw `Response` is silently dropped by Hono.
 *
 * Measured while adding `X-Total-Count` to `GET /api/issues` (#424): the body and the ETag, both
 * passed through the constructor's `init`, arrived fine; the header set on the object afterwards
 * never reached the wire. Three spellings failed identically and silently — `res.headers.set`,
 * `c.header(...)`, and assigning `c.res` then mutating it — with no error and a green suite unless
 * someone asserts the header. Verified against the backend directly (port 13001), so it is neither
 * the dev proxy nor the gzip middleware.
 *
 * The fix is not a workaround at one call site but a parameter that puts extra headers where they
 * survive, so the NEXT route with a custom header gets it right by default.
 */
describe("conditionalJsonResponse extra headers (#426)", () => {
  it("attaches an extra header to the 200", async () => {
    const res = conditionalJsonResponse('{"a":1}', undefined, { "X-Total-Count": "42" });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("42");
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("attaches it to the 304 as well — an intermittent header is worse than an absent one", async () => {
    const body = '{"a":1}';
    const etag = conditionalJsonResponse(body, undefined).headers.get("ETag")!;
    const notModified = conditionalJsonResponse(body, etag, { "X-Total-Count": "42" });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("X-Total-Count")).toBe("42");
  });

  it("still works with no extra headers at all", async () => {
    const res = conditionalJsonResponse('{"a":1}', undefined);
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBeTruthy();
  });

  it("does not let an extra header overwrite the ETag the caller depends on", async () => {
    // Spreading extraHeaders last means a caller COULD clobber ETag; assert the contract we want
    // so a future reorder is a red test rather than a broken conditional GET.
    const res = conditionalJsonResponse('{"a":1}', undefined, { "X-Total-Count": "1" });
    expect(res.headers.get("ETag")).toBe(computeBodyEtag('{"a":1}'));
  });
});
