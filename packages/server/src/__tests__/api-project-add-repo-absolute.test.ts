// #68 — POST /api/projects/:id/repos must reject a non-absolute `path` with a clear 400 rather
// than resolving it against the SERVER's CWD (packages/server) and yielding a misleading
// "not a git repository: <server-dir>/<fragment>" error for a path the caller never supplied.
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createProjectsRoute } from "../routes/projects.js";

type Db = ReturnType<typeof createTestDb>["db"];

let db: Db;
let projectId: string;

beforeEach(async () => {
  db = createTestDb().db;
  const now = new Date().toISOString();
  projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name: "Add Repo Absolute Test",
    repoPath: "/tmp/add-repo-absolute-leading",
    repoName: "add-repo-absolute-leading",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
});

function createApp() {
  const app = new Hono();
  app.route("/api/projects", createProjectsRoute(db));
  return app;
}

async function postRepo(app: Hono, body: unknown) {
  return app.request(`/api/projects/${projectId}/repos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /:id/repos absolute-path guard (#68)", () => {
  it("rejects a relative path with 400 and a clear message (never resolves against server CWD)", async () => {
    const app = createApp();
    const res = await postRepo(app, { path: "projects/andrena/toy-fullstack/frontend" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("repo path must be an absolute path");
    // Must NOT have leaked into detectRepoInfo (which would produce a "not a git repository" error
    // pointing at the server's own directory).
    expect(body.error).not.toContain("git repository");
  });

  it("rejects a bare relative fragment with the same clear 400", async () => {
    const app = createApp();
    const res = await postRepo(app, { path: "../frontend" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("repo path must be an absolute path");
  });

  it("still enforces the exactly-one-of guard before the absolute check", async () => {
    const app = createApp();
    const res = await postRepo(app, {});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Provide exactly one of path or cloneUrl");
  });
});
