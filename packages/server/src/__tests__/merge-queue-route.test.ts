import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createMergeQueueRoute } from "../routes/merge-queue.js";

const mockComputePlan = vi.fn();
const mockExecuteQueue = vi.fn();

vi.mock("../services/merge-queue.service.js", () => ({
  createMergeQueueService: vi.fn(() => ({
    computePlan: mockComputePlan,
    executeQueue: mockExecuteQueue,
  })),
}));

vi.mock("../services/workspace-merge.service.js", () => ({
  createWorkspaceMergeService: vi.fn(() => ({})),
}));

function makeApp() {
  const app = new Hono();
  app.route("/api/merge-queue", createMergeQueueRoute({} as never, () => ({}) as never));
  return app;
}

describe("merge-queue route", () => {
  it("POST /api/merge-queue/preview/:id returns conflict preview for a single workspace", async () => {
    const preview = {
      workspaceId: "ws-1",
      hasConflicts: true,
      conflictingFiles: ["src/index.ts"],
      isStale: false,
    };
    mockComputePlan.mockResolvedValue({
      order: [],
      overlaps: [],
      totalOverlapScore: 0,
      migrationCollisions: [],
      conflictPreviews: [preview],
    });

    const app = makeApp();
    const res = await app.request("/api/merge-queue/preview/ws-1", { method: "POST" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, preview });
    expect(mockComputePlan).toHaveBeenCalledWith(["ws-1"]);
  });

  it("POST /api/merge-queue/preview/:id returns empty preview when plan has no previews", async () => {
    mockComputePlan.mockResolvedValue({
      order: [],
      overlaps: [],
      totalOverlapScore: 0,
      migrationCollisions: [],
      conflictPreviews: [],
    });

    const app = makeApp();
    const res = await app.request("/api/merge-queue/preview/ws-missing", { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.preview.workspaceId).toBe("ws-missing");
    expect(body.preview.hasConflicts).toBe(false);
  });

  it("POST /api/merge-queue with dryRun:true returns plan including conflictPreviews", async () => {
    const plan = {
      order: [],
      overlaps: [],
      totalOverlapScore: 0,
      migrationCollisions: [],
      conflictPreviews: [
        { workspaceId: "ws-a", hasConflicts: false, conflictingFiles: [], isStale: true },
        { workspaceId: "ws-b", hasConflicts: true, conflictingFiles: ["pkg/foo.ts"], isStale: false },
      ],
    };
    mockComputePlan.mockResolvedValue(plan);

    const app = makeApp();
    const res = await app.request("/api/merge-queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceIds: ["ws-a", "ws-b"], dryRun: true }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(body.plan.conflictPreviews).toHaveLength(2);
    expect(body.plan.conflictPreviews[0]).toMatchObject({ workspaceId: "ws-a", isStale: true });
    expect(body.plan.conflictPreviews[1]).toMatchObject({ workspaceId: "ws-b", hasConflicts: true });
  });

  it("POST /api/merge-queue returns 400 when workspaceIds is missing", async () => {
    const app = makeApp();
    const res = await app.request("/api/merge-queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    });

    expect(res.status).toBe(400);
  });
});
