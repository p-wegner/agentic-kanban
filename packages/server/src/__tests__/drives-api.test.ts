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

  it("reports per-drive review effectiveness (reviews run, bounced, merged-without-review)", async () => {
    // A drive with a meta-issue + one child that gets built, reviewed, bounced, merged.
    const now = new Date().toISOString();
    const meta = randomUUID();
    const child = randomUUID();
    const statusId = randomUUID();
    await db.insert(schema.projectStatuses).values({
      id: statusId, projectId, name: "In Progress", sortOrder: 1, isDefault: true,
    });

    for (const [id, num, title] of [[meta, 100, "Epic"], [child, 101, "Child"]] as const) {
      await db.insert(schema.issues).values({
        id, issueNumber: num, title, statusId, projectId, createdAt: now, updatedAt: now,
      });
    }
    await db.insert(schema.issueDependencies).values({
      id: randomUUID(), issueId: meta, dependsOnId: child, type: "parent_of", createdAt: now,
    });

    // Create the drive first so we can seed sessions strictly inside its window
    // (the window opens at drive.startedAt; sessions before that are excluded).
    const drive = await (await app.request(`/api/projects/${projectId}/drives`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "Drive epic", metaIssueId: meta }),
    })).json() as any;

    const buildAt = new Date(new Date(drive.startedAt).getTime() + 1_000).toISOString();
    const reviewAt = new Date(new Date(drive.startedAt).getTime() + 2_000).toISOString();

    const ws = randomUUID();
    await db.insert(schema.workspaces).values({
      id: ws, issueId: child, branch: "feature/child", status: "merged",
      provider: "claude", readyForMerge: true, mergedAt: reviewAt, scorecardScore: 77, createdAt: now, updatedAt: now,
    });
    await db.insert(schema.sessions).values([
      { id: randomUUID(), workspaceId: ws, executor: "claude-code", status: "stopped", startedAt: buildAt, endedAt: buildAt, triggerType: "agent" },
      { id: randomUUID(), workspaceId: ws, executor: "claude-code", status: "stopped", startedAt: reviewAt, endedAt: reviewAt, triggerType: "review" },
    ]);

    const res = await app.request(`/api/projects/${projectId}/drives/${drive.id}/review-effectiveness`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.drive.id).toBe(drive.id);
    expect(body.drive.scope).toBe("meta-issue-subtree");
    expect(body.totals.reviewRuns).toBe(1);
    expect(body.reviewCoverage.attemptsReviewed).toBe(1);
  });

  it("returns 404 review-effectiveness for an unknown drive", async () => {
    const res = await app.request(`/api/projects/${projectId}/drives/${randomUUID()}/review-effectiveness`);
    expect(res.status).toBe(404);
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
