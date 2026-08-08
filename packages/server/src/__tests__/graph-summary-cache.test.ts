/**
 * #345: GET /api/projects/:id/graph called buildWorkspaceSummaryMap DIRECTLY, unlike
 * getBoard, so EVERY graph request paid a full cold workspace-summary rebuild —
 * per-workspace git spawns plus synchronous multi-MB .out transcript reads. Measured at
 * 13.2s direct against the backend, during which /api/health (pure JS, no DB) stalled
 * 3.6-30s and the dev proxy returned 503 for 5 of 8 attempts.
 *
 * These tests pin that the graph now shares the board's cached SWR path, AND that doing
 * so did not silently drop workspace summaries for issues the board's cache omits — the
 * graph's issue set is a superset of the board's ("Archived" column included).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createProjectService } from "../services/project.service.js";
import { createWorkspaceSummaryCache } from "../services/workspace-summary-cache.service.js";

let db: TestDb;
let projectId: string;
let inProgressStatusId: string;
let archivedStatusId: string;

beforeEach(async () => {
  db = createTestDb().db;

  const now = new Date().toISOString();
  projectId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    name: "Graph Cache Test",
    repoPath: "/tmp/graph-cache-test",
    repoName: "graph-cache-test",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  inProgressStatusId = randomUUID();
  archivedStatusId = randomUUID();
  await db.insert(schema.projectStatuses).values([
    { id: inProgressStatusId, projectId, name: "In Progress", sortOrder: 1, isDefault: true, createdAt: now },
    { id: archivedStatusId, projectId, name: "Archived", sortOrder: 9, isDefault: false, createdAt: now },
  ]);
});

async function seedIssue(statusId: string, issueNumber: number, withWorkspace: boolean) {
  const now = new Date().toISOString();
  const issueId = randomUUID();
  await db.insert(schema.issues).values({
    id: issueId,
    issueNumber,
    title: `Issue ${issueNumber}`,
    statusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  if (withWorkspace) {
    await db.insert(schema.workspaces).values({
      id: randomUUID(),
      issueId,
      branch: `feature/ak-${issueNumber}`,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  }
  return issueId;
}

describe("getGraph workspace summaries (#345)", () => {
  it("reuses the cache a prior getBoard warmed instead of rebuilding", async () => {
    const workspaceSummaryCache = createWorkspaceSummaryCache();
    const projectService = createProjectService({ database: db, workspaceSummaryCache });
    const issueId = await seedIssue(inProgressStatusId, 1, true);

    // A board request warms the shared cache.
    await projectService.getBoard(projectId, new Date().toISOString());
    const warmed = workspaceSummaryCache.get(projectId);
    expect(warmed?.stale).toBe(false);

    const graph = await projectService.getGraph(projectId);

    // Served from the warmed entry — same object identity as the cached map's value,
    // which an independent rebuild could not produce.
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].id).toBe(issueId);
    expect(graph.nodes[0].workspaceSummary).toBe(warmed!.value.get(issueId));
  });

  it("warms the cache itself on a cold miss, so a following board request does not rebuild", async () => {
    const workspaceSummaryCache = createWorkspaceSummaryCache();
    const projectService = createProjectService({ database: db, workspaceSummaryCache });
    await seedIssue(inProgressStatusId, 1, true);

    expect(workspaceSummaryCache.get(projectId)).toBeNull();

    await projectService.getGraph(projectId);

    const afterGraph = workspaceSummaryCache.get(projectId);
    expect(afterGraph).not.toBeNull();
    expect(afterGraph!.stale).toBe(false);
  });

  it("still returns a workspace summary for an Archived-column issue the board's cache omits", async () => {
    // The regression guard for sharing the board's cache: getBoardIssues excludes the
    // "Archived" column, getGraphIssues does not, so a board-warmed map has no entry for
    // this issue and a naive cache reuse would drop its summary.
    const workspaceSummaryCache = createWorkspaceSummaryCache();
    const projectService = createProjectService({ database: db, workspaceSummaryCache });
    const activeId = await seedIssue(inProgressStatusId, 1, true);
    const archivedId = await seedIssue(archivedStatusId, 2, true);

    await projectService.getBoard(projectId, new Date().toISOString());
    const warmed = workspaceSummaryCache.get(projectId);
    // Precondition: the board's cached map really does omit the archived issue.
    expect(warmed!.value.has(activeId)).toBe(true);
    expect(warmed!.value.has(archivedId)).toBe(false);

    const graph = await projectService.getGraph(projectId);

    expect(graph.nodes.map((n) => n.id).sort()).toEqual([activeId, archivedId].sort());
    for (const node of graph.nodes) {
      expect(node.workspaceSummary, `summary missing for ${node.id}`).toBeDefined();
      expect(node.workspaceSummary!.total).toBe(1);
    }
  });
});
