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

describe("merge error reporting", () => {
  it("returns 409 with structured error when merge fails with git step context", async () => {
    const { WorkspaceError } = await import("../services/workspace.service.js");
    const gitError = new Error("git merge-tree --write-tree failed: fatal: not a git repository");
    const workspaceError = new WorkspaceError(
      `Merge failed (git-merge step): ${gitError.message}`,
      "CONFLICT",
      { step: "git-merge", branch: "feature/test", targetBranch: "master" },
    );

    // Set mock BEFORE building the app (route factory calls createWorkspaceService eagerly)
    mockedFactory.mockReturnValue({
      mergeWorkspace: vi.fn().mockRejectedValue(workspaceError),
    } as never);

    const app = buildApp();
    const res = await app.request("/api/workspaces/ws-1/merge", { method: "POST" });

    expect(res.status).toBe(409);
    const body = await res.json();
    // Must have a non-empty structured error body — the bug was an empty 500
    expect(body).toHaveProperty("error");
    expect(body.error).toContain("git-merge step");
    expect(body.error).toContain("not a git repository");
  });

  it("returns 500 with non-empty error body when mergeWorkspace throws a plain Error", async () => {
    mockedFactory.mockReturnValue({
      mergeWorkspace: vi.fn().mockRejectedValue(new Error("something unexpected broke")),
    } as never);

    const app = buildApp();
    const res = await app.request("/api/workspaces/ws-2/merge", { method: "POST" });

    expect(res.status).toBe(500);
    const body = await res.json();
    // Even unhandled errors must produce a non-empty JSON body
    expect(body).toHaveProperty("error");
    expect(body.error).toContain("something unexpected broke");
  });

  it("returns 409 with conflicting files when detectConflicts finds conflicts", async () => {
    const { WorkspaceError } = await import("../services/workspace.service.js");
    const workspaceError = new WorkspaceError(
      "Merge conflicts detected",
      "BAD_REQUEST",
      { conflictingFiles: ["src/foo.ts", "src/bar.ts"] },
    );

    mockedFactory.mockReturnValue({
      mergeWorkspace: vi.fn().mockRejectedValue(workspaceError),
    } as never);

    const app = buildApp();
    const res = await app.request("/api/workspaces/ws-3/merge", { method: "POST" });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(body).toHaveProperty("conflictingFiles");
    expect(body.conflictingFiles).toEqual(["src/foo.ts", "src/bar.ts"]);
  });
});
