import { Hono } from "hono";
import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Tests for the workspace cleanup warnings feature.
 *
 * Route-level tests are self-contained: they create a minimal Hono app with
 * the same route handlers as the real routes, but with the workspace service
 * fully mocked so no DB/git is needed.
 */

const mockListCleanupWarnings = vi.fn();
const mockRetryCleanup = vi.fn();

function mockWorkspaceService() {
  return {
    listCleanupWarnings: mockListCleanupWarnings,
    retryCleanup: mockRetryCleanup,
  } as any;
}

function createTestApp() {
  const app = new Hono();
  const svc = mockWorkspaceService();

  // GET /api/workspaces/cleanup-warnings
  app.get("/api/workspaces/cleanup-warnings", async (c) => {
    const projectId = c.req.query("projectId") || undefined;
    const warnings = await svc.listCleanupWarnings(projectId);
    return c.json(warnings);
  });

  // POST /api/workspaces/:id/retry-cleanup
  app.post("/api/workspaces/:id/retry-cleanup", async (c) => {
    const id = c.req.param("id");
    const result = await svc.retryCleanup(id);
    if (!result.success) {
      return c.json({ error: result.error }, 400);
    }
    return c.json({ success: true });
  });

  return app;
}

const SAMPLE_ENTRY = {
  id: "ws-1",
  branch: "feature/ak-100-test",
  workingDir: "C:\\andrena\\.worktrees\\feature_ak-100-test",
  cleanupWarning: "EBUSY: resource busy or locked, rmdir 'C:\\andrena\\.worktrees\\feature_ak-100-test'",
  closedAt: new Date().toISOString(),
  mergedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  issueId: "issue-1",
  issueNumber: 100,
  issueTitle: "Test issue",
  projectId: "proj-1",
};

describe("cleanup warnings API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/workspaces/cleanup-warnings", () => {
    it("returns entries with cleanup warnings for a project", async () => {
      mockListCleanupWarnings.mockResolvedValue([SAMPLE_ENTRY]);

      const app = createTestApp();
      const res = await app.request("/api/workspaces/cleanup-warnings?projectId=proj-1");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe("ws-1");
      expect(body[0].issueNumber).toBe(100);
      expect(body[0].cleanupWarning).toContain("EBUSY");
      expect(mockListCleanupWarnings).toHaveBeenCalledWith("proj-1");
    });

    it("passes undefined projectId when not specified", async () => {
      mockListCleanupWarnings.mockResolvedValue([]);

      const app = createTestApp();
      const res = await app.request("/api/workspaces/cleanup-warnings");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual([]);
      expect(mockListCleanupWarnings).toHaveBeenCalledWith(undefined);
    });

    it("returns multiple entries", async () => {
      const second = { ...SAMPLE_ENTRY, id: "ws-2", issueNumber: 101, branch: "feature/ak-101-other" };
      mockListCleanupWarnings.mockResolvedValue([SAMPLE_ENTRY, second]);

      const app = createTestApp();
      const res = await app.request("/api/workspaces/cleanup-warnings?projectId=proj-1");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toHaveLength(2);
      expect(body[0].id).toBe("ws-1");
      expect(body[1].id).toBe("ws-2");
    });
  });

  describe("POST /api/workspaces/:id/retry-cleanup", () => {
    it("returns success when retry succeeds", async () => {
      mockRetryCleanup.mockResolvedValue({ success: true });

      const app = createTestApp();
      const res = await app.request("/api/workspaces/ws-1/retry-cleanup", { method: "POST" });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(mockRetryCleanup).toHaveBeenCalledWith("ws-1");
    });

    it("returns 400 when workspace not found", async () => {
      mockRetryCleanup.mockResolvedValue({ success: false, error: "Workspace not found" });

      const app = createTestApp();
      const res = await app.request("/api/workspaces/nonexistent/retry-cleanup", { method: "POST" });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toBe("Workspace not found");
    });

    it("returns 400 when workspace is not closed", async () => {
      mockRetryCleanup.mockResolvedValue({ success: false, error: "Workspace is not closed" });

      const app = createTestApp();
      const res = await app.request("/api/workspaces/ws-1/retry-cleanup", { method: "POST" });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toBe("Workspace is not closed");
    });

    it("returns 400 when no cleanup warning exists", async () => {
      mockRetryCleanup.mockResolvedValue({ success: false, error: "No pending cleanup warning for this workspace" });

      const app = createTestApp();
      const res = await app.request("/api/workspaces/ws-1/retry-cleanup", { method: "POST" });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain("No pending cleanup warning");
    });

    it("returns 400 when worktree removal still fails on retry", async () => {
      mockRetryCleanup.mockResolvedValue({
        success: false,
        error: "Failed to remove worktree: EBUSY: resource busy or locked",
      });

      const app = createTestApp();
      const res = await app.request("/api/workspaces/ws-1/retry-cleanup", { method: "POST" });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain("EBUSY");
    });
  });
});
