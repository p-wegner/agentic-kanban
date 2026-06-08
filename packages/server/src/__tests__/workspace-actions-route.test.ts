import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceActionsRoute } from "../routes/workspace-actions.js";
import { createWorkspaceService } from "../services/workspace.service.js";

const mergeWorkspaceMock = vi.hoisted(() => vi.fn(async (id: string) => ({
  id,
  mergeOutput: "Merge made by the 'ort' strategy.",
  warnings: [
    { step: "remove-worktree", message: "worktree still busy", recoverable: true },
  ],
})));

vi.mock("../services/workspace.service.js", () => ({
  createWorkspaceService: vi.fn(() => ({
    mergeWorkspace: mergeWorkspaceMock,
  })),
}));

describe("workspace actions route", () => {
  beforeEach(() => {
    mergeWorkspaceMock.mockReset();
    mergeWorkspaceMock.mockResolvedValue({
      id: "workspace-1",
      mergeOutput: "Merge made by the 'ort' strategy.",
      warnings: [
        { step: "remove-worktree", message: "worktree still busy", recoverable: true },
      ],
    });
  });

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

  it("keeps a disconnected merge running and reuses it for a retry", async () => {
    let resolveMerge: () => void = () => {};
    mergeWorkspaceMock.mockImplementationOnce((id: string) => new Promise((resolve) => {
      resolveMerge = () => resolve({ id, mergeOutput: "Merge made after disconnect." });
    }));

    const app = new Hono();
    app.route(
      "/api/workspaces",
      createWorkspaceActionsRoute(
        () => ({}) as never,
        {} as never,
      ),
    );

    const abortController = new AbortController();
    const droppedRequest = app.request("/api/workspaces/workspace-1/merge", {
      method: "POST",
      signal: abortController.signal,
    });
    abortController.abort();

    const retryRequest = app.request("/api/workspaces/workspace-1/merge", { method: "POST" });
    resolveMerge();

    const retryResponse = await retryRequest;
    expect(retryResponse.status).toBe(200);
    await expect(retryResponse.json()).resolves.toEqual({
      id: "workspace-1",
      mergeOutput: "Merge made after disconnect.",
    });
    expect(mergeWorkspaceMock).toHaveBeenCalledTimes(1);
    await droppedRequest.catch(() => undefined);
  });
});
