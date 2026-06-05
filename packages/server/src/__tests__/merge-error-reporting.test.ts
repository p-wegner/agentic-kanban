import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceActionsRoute } from "../routes/workspace-actions.js";
import { createWorkspaceService } from "../services/workspace.service.js";

// Partially mock workspace.service.js — keep real WorkspaceError so the error
// handler's `instanceof` check works (it imports WorkspaceError from this module).
vi.mock("../services/workspace.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/workspace.service.js")>();
  return {
    ...actual,
    createWorkspaceService: vi.fn(),
  };
});

const mockedFactory = vi.mocked(createWorkspaceService);

function buildApp() {
  const app = new Hono();
  app.route("/api/workspaces", createWorkspaceActionsRoute(
    () => ({}) as never,
    {} as never,
  ));
  return app;
}

describe("merge 409 structured body", () => {
  it("reason=conflict with conflictFiles when detectConflicts finds conflicts", async () => {
    const { WorkspaceError } = await import("../services/workspace.service.js");
    const workspaceError = new WorkspaceError(
      "Merge conflicts detected",
      "CONFLICT",
      { mergeReason: "conflict", conflictFiles: ["src/foo.ts", "src/bar.ts"] },
    );

    mockedFactory.mockReturnValue({
      mergeWorkspace: vi.fn().mockRejectedValue(workspaceError),
    } as never);

    const app = buildApp();
    const res = await app.request("/api/workspaces/ws-1/merge", { method: "POST" });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("conflict");
    expect(body.message).toContain("conflicts");
    expect(body.conflictFiles).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  it("reason=not_approved when workspace is not ready for merge", async () => {
    const { WorkspaceError } = await import("../services/workspace.service.js");
    const workspaceError = new WorkspaceError(
      "Workspace is not approved for merge. Mark it as ready-for-merge before merging.",
      "CONFLICT",
      { mergeReason: "not_approved", status: "idle" },
    );

    mockedFactory.mockReturnValue({
      mergeWorkspace: vi.fn().mockRejectedValue(workspaceError),
    } as never);

    const app = buildApp();
    const res = await app.request("/api/workspaces/ws-2/merge", { method: "POST" });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("not_approved");
    expect(body.message).toContain("ready-for-merge");
    expect(body).not.toHaveProperty("conflictFiles");
  });

  it("reason=already_merged when workspace is already merged", async () => {
    const { WorkspaceError } = await import("../services/workspace.service.js");
    const workspaceError = new WorkspaceError(
      "Workspace has already been merged.",
      "CONFLICT",
      { mergeReason: "already_merged" },
    );

    mockedFactory.mockReturnValue({
      mergeWorkspace: vi.fn().mockRejectedValue(workspaceError),
    } as never);

    const app = buildApp();
    const res = await app.request("/api/workspaces/ws-3/merge", { method: "POST" });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("already_merged");
    expect(body.message).toContain("already been merged");
    expect(body).not.toHaveProperty("conflictFiles");
  });

  it("reason=dirty_main when main checkout has uncommitted changes", async () => {
    const { WorkspaceError } = await import("../services/workspace.service.js");
    const workspaceError = new WorkspaceError(
      "Main checkout has 2 uncommitted tracked change(s) — commit or stash those changes first.",
      "CONFLICT",
      { mergeReason: "dirty_main", uncommittedFiles: ["src/a.ts", "src/b.ts"] },
    );

    mockedFactory.mockReturnValue({
      mergeWorkspace: vi.fn().mockRejectedValue(workspaceError),
    } as never);

    const app = buildApp();
    const res = await app.request("/api/workspaces/ws-4/merge", { method: "POST" });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("dirty_main");
    expect(body.message).toContain("uncommitted");
    expect(body).not.toHaveProperty("conflictFiles");
  });

  it("returns 503 with reason=server_build_stale when mergeWorkspace throws a WorkspaceError for stale build", async () => {
    const { WorkspaceError } = await import("../services/workspace.service.js");
    const staleError = new WorkspaceError(
      "Merge helper unavailable — the server build may be stale. Rebuild shared/dist and restart. (gitService.checkBranchTipIsAncestor is not a function)",
      "CONFLICT",
      { mergeReason: "server_build_stale", originalMessage: "gitService.checkBranchTipIsAncestor is not a function" },
    );

    mockedFactory.mockReturnValue({
      mergeWorkspace: vi.fn().mockRejectedValue(staleError),
    } as never);

    const app = buildApp();
    const res = await app.request("/api/workspaces/ws-stale/merge", { method: "POST" });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.reason).toBe("server_build_stale");
    expect(body.message).toContain("stale");
    expect(body).not.toHaveProperty("conflictFiles");
  });

  it("returns 500 with non-empty error body when mergeWorkspace throws a plain Error", async () => {
    mockedFactory.mockReturnValue({
      mergeWorkspace: vi.fn().mockRejectedValue(new Error("something unexpected broke")),
    } as never);

    const app = buildApp();
    const res = await app.request("/api/workspaces/ws-5/merge", { method: "POST" });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(body.error).toContain("something unexpected broke");
  });

  it("returns 409 with reason=conflict for git-step merge failure", async () => {
    const { WorkspaceError } = await import("../services/workspace.service.js");
    const workspaceError = new WorkspaceError(
      "Merge failed (git-merge step): fatal: not a git repository",
      "CONFLICT",
      { mergeReason: "conflict", step: "git-merge", branch: "feature/test", targetBranch: "master" },
    );

    mockedFactory.mockReturnValue({
      mergeWorkspace: vi.fn().mockRejectedValue(workspaceError),
    } as never);

    const app = buildApp();
    const res = await app.request("/api/workspaces/ws-6/merge", { method: "POST" });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("conflict");
    expect(body.message).toContain("git-merge step");
  });
});
