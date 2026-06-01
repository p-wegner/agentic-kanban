import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceActionsRoute } from "../routes/workspace-actions.js";
import { createWorkspaceService } from "../services/workspace.service.js";

vi.mock("../services/workspace.service.js", () => ({
  createWorkspaceService: vi.fn(() => ({
    mergeWorkspace: vi.fn(async (id: string) => ({
      id,
      mergeOutput: "Merge made by the 'ort' strategy.",
      warnings: [
        { step: "remove-worktree", message: "worktree still busy", recoverable: true },
      ],
    })),
  })),
}));

describe("workspace actions route", () => {
  it("keeps POST /api/workspaces/:id/merge successful when merge returns recoverable cleanup warnings", async () => {
    const app = new Hono();
    app.route(
      "/api/workspaces",
      createWorkspaceActionsRoute(
        () => ({}) as never,
        {} as never,
      ),
    );

    const res = await app.request("/api/workspaces/workspace-1/merge", { method: "POST" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      id: "workspace-1",
      mergeOutput: "Merge made by the 'ort' strategy.",
      warnings: [
        { step: "remove-worktree", message: "worktree still busy", recoverable: true },
      ],
    });
    expect(createWorkspaceService).toHaveBeenCalled();
  });
});
