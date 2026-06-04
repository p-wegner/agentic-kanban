import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceActionsRoute } from "../routes/workspace-actions.js";
import { createWorkspaceService } from "../services/workspace.service.js";

const getWorkspaceDiff = vi.fn();

vi.mock("../services/workspace.service.js", () => ({
  createWorkspaceService: vi.fn(() => ({
    getWorkspaceDiff,
    mergeWorkspace: vi.fn(),
    getConflicts: vi.fn(),
    getLatestCommit: vi.fn(),
  })),
}));

function makeApp() {
  const app = new Hono();
  app.route(
    "/api/workspaces",
    createWorkspaceActionsRoute(() => ({}) as never, {} as never),
  );
  return app;
}

const DIFF_V1 = { diff: "diff --git a/foo.ts b/foo.ts\n+added line", stats: { filesChanged: 1, insertions: 1, deletions: 0 }, comments: [], conflicts: null };
const DIFF_V2 = { diff: "diff --git a/foo.ts b/foo.ts\n+another line", stats: { filesChanged: 1, insertions: 1, deletions: 0 }, comments: [], conflicts: null };

describe("GET /api/workspaces/:id/diff ETag / conditional-GET", () => {
  it("returns 200 with ETag, then 304 on matching If-None-Match", async () => {
    getWorkspaceDiff.mockResolvedValue(DIFF_V1);
    const app = makeApp();

    // First request — 200 with ETag
    const res1 = await app.request("/api/workspaces/ws-1/diff");
    expect(res1.status).toBe(200);
    const etag1 = res1.headers.get("ETag");
    expect(etag1).toBeTruthy();
    const body1 = await res1.json();
    expect(body1.diff).toContain("added line");

    // Second request with matching ETag — 304 with empty body
    const res2 = await app.request("/api/workspaces/ws-1/diff", {
      headers: { "If-None-Match": etag1! },
    });
    expect(res2.status).toBe(304);
    expect(await res2.text()).toBe("");
    expect(res2.headers.get("ETag")).toBe(etag1);
  });

  it("returns 200 with new ETag when diff changes (invalidation)", async () => {
    const app = makeApp();

    getWorkspaceDiff.mockResolvedValue(DIFF_V1);
    const res1 = await app.request("/api/workspaces/ws-2/diff");
    expect(res1.status).toBe(200);
    const etag1 = res1.headers.get("ETag");
    expect(etag1).toBeTruthy();

    // Simulate a commit / working-tree change
    getWorkspaceDiff.mockResolvedValue(DIFF_V2);

    const res2 = await app.request("/api/workspaces/ws-2/diff", {
      headers: { "If-None-Match": etag1! },
    });
    expect(res2.status).toBe(200);
    const etag2 = res2.headers.get("ETag");
    expect(etag2).toBeTruthy();
    expect(etag2).not.toBe(etag1);
    const body2 = await res2.json();
    expect(body2.diff).toContain("another line");
  });
});
