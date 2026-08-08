/**
 * #348: listInbox fanned out over projects STRICTLY SERIALLY —
 * `for (const project of projectRows) { await listProjectSurface(...); await
 * listPendingQuestionsForProject(...); }` — so every round-trip's latency stacked and
 * the cost was O(projects x plugins x loops x ~8 awaits) on an endpoint the UI polls.
 * This DB has 20 projects. Slow-log entries: 203/213/238/1088ms.
 *
 * These tests pin the parallel fan-out AND that it did not change what the inbox shows:
 * the same items, the same newest-first order, and one project's broken plugin surface
 * still not emptying everyone else's inbox.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

const listProjectSurface = vi.fn();
const listPendingQuestionsForProject = vi.fn();

vi.mock("../services/plugin.service.js", () => ({
  getPluginService: () => ({ listProjectSurface: (...a: unknown[]) => listProjectSurface(...a) }),
}));
vi.mock("../services/agent-questions/listing.js", () => ({
  listPendingQuestionsForProject: (...a: unknown[]) => listPendingQuestionsForProject(...a),
}));
vi.mock("../services/approvals.js", () => ({ listPendingApprovals: () => [] }));

import { listInbox } from "../services/inbox.service.js";

let db: TestDb;
const PROJECT_COUNT = 6;
let projectIds: string[];

/** A plugin surface with one actionable gate, born at `gateSince`. */
function surfaceWithGate(name: string, gateSince: string) {
  return {
    loops: [{
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
    }],
  };
}

beforeEach(async () => {
  db = createTestDb().db;
  listProjectSurface.mockReset();
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

describe("listInbox fan-out (#348)", () => {
  it("queries every project's surface concurrently instead of one after another", async () => {
    let inFlight = 0;
    let peak = 0;
    const gate = new Promise<void>((resolve) => setTimeout(resolve, 20));

    listProjectSurface.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Hold every call open until they have all had a chance to start. Serially, the
      // first call would have to RESOLVE before the second began, so peak would be 1.
      await gate;
      inFlight--;
      return { loops: [] };
    });

    await listInbox(db);

    expect(listProjectSurface).toHaveBeenCalledTimes(PROJECT_COUNT);
    expect(peak).toBe(PROJECT_COUNT);
  });

  it("runs a project's plugin surface and agent questions concurrently, not in sequence", async () => {
    let surfaceStarted = false;
    let questionsStartedBeforeSurfaceFinished = false;
    let releaseSurface: () => void = () => {};
    const surfaceHeld = new Promise<void>((resolve) => { releaseSurface = resolve; });

    listProjectSurface.mockImplementation(async () => {
      surfaceStarted = true;
      await surfaceHeld;
      return { loops: [] };
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
    listProjectSurface.mockImplementation(async (projectId: string) => {
      const index = projectIds.indexOf(projectId);
      return surfaceWithGate(`loop-${index}`, new Date(base + index * 60_000).toISOString());
    });

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

  it("keeps the other projects' items when one project's plugin surface throws", async () => {
    const failingId = projectIds[2];
    listProjectSurface.mockImplementation(async (projectId: string) => {
      if (projectId === failingId) throw new Error("plugin exploded");
      const index = projectIds.indexOf(projectId);
      return surfaceWithGate(`loop-${index}`, new Date(Date.parse("2026-08-01T00:00:00.000Z") + index * 60_000).toISOString());
    });

    const { items } = await listInbox(db);

    expect(items).toHaveLength(PROJECT_COUNT - 1);
    expect(items.some((i) => i.projectId === failingId)).toBe(false);
  });

  it("still collects a project's agent questions when its plugin surface throws", async () => {
    // Per-SOURCE error isolation: the two sources are now concurrent, so a rejection in
    // one must not take the other's already-collected items with it.
    listProjectSurface.mockRejectedValue(new Error("plugin exploded"));
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

  it("drops stale agent questions, as before", async () => {
    listProjectSurface.mockResolvedValue({ loops: [] });
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
    listProjectSurface.mockImplementation(async (projectId: string) => {
      if (projectId !== projectIds[0]) return { loops: [] };
      const surface = surfaceWithGate("loop-0", "2026-08-01T00:00:00.000Z");
      surface.loops[0].openTickets = 3;
      return surface;
    });

    const { items } = await listInbox(db);

    expect(items).toHaveLength(0);
  });
});
