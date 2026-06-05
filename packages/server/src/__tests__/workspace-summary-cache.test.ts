import { describe, it, expect, vi, beforeEach } from "vitest";
import { createWorkspaceSummaryCache } from "../services/workspace-summary-cache.service.js";
import { createBoardEvents, type BoardEventType } from "../services/board-events.js";
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
    cache = createWorkspaceSummaryCache({ ttlMs: 100, staleTtlMs: 500 });
  });

  it("returns null on a cold cache", () => {
    expect(cache.get("proj-1")).toBeNull();
  });

  it("returns fresh value within TTL (stale=false)", () => {
    const map = makeMap("issue-1");
    cache.set("proj-1", map);
    const hit = cache.get("proj-1");
    expect(hit).not.toBeNull();
    expect(hit!.value).toBe(map);
    expect(hit!.stale).toBe(false);
  });

  it("returns stale value after TTL but within staleTtl (stale=true)", async () => {
    cache = createWorkspaceSummaryCache({ ttlMs: 10, staleTtlMs: 5_000 });
    const map = makeMap("issue-1");
    cache.set("proj-1", map);
    await new Promise((r) => setTimeout(r, 20));
    const hit = cache.get("proj-1");
    expect(hit).not.toBeNull();
    expect(hit!.value).toBe(map);
    expect(hit!.stale).toBe(true);
  });

  it("returns null after both TTL and staleTtl expire", async () => {
    cache = createWorkspaceSummaryCache({ ttlMs: 10, staleTtlMs: 10 });
    cache.set("proj-1", makeMap("issue-1"));
    await new Promise((r) => setTimeout(r, 30));
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
    expect(cache.get("proj-1")!.value).toBe(map1);
    expect(cache.get("proj-2")!.value).toBe(map2);
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

  it("rebuilding flag prevents duplicate background rebuilds", () => {
    cache.set("proj-1", makeMap("issue-1"));
    expect(cache.isRebuilding("proj-1")).toBe(false);
    cache.markRebuilding("proj-1");
    expect(cache.isRebuilding("proj-1")).toBe(true);
    cache.clearRebuilding("proj-1");
    expect(cache.isRebuilding("proj-1")).toBe(false);
  });

  it("isRebuilding returns false for unknown project", () => {
    expect(cache.isRebuilding("unknown")).toBe(false);
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

/**
 * Table-driven cache-freshness test.
 *
 * Each row names a mutation event type and asserts that broadcasting it
 * invalidates the cache for the affected project.  This is the canonical
 * exhaustive list — any new mutation route that emits an event type not
 * listed here will show up as a gap.
 */
describe("board cache invalidated by every mutation event type", () => {
  const MUTATION_EVENTS: BoardEventType[] = [
    // Issue lifecycle
    "issue_created",
    "issue_updated",
    "issue_deleted",
    // Dependency edges
    "dependency_added",
    "dependency_removed",
    // Workspace lifecycle
    "workspace_created",
    "workspace_setup",
    "workspace_idle",
    "workspace_merged",
    "workspace_closed",
    "workspace_ready_for_merge",
    // Session signals that change visible board state
    "session_completed",
    "session_launched",
    "session_stopped",
    // Workflow mutations
    "workflow_error",
    "workflow_fork",
    "workflow_join",
    "workflow_template_saved",
    "workflow_template_deleted",
    "workflow_transition",
    // Generic board change (e.g. monitor-cycle)
    "board_changed",
    // Internal notifications
    "internal_notify",
  ];

  for (const eventType of MUTATION_EVENTS) {
    it(`invalidates cache on "${eventType}"`, () => {
      const boardEvents = createBoardEvents();
      const cache = createWorkspaceSummaryCache({ ttlMs: 5_000 });

      boardEvents.addInvalidationListener((projectId) => cache.invalidate(projectId));

      cache.set("proj-x", makeMap("issue-1"));
      expect(cache.get("proj-x")).not.toBeNull();

      boardEvents.broadcast("proj-x", eventType);

      expect(cache.get("proj-x")).toBeNull();
    });

    it(`"${eventType}" does not invalidate unrelated projects`, () => {
      const boardEvents = createBoardEvents();
      const cache = createWorkspaceSummaryCache({ ttlMs: 5_000 });

      boardEvents.addInvalidationListener((projectId) => cache.invalidate(projectId));

      cache.set("proj-x", makeMap("issue-1"));
      cache.set("proj-y", makeMap("issue-2"));

      boardEvents.broadcast("proj-x", eventType);

      expect(cache.get("proj-x")).toBeNull();
      expect(cache.get("proj-y")).not.toBeNull();
    });
  }
});
