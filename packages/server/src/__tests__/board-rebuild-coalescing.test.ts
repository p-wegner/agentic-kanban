/**
 * Tests for board workspace-summary rebuild coalescing + invalidation warm-ahead:
 *
 * 1. Two concurrent cold getBoard calls share ONE buildWorkspaceSummaryMap run
 *    (previously each ran its own rebuild — measured stacking 155/182/205ms).
 * 2. A rebuild whose project is invalidated mid-flight must NOT write its
 *    (potentially pre-mutation) result into the cache.
 * 3. scheduleBoardWarmup rebuilds the cache in the background after invalidation
 *    (debounced across bursts), so the client's follow-up refetch is a fresh hit.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceSummaryCache } from "../services/workspace-summary-cache.service.js";

const buildWorkspaceSummaryMapMock = vi.fn();

vi.mock("../services/board-aggregation.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/board-aggregation.service.js")>();
  return {
    ...actual,
    buildWorkspaceSummaryMap: (...args: unknown[]) => buildWorkspaceSummaryMapMock(...args),
  };
});

import { createProjectService } from "../services/project.service.js";

type Db = ReturnType<typeof createTestDb>["db"];

let db: Db;
let projectId: string;

beforeEach(async () => {
  buildWorkspaceSummaryMapMock.mockReset();
  buildWorkspaceSummaryMapMock.mockImplementation(async () => new Map());

  db = createTestDb().db;
  const now = new Date().toISOString();
  projectId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    name: "Coalescing Test",
    repoPath: "/tmp/coalescing-test",
    repoName: "coalescing-test",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  const statusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: statusId,
    projectId,
    name: "Backlog",
    sortOrder: 0,
    isDefault: true,
    createdAt: now,
  });

  await db.insert(schema.issues).values({
    id: randomUUID(),
    issueNumber: 1,
    title: "Some issue",
    statusId,
    projectId,
    skipAutoReview: true,
    createdAt: now,
    updatedAt: now,
  });
});

describe("cold board rebuild coalescing", () => {
  it("two concurrent cold getBoard calls share a single rebuild", async () => {
    const now = new Date().toISOString();
    const workspaceSummaryCache = createWorkspaceSummaryCache();
    const projectService = createProjectService({ database: db, workspaceSummaryCache });

    let resolveBuild!: (m: Map<string, unknown>) => void;
    buildWorkspaceSummaryMapMock.mockImplementation(
      () => new Promise<Map<string, unknown>>((res) => { resolveBuild = res; }),
    );

    const p1 = projectService.getBoard(projectId, now);
    const p2 = projectService.getBoard(projectId, now);

    // Let both requests reach the cold-miss branch while the build is held open.
    await new Promise((r) => setTimeout(r, 25));
    expect(buildWorkspaceSummaryMapMock).toHaveBeenCalledTimes(1);

    resolveBuild(new Map());
    const [b1, b2] = await Promise.all([p1, p2]);
    expect(b1.length).toBeGreaterThan(0);
    expect(b2.length).toBeGreaterThan(0);

    // The shared rebuild populated the cache — a follow-up request must not rebuild.
    buildWorkspaceSummaryMapMock.mockClear();
    await projectService.getBoard(projectId, now);
    expect(buildWorkspaceSummaryMapMock).not.toHaveBeenCalled();
  });

  it("discards a rebuild result when the project is invalidated mid-flight", async () => {
    const now = new Date().toISOString();
    const workspaceSummaryCache = createWorkspaceSummaryCache();
    const projectService = createProjectService({ database: db, workspaceSummaryCache });

    let resolveBuild!: (m: Map<string, unknown>) => void;
    buildWorkspaceSummaryMapMock.mockImplementation(
      () => new Promise<Map<string, unknown>>((res) => { resolveBuild = res; }),
    );

    const p1 = projectService.getBoard(projectId, now);
    await new Promise((r) => setTimeout(r, 25));
    expect(buildWorkspaceSummaryMapMock).toHaveBeenCalledTimes(1);

    // A mutation arrives while the rebuild is in flight.
    workspaceSummaryCache.invalidate(projectId);

    resolveBuild(new Map());
    await p1; // the request itself still completes

    // The stale result must not have been written back to the cache.
    expect(workspaceSummaryCache.get(projectId)).toBeNull();
  });

  it("invalidate and clear bump the cache generation monotonically", () => {
    const cache = createWorkspaceSummaryCache();
    expect(cache.getGeneration("p")).toBe(0);
    cache.invalidate("p");
    expect(cache.getGeneration("p")).toBe(1);
    cache.clear();
    expect(cache.getGeneration("p")).toBe(2);
  });
});

describe("invalidation warm-ahead (scheduleBoardWarmup)", () => {
  it("rebuilds the cache once after a burst of invalidations, then serves fresh hits", async () => {
    const now = new Date().toISOString();
    const workspaceSummaryCache = createWorkspaceSummaryCache();
    const projectService = createProjectService({ database: db, workspaceSummaryCache });

    // Burst: several events back-to-back collapse into one debounced rebuild.
    projectService.scheduleBoardWarmup(projectId);
    projectService.scheduleBoardWarmup(projectId);
    projectService.scheduleBoardWarmup(projectId);

    await vi.waitFor(() => expect(workspaceSummaryCache.get(projectId)).not.toBeNull());
    expect(buildWorkspaceSummaryMapMock).toHaveBeenCalledTimes(1);
    expect(workspaceSummaryCache.get(projectId)!.stale).toBe(false);

    // The follow-up client refetch is a fresh cache hit — no further rebuild.
    buildWorkspaceSummaryMapMock.mockClear();
    await projectService.getBoard(projectId, now);
    expect(buildWorkspaceSummaryMapMock).not.toHaveBeenCalled();
  });

  it("skips the warmup rebuild when the cache is already fresh", async () => {
    const now = new Date().toISOString();
    const workspaceSummaryCache = createWorkspaceSummaryCache();
    const projectService = createProjectService({ database: db, workspaceSummaryCache });

    await projectService.getBoard(projectId, now); // warms the cache
    buildWorkspaceSummaryMapMock.mockClear();

    projectService.scheduleBoardWarmup(projectId);
    await new Promise((r) => setTimeout(r, 200));
    expect(buildWorkspaceSummaryMapMock).not.toHaveBeenCalled();
  });
});
