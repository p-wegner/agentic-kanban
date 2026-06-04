import { describe, it, expect, vi, beforeEach } from "vitest";
import { createWorkspaceSummaryCache } from "../services/workspace-summary-cache.service.js";
import { createBoardEvents } from "../services/board-events.js";
import type { WorkspaceSummary } from "../services/workspace-summary.service.js";

function makeMap(...ids: string[]): Map<string, WorkspaceSummary> {
  const m = new Map<string, WorkspaceSummary>();
  for (const id of ids) {
    m.set(id, { total: 1, active: 0, idle: 1, closed: 0, branches: [] });
  }
  return m;
}

describe("createWorkspaceSummaryCache", () => {
  let cache: ReturnType<typeof createWorkspaceSummaryCache>;

  beforeEach(() => {
    cache = createWorkspaceSummaryCache({ ttlMs: 100 });
  });

  it("returns null on a cold cache", () => {
    expect(cache.get("proj-1")).toBeNull();
  });

  it("returns cached value within TTL", () => {
    const map = makeMap("issue-1");
    cache.set("proj-1", map);
    const hit = cache.get("proj-1");
    expect(hit).toBe(map);
  });

  it("returns null after TTL expires", async () => {
    cache = createWorkspaceSummaryCache({ ttlMs: 10 });
    cache.set("proj-1", makeMap("issue-1"));
    await new Promise((r) => setTimeout(r, 20));
    expect(cache.get("proj-1")).toBeNull();
  });

  it("invalidates a specific project", () => {
    cache.set("proj-1", makeMap("issue-1"));
    cache.set("proj-2", makeMap("issue-2"));
    cache.invalidate("proj-1");
    expect(cache.get("proj-1")).toBeNull();
    expect(cache.get("proj-2")).not.toBeNull();
  });

  it("isolates cache entries between projects", () => {
    const map1 = makeMap("issue-a");
    const map2 = makeMap("issue-b");
    cache.set("proj-1", map1);
    cache.set("proj-2", map2);
    expect(cache.get("proj-1")).toBe(map1);
    expect(cache.get("proj-2")).toBe(map2);
  });

  it("evicts oldest entry when maxProjects is reached", () => {
    cache = createWorkspaceSummaryCache({ ttlMs: 5_000, maxProjects: 2 });
    cache.set("proj-1", makeMap());
    cache.set("proj-2", makeMap());
    cache.set("proj-3", makeMap()); // evicts proj-1
    expect(cache.get("proj-1")).toBeNull();
    expect(cache.get("proj-2")).not.toBeNull();
    expect(cache.get("proj-3")).not.toBeNull();
  });

  it("clear removes all entries", () => {
    cache.set("proj-1", makeMap());
    cache.set("proj-2", makeMap());
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});

describe("workspace-summary cache + board-events invalidation", () => {
  it("invalidates cache when board_changed event fires", () => {
    const boardEvents = createBoardEvents();
    const cache = createWorkspaceSummaryCache({ ttlMs: 5_000 });

    boardEvents.addInvalidationListener((projectId) => cache.invalidate(projectId));

    cache.set("proj-1", makeMap("issue-1"));
    expect(cache.get("proj-1")).not.toBeNull();

    boardEvents.broadcast("proj-1", "workspace_created");
    expect(cache.get("proj-1")).toBeNull();
  });

  it("does not invalidate other projects on board change", () => {
    const boardEvents = createBoardEvents();
    const cache = createWorkspaceSummaryCache({ ttlMs: 5_000 });

    boardEvents.addInvalidationListener((projectId) => cache.invalidate(projectId));

    cache.set("proj-1", makeMap("issue-1"));
    cache.set("proj-2", makeMap("issue-2"));

    boardEvents.broadcast("proj-1", "workspace_merged");

    expect(cache.get("proj-1")).toBeNull();
    expect(cache.get("proj-2")).not.toBeNull();
  });

  it("removeInvalidationListener stops further invalidation", () => {
    const boardEvents = createBoardEvents();
    const cache = createWorkspaceSummaryCache({ ttlMs: 5_000 });

    const listener = (projectId: string) => cache.invalidate(projectId);
    boardEvents.addInvalidationListener(listener);

    cache.set("proj-1", makeMap("issue-1"));
    boardEvents.removeInvalidationListener(listener);

    boardEvents.broadcast("proj-1", "issue_moved" as any);
    expect(cache.get("proj-1")).not.toBeNull();
  });
});
