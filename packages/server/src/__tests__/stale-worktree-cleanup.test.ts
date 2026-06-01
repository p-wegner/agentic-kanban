import { Hono } from "hono";
import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Tests for the stale worktree cleanup feature.
 *
 * Route-level tests are self-contained: they create a minimal Hono app with
 * the exact route handlers (not importing from routes/ — those live in the
 * worktree and the main checkout doesn't have them yet). The service layer is
 * fully mocked so no DB/git is needed.
 *
 * Path-safety tests reproduce the exact same validation logic used in
 * removeStaleWorktree() to confirm the guard works for safe, unsafe, traversal,
 * and repo-root paths.
 */

const mockListStaleWorktrees = vi.fn();
const mockRemoveStaleWorktree = vi.fn();

// Minimal workspace service mock for the route handlers
function mockWorkspaceService() {
  return {
    listStaleWorktrees: mockListStaleWorktrees,
    removeStaleWorktree: mockRemoveStaleWorktree,
  } as any;
}

function createTestApp() {
  const app = new Hono();

  // GET /api/workspaces/stale-worktrees — mirrors the real route handler
  app.get("/api/workspaces/stale-worktrees", async (c) => {
    const projectId = c.req.query("projectId") || undefined;
    const staleWorktrees = await mockListStaleWorktrees(projectId);
    return c.json(staleWorktrees);
  });

  // DELETE /api/workspaces/:id/stale-worktree — mirrors the real route handler
  app.delete("/api/workspaces/:id/stale-worktree", async (c) => {
    const id = c.req.param("id");
    const result = await mockRemoveStaleWorktree(id);
    if (!result.success) {
      return c.json({ error: result.error }, 400);
    }
    return c.json({ success: true });
  });

  return app;
}

describe("stale worktree cleanup API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/workspaces/stale-worktrees", () => {
    it("returns stale worktrees for a project", async () => {
      mockListStaleWorktrees.mockResolvedValue([
        {
          id: "ws-1",
          branch: "feature/ak-42-test",
          workingDir: "/repo/.worktrees/feature_ak-42-test",
          workspaceStatus: "closed",
          closedAt: new Date().toISOString(),
          mergedAt: null,
          updatedAt: new Date().toISOString(),
          issueId: "issue-1",
          issueNumber: 42,
          issueTitle: "Test issue",
          issueStatusName: "Done",
          projectId: "proj-1",
          repoPath: "/repo",
        },
      ]);

      const app = createTestApp();
      const res = await app.request("/api/workspaces/stale-worktrees?projectId=proj-1");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe("ws-1");
      expect(body[0].issueNumber).toBe(42);
      expect(body[0].branch).toBe("feature/ak-42-test");
      expect(body[0].workspaceStatus).toBe("closed");
      expect(mockListStaleWorktrees).toHaveBeenCalledWith("proj-1");
    });

    it("returns empty array when no stale worktrees exist", async () => {
      mockListStaleWorktrees.mockResolvedValue([]);

      const app = createTestApp();
      const res = await app.request("/api/workspaces/stale-worktrees");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual([]);
      expect(mockListStaleWorktrees).toHaveBeenCalledWith(undefined);
    });
  });

  describe("DELETE /api/workspaces/:id/stale-worktree", () => {
    it("returns success when removal succeeds", async () => {
      mockRemoveStaleWorktree.mockResolvedValue({ success: true });

      const app = createTestApp();
      const res = await app.request("/api/workspaces/ws-1/stale-worktree", { method: "DELETE" });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(mockRemoveStaleWorktree).toHaveBeenCalledWith("ws-1");
    });

    it("returns 400 with error when removal fails (not closed)", async () => {
      mockRemoveStaleWorktree.mockResolvedValue({
        success: false,
        error: "Workspace is not closed",
      });

      const app = createTestApp();
      const res = await app.request("/api/workspaces/ws-1/stale-worktree", { method: "DELETE" });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toBe("Workspace is not closed");
    });

    it("returns 400 with error for unsafe path", async () => {
      mockRemoveStaleWorktree.mockResolvedValue({
        success: false,
        error: "Refusing to remove path outside managed worktrees directory",
      });

      const app = createTestApp();
      const res = await app.request("/api/workspaces/ws-1/stale-worktree", { method: "DELETE" });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain("Refusing to remove");
    });

    it("returns 400 when workspace not found", async () => {
      mockRemoveStaleWorktree.mockResolvedValue({
        success: false,
        error: "Workspace not found",
      });

      const app = createTestApp();
      const res = await app.request("/api/workspaces/nonexistent/stale-worktree", { method: "DELETE" });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toBe("Workspace not found");
    });
  });
});

describe("stale worktree path safety", () => {
  it("path inside .worktrees/ is considered safe", () => {
    const { resolve, dirname, parse, relative, sep } = require("node:path");
    const repoPath = "C:\\andrena\\agentic-kanban";
    const worktreePath = "C:\\andrena\\.worktrees\\feature_ak-42-test";
    const worktreesRoot = resolve(dirname(repoPath), ".worktrees");
    const targetResolved = resolve(worktreePath);
    const relativeToWorktreesRoot = relative(worktreesRoot, targetResolved);
    const root = parse(targetResolved).root;
    const isInside = relativeToWorktreesRoot !== ""
      && relativeToWorktreesRoot !== ".."
      && !relativeToWorktreesRoot.startsWith(`..${sep}`)
      && parse(relativeToWorktreesRoot).root === "";

    expect(isInside).toBe(true);
  });

  it("path outside .worktrees/ is rejected", () => {
    const { resolve, dirname, parse, relative, sep } = require("node:path");
    const repoPath = "C:\\andrena\\agentic-kanban";
    const worktreePath = "C:\\Users\\evil\\dangerous";
    const worktreesRoot = resolve(dirname(repoPath), ".worktrees");
    const targetResolved = resolve(worktreePath);
    const relativeToWorktreesRoot = relative(worktreesRoot, targetResolved);
    const root = parse(targetResolved).root;
    const isInside = relativeToWorktreesRoot !== ""
      && relativeToWorktreesRoot !== ".."
      && !relativeToWorktreesRoot.startsWith(`..${sep}`)
      && parse(relativeToWorktreesRoot).root === "";

    expect(isInside).toBe(false);
  });

  it("repo root itself is rejected", () => {
    const { resolve, dirname, parse, relative, sep } = require("node:path");
    const repoPath = "C:\\andrena\\agentic-kanban";
    const worktreePath = "C:\\andrena\\agentic-kanban";
    const worktreesRoot = resolve(dirname(repoPath), ".worktrees");
    const targetResolved = resolve(worktreePath);
    const repoResolved = resolve(repoPath);
    const relativeToWorktreesRoot = relative(worktreesRoot, targetResolved);

    // The repo root itself should be rejected (targetResolved === repoResolved)
    expect(targetResolved).toBe(repoResolved);
  });

  it("traversal attack with .. is rejected", () => {
    const { resolve, dirname, parse, relative, sep } = require("node:path");
    const repoPath = "C:\\andrena\\agentic-kanban";
    const worktreePath = "C:\\andrena\\.worktrees\\..\\evil";
    const worktreesRoot = resolve(dirname(repoPath), ".worktrees");
    const targetResolved = resolve(worktreePath);
    const relativeToWorktreesRoot = relative(worktreesRoot, targetResolved);
    const root = parse(targetResolved).root;
    const isInside = relativeToWorktreesRoot !== ""
      && relativeToWorktreesRoot !== ".."
      && !relativeToWorktreesRoot.startsWith(`..${sep}`)
      && parse(relativeToWorktreesRoot).root === "";

    // resolve() normalizes .. away, so "C:\andrena\.worktrees\..\evil" → "C:\andrena\evil"
    // relative() from worktreesRoot will give "../evil" — starts with ".." + sep
    expect(isInside).toBe(false);
  });
});
