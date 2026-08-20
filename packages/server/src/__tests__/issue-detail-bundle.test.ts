import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as schema from "@agentic-kanban/shared/schema";
import { createRoutes } from "../routes/index.js";
import { createTestApp as createHarness } from "./helpers/test-app.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import type { TestDb } from "./helpers/test-db.js";

function createTestApp() {
  return createHarness((app, db) => {
    app.route("/api", createRoutes(db, () => createMockSessionManager()));
  });
}

async function seedProject(db: TestDb, name = "bundle-project") {
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name,
    repoPath: `/tmp/${name}`,
    repoName: name,
    defaultBranch: "main",
  });
  return projectId;
}

async function seedIssue(db: TestDb, projectId: string, description: string | null) {
  const statusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: statusId,
    projectId,
    name: "Backlog",
    sortOrder: 0,
  }).onConflictDoNothing();

  const issueId = randomUUID();
  await db.insert(schema.issues).values({
    id: issueId,
    title: "Bundle issue",
    description,
    statusId,
    projectId,
    issueNumber: 1,
  });
  return issueId;
}

describe("GET /api/issues/:id/detail-bundle", () => {
  it("returns 404 for an unknown issue", async () => {
    const { app } = createTestApp();
    const res = await app.request(`/api/issues/${randomUUID()}/detail-bundle`);
    expect(res.status).toBe(404);
  });

  it("returns the issue (with description) plus all per-issue sections in one response", async () => {
    const { app, db } = createTestApp();
    const projectId = await seedProject(db);
    const description = "A full description that the board payload strips";
    const issueId = await seedIssue(db, projectId, description);
    const workspaceId = randomUUID();
    await db.insert(schema.workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/bundle",
      status: "idle",
    });

    const res = await app.request(`/api/issues/${issueId}/detail-bundle`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    // The bundle re-supplies the lazy-loaded description.
    expect(body.issue.id).toBe(issueId);
    expect(body.issue.description).toBe(description);

    // Every per-issue section the panel needs is present with a sane shape.
    expect(Array.isArray(body.workspaces)).toBe(true);
    expect(body.workspaces.map((w: any) => w.id)).toContain(workspaceId);
    expect(Array.isArray(body.tags)).toBe(true);
    expect(body.dependencies).toBeTruthy();
    expect(Array.isArray(body.dependencies.dependencies)).toBe(true);
    expect(Array.isArray(body.artifacts)).toBe(true);
    expect(Array.isArray(body.comments)).toBe(true);
    expect(Array.isArray(body.activity.events)).toBe(true);
  });

  it("folds cycle-time, time-entries, touched-files, related-issues and merged-commits into the bundle, identical to the individual endpoints (#418)", async () => {
    const { app, db } = createTestApp();
    const projectId = await seedProject(db);
    const issueId = await seedIssue(db, projectId, "desc");

    // Touched files on this issue + a second issue sharing a path (drives related-issues).
    const { eq } = await import("drizzle-orm");
    await db.update(schema.issues)
      .set({ touchedFilesJson: JSON.stringify([{ path: "src/a.ts", reason: "r", confidence: "high" }]) })
      .where(eq(schema.issues.id, issueId));
    const otherIssueId = randomUUID();
    const statusId = (await db.select({ id: schema.projectStatuses.id }).from(schema.projectStatuses))[0].id;
    await db.insert(schema.issues).values({
      id: otherIssueId,
      title: "Overlapping issue",
      statusId,
      projectId,
      issueNumber: 2,
      touchedFilesJson: JSON.stringify([{ path: "src/a.ts", reason: "also", confidence: "low" }]),
    });

    // A time entry.
    await db.insert(schema.issueTimeEntries).values({
      id: randomUUID(),
      issueId,
      minutes: 25,
      note: "spike",
      createdAt: new Date().toISOString(),
    });

    const [bundleRes, cycleRes, timeRes, touchedRes, relatedRes, mergedRes] = await Promise.all([
      app.request(`/api/issues/${issueId}/detail-bundle`),
      app.request(`/api/issues/${issueId}/cycle-time`),
      app.request(`/api/issues/${issueId}/time-entries`),
      app.request(`/api/issues/${issueId}/touched-files`),
      app.request(`/api/issues/${issueId}/related-issues`),
      app.request(`/api/issues/${issueId}/merged-commits`),
    ]);
    expect(bundleRes.status).toBe(200);
    const bundle = await bundleRes.json() as any;

    // Each folded field is identical to what the standalone endpoint serves.
    // (cycle-time's totalAgeMs is clock-derived, so compare the stable fields.)
    const cycleFromEndpoint = await cycleRes.json() as any;
    expect(bundle.cycleTime.createdAt).toBe(cycleFromEndpoint.createdAt);
    expect(bundle.cycleTime.closedAt).toBe(cycleFromEndpoint.closedAt);
    expect(bundle.cycleTime.isOpen).toBe(cycleFromEndpoint.isOpen);
    expect(bundle.cycleTime.statusBreakdowns).toEqual(cycleFromEndpoint.statusBreakdowns);
    expect(typeof bundle.cycleTime.totalAgeMs).toBe("number");
    expect(bundle.timeEntries).toEqual(await timeRes.json());
    expect(bundle.touchedFiles).toEqual(await touchedRes.json());
    expect(bundle.relatedIssues).toEqual(await relatedRes.json());
    expect(bundle.mergedCommits).toEqual(await mergedRes.json());

    // Sanity: the folded data is real, not five empty objects.
    expect(bundle.timeEntries.totalMinutes).toBe(25);
    expect(bundle.touchedFiles.files).toEqual([{ path: "src/a.ts", reason: "r", confidence: "high" }]);
    expect(bundle.relatedIssues.related).toEqual([
      { id: otherIssueId, issueNumber: 2, title: "Overlapping issue", sharedFileCount: 1 },
    ]);
    expect(bundle.mergedCommits).toEqual({ merged: false, defaultBranch: "main", commits: [] });
    expect(bundle.cycleTime).toBeTruthy();
  });

  it("handles a null description without failing the bundle", async () => {
    const { app, db } = createTestApp();
    const projectId = await seedProject(db);
    const issueId = await seedIssue(db, projectId, null);

    const res = await app.request(`/api/issues/${issueId}/detail-bundle`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.issue.id).toBe(issueId);
    expect(body.issue.description).toBeNull();
    expect(body.workspaces).toEqual([]);
  });
});
