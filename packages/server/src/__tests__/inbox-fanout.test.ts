/**
 * #348: listInbox fanned out over projects STRICTLY SERIALLY —
 * `for (const project of projectRows) { await listProjectSurface(...); await
 * listPendingQuestionsForProject(...); }` — so every round-trip's latency stacked and
 * the cost was O(projects x plugins x loops x ~8 awaits) on an endpoint the UI polls.
 * This DB has 20 projects. Slow-log entries: 203/213/238/1088ms.
 *
 * 2026-08-11 perf audit: the plugin-gate source is now ONE bulk read
 * (`listLoopSurfacesForProjects`) instead of a per-project `listProjectSurface` — the
 * plugin rows, manifest parses and enabled-pref scans are hoisted out of the loop.
 * Archived projects are excluded entirely (their gates deep-linked into projects the
 * UI can no longer navigate to).
 *
 * These tests pin the bulk + concurrent shape AND that it did not change what the
 * inbox shows: the same items, the same newest-first order, and one broken plugin
 * surface still not emptying everyone else's inbox.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

const listLoopSurfacesForProjects = vi.fn();
const listPendingQuestionsForProject = vi.fn();

vi.mock("../services/plugin.service.js", () => ({
  getPluginService: () => ({ listLoopSurfacesForProjects: (...a: unknown[]) => listLoopSurfacesForProjects(...a) }),
}));
vi.mock("../services/agent-questions/listing.js", () => ({
  listPendingQuestionsForProject: (...a: unknown[]) => listPendingQuestionsForProject(...a),
}));
vi.mock("../services/approvals.js", () => ({ listPendingApprovals: () => [] }));

import { listInbox } from "../services/inbox.service.js";

let db: TestDb;
const PROJECT_COUNT = 6;
let projectIds: string[];

/** One loop status with an actionable gate, born at `gateSince`. */
function loopWithGate(name: string, gateSince: string) {
  return {
    gate: { question: `Approve ${name}?` },
    openTickets: 0,
    pluginName: "demo-plugin",
    pluginId: "plugin-1",
    pluginSlug: "demo",
    label: name,
    name,
    gateSince,
    lastAdvanceAt: gateSince,
    gateRecommendation: null,
  };
}

/** Bulk-surface result: every requested project gets `loopsFor(projectId)`. */
function surfacesFrom(loopsFor: (projectId: string) => unknown[]) {
  return async (ids: string[]) => new Map(ids.map((id) => [id, loopsFor(id)]));
}

beforeEach(async () => {
  db = createTestDb().db;
  listLoopSurfacesForProjects.mockReset().mockImplementation(surfacesFrom(() => []));
  listPendingQuestionsForProject.mockReset().mockResolvedValue([]);

  const now = new Date().toISOString();
  projectIds = [];
  for (let i = 0; i < PROJECT_COUNT; i++) {
    const id = randomUUID();
    projectIds.push(id);
    await db.insert(schema.projects).values({
      id,
      name: `Project ${i}`,
      repoPath: `/tmp/inbox-${i}`,
      repoName: `inbox-${i}`,
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });
  }
});

describe("listInbox fan-out (#348 / 2026-08-11 bulk surface)", () => {
  it("reads every project's plugin surface in ONE bulk call, not per project", async () => {
    await listInbox(db);

    expect(listLoopSurfacesForProjects).toHaveBeenCalledTimes(1);
    const requested = listLoopSurfacesForProjects.mock.calls[0][0] as string[];
    expect([...requested].sort()).toEqual([...projectIds].sort());
  });

  it("runs the bulk plugin surface and agent questions concurrently, not in sequence", async () => {
    let surfaceStarted = false;
    let questionsStartedBeforeSurfaceFinished = false;
    let releaseSurface: () => void = () => {};
    const surfaceHeld = new Promise<void>((resolve) => { releaseSurface = resolve; });

    listLoopSurfacesForProjects.mockImplementation(async (ids: string[]) => {
      surfaceStarted = true;
      await surfaceHeld;
      return new Map(ids.map((id) => [id, []]));
    });
    listPendingQuestionsForProject.mockImplementation(async () => {
      if (surfaceStarted) questionsStartedBeforeSurfaceFinished = true;
      releaseSurface();
      return [];
    });

    await listInbox(db);

    expect(questionsStartedBeforeSurfaceFinished).toBe(true);
  });

  it("returns every project's gate, newest-first", async () => {
    // Ascending gate ages by project index, so the expected output order is the reverse.
    const base = Date.parse("2026-08-01T00:00:00.000Z");
    listLoopSurfacesForProjects.mockImplementation(surfacesFrom((projectId) => {
      const index = projectIds.indexOf(projectId);
      return [loopWithGate(`loop-${index}`, new Date(base + index * 60_000).toISOString())];
    }));

    const { items } = await listInbox(db);

    expect(items).toHaveLength(PROJECT_COUNT);
    expect(items.every((i) => i.kind === "plugin-gate")).toBe(true);
    expect(items.map((i) => i.title)).toEqual(
      Array.from({ length: PROJECT_COUNT }, (_, i) => `Approve loop-${PROJECT_COUNT - 1 - i}?`),
    );
    // Each item still carries its own project's identity after the fan-out.
    for (const item of items) {
      const index = Number(item.title.match(/loop-(\d+)/)![1]);
      expect(item.projectId).toBe(projectIds[index]);
      expect(item.projectName).toBe(`Project ${index}`);
    }
  });

  it("excludes ARCHIVED projects — no gates, no question scan, no dead deep-links", async () => {
    const archivedId = projectIds[1];
    await db.update(schema.projects)
      .set({ archivedAt: new Date().toISOString() })
      .where(eq(schema.projects.id, archivedId));
    listLoopSurfacesForProjects.mockImplementation(surfacesFrom((projectId) => {
      const index = projectIds.indexOf(projectId);
      return [loopWithGate(`loop-${index}`, "2026-08-01T00:00:00.000Z")];
    }));

    const { items } = await listInbox(db);

    // The archived project's gates never surface...
    expect(items).toHaveLength(PROJECT_COUNT - 1);
    expect(items.some((i) => i.projectId === archivedId)).toBe(false);
    // ...and its plugin/question work is not even requested.
    const requested = listLoopSurfacesForProjects.mock.calls[0][0] as string[];
    expect(requested).not.toContain(archivedId);
    const questionedIds = listPendingQuestionsForProject.mock.calls.map((call) => call[0]);
    expect(questionedIds).not.toContain(archivedId);
  });

  it("still collects agent questions when the whole bulk plugin surface throws", async () => {
    // Per-SOURCE error isolation: the two sources are concurrent, so a rejection in
    // one must not take the other's already-collected items with it.
    listLoopSurfacesForProjects.mockRejectedValue(new Error("plugin exploded"));
    listPendingQuestionsForProject.mockImplementation(async (projectId: string) => {
      if (projectId !== projectIds[0]) return [];
      return [{
        staleness: null,
        questions: [{ question: "Which approach?" }],
        issueNumber: 7,
        issueTitle: "Pick an approach",
        workspaceId: "ws-1",
        askedAt: "2026-08-01T00:00:00.000Z",
      }];
    });

    const { items } = await listInbox(db);

    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("agent-question");
    expect(items[0].title).toBe("Which approach?");
    expect(items[0].detail).toBe("#7: Pick an approach");
  });

  it("keeps the other projects' gates when one project's surface entry is missing", async () => {
    // The bulk method swallows per-plugin errors internally, which shows up here as a
    // project simply absent from (or empty in) the returned map.
    const failingId = projectIds[2];
    listLoopSurfacesForProjects.mockImplementation(async (ids: string[]) => new Map(
      ids.filter((id) => id !== failingId).map((id) => {
        const index = projectIds.indexOf(id);
        return [id, [loopWithGate(`loop-${index}`, new Date(Date.parse("2026-08-01T00:00:00.000Z") + index * 60_000).toISOString())]];
      }),
    ));

    const { items } = await listInbox(db);

    expect(items).toHaveLength(PROJECT_COUNT - 1);
    expect(items.some((i) => i.projectId === failingId)).toBe(false);
  });

  it("drops stale agent questions, as before", async () => {
    listPendingQuestionsForProject.mockImplementation(async (projectId: string) => {
      if (projectId !== projectIds[0]) return [];
      return [
        { staleness: "workspace-merged", questions: [{ question: "Stale?" }], issueNumber: 1, issueTitle: "x", workspaceId: "w", askedAt: "2026-08-01T00:00:00.000Z" },
        { staleness: null, questions: [{ question: "Live?" }], issueNumber: 2, issueTitle: "y", workspaceId: "w2", askedAt: "2026-08-01T00:00:00.000Z" },
      ];
    });

    const { items } = await listInbox(db);

    expect(items.map((i) => i.title)).toEqual(["Live?"]);
  });

  it("skips a gate whose round still has open tickets, as before", async () => {
    listLoopSurfacesForProjects.mockImplementation(surfacesFrom((projectId) => {
      if (projectId !== projectIds[0]) return [];
      const loop = loopWithGate("loop-0", "2026-08-01T00:00:00.000Z");
      loop.openTickets = 3;
      return [loop];
    }));

    const { items } = await listInbox(db);

    expect(items).toHaveLength(0);
  });
});
