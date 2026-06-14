import { describe, it, expect, beforeAll } from "vitest";
import { createRoutes } from "../routes/index.js";
import * as schema from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import type { TestDb } from "./helpers/test-db.js";

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api", createRoutes(db, () => createMockSessionManager()));
  });
}

async function seedProject(database: TestDb) {
  const now = new Date().toISOString();
  const id = randomUUID();
  await database.insert(schema.projects).values({
    id, name: "Drive Project", repoPath: "/tmp/drive-repo", repoName: "drive-repo",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  return id;
}

describe("Drives API", () => {
  const { app, db } = createTestApp();
  let projectId: string;

  beforeAll(async () => {
    projectId = await seedProject(db);
  });

  it("starting a drive creates a Drive record, queryable via API, that survives a restart", async () => {
    // Start (POST) — acceptance: creates a Drive record
    const startRes = await app.request(`/api/projects/${projectId}/drives`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: "Drive the epic to master",
        completionContract: "All children Done AND master contains the work",
      }),
    });
    expect(startRes.status).toBe(201);
    const created = await startRes.json() as any;
    expect(created.id).toBeTruthy();
    expect(created.status).toBe("active");
    expect(created.target).toBe("Drive the epic to master");
    expect(created.finishedAt).toBeNull();

    // Queryable via API (list)
    const listRes = await app.request(`/api/projects/${projectId}/drives`);
    expect(listRes.status).toBe(200);
    const list = await listRes.json() as any[];
    expect(list.some((d) => d.id === created.id)).toBe(true);

    // Queryable via API (get one)
    const getRes = await app.request(`/api/projects/${projectId}/drives/${created.id}`);
    expect(getRes.status).toBe(200);
    expect((await getRes.json() as any).target).toBe("Drive the epic to master");

    // Survives a server restart: the row is persisted in the DB, not in memory.
    // A fresh route tree over the SAME db reads it back identically.
    const { app: app2 } = _createTestApp((a, _db) => {
      a.route("/api", createRoutes(db, () => createMockSessionManager()));
    });
    const afterRes = await app2.request(`/api/projects/${projectId}/drives/${created.id}`);
    expect(afterRes.status).toBe(200);
    expect((await afterRes.json() as any).status).toBe("active");

    const rows = await db.select().from(schema.drives).where(eq(schema.drives.id, created.id));
    expect(rows).toHaveLength(1);
  });

  it("rejects a drive without a target", async () => {
    const res = await app.request(`/api/projects/${projectId}/drives`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "  " }),
    });
    expect(res.status).toBe(400);
  });

  it("finishing a drive sets a terminal status and stamps finishedAt", async () => {
    const created = await (await app.request(`/api/projects/${projectId}/drives`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "Finish me" }),
    })).json() as any;

    const finishRes = await app.request(`/api/projects/${projectId}/drives/${created.id}/finish`, {
      method: "POST",
    });
    expect(finishRes.status).toBe(200);
    const finished = await finishRes.json() as any;
    expect(finished.status).toBe("completed");
    expect(finished.finishedAt).toBeTruthy();
  });

  it("updating status to a terminal value stamps finishedAt", async () => {
    const created = await (await app.request(`/api/projects/${projectId}/drives`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "Abandon me" }),
    })).json() as any;

    const putRes = await app.request(`/api/projects/${projectId}/drives/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "abandoned" }),
    });
    expect(putRes.status).toBe(200);
    const updated = await putRes.json() as any;
    expect(updated.status).toBe("abandoned");
    expect(updated.finishedAt).toBeTruthy();
  });

  it("rejects an invalid status", async () => {
    const created = await (await app.request(`/api/projects/${projectId}/drives`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "Bad status" }),
    })).json() as any;

    const res = await app.request(`/api/projects/${projectId}/drives/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "bogus" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for a drive in another project", async () => {
    const created = await (await app.request(`/api/projects/${projectId}/drives`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "Scoped" }),
    })).json() as any;

    const otherProjectId = await seedProject(db);
    const res = await app.request(`/api/projects/${otherProjectId}/drives/${created.id}`);
    expect(res.status).toBe(403);
  });

  it("deletes a drive", async () => {
    const created = await (await app.request(`/api/projects/${projectId}/drives`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "Delete me" }),
    })).json() as any;

    const delRes = await app.request(`/api/projects/${projectId}/drives/${created.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);

    const getRes = await app.request(`/api/projects/${projectId}/drives/${created.id}`);
    expect(getRes.status).toBe(404);
  });
});
