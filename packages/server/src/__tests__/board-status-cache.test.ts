import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BoardStatusResponse } from "@agentic-kanban/shared";

const { getDiffShortstat } = vi.hoisted(() => ({
  getDiffShortstat: vi.fn(async () => ({ filesChanged: 1, insertions: 2, deletions: 3 })),
}));
vi.mock("../services/git.service.js", () => ({ getDiffShortstat }));

import { createBoardStatusCache } from "../services/board-status-cache.js";
import { getWorkspaceDiffStats, __resetDiffStatsCacheForTests } from "../services/workspace-diff-stats.js";

const response = { issues: [] } as unknown as BoardStatusResponse;

describe("board status cache (#1614)", () => {
  beforeEach(() => { vi.useFakeTimers(); __resetDiffStatsCacheForTests(); getDiffShortstat.mockClear(); });
  afterEach(() => { vi.useRealTimers(); });

  it("3 concurrent calls over 15 workspaces share one computation; a call within the TTL spawns no git", async () => {
    const cache = createBoardStatusCache(5_000);
    const workspaces = Array.from({ length: 15 }, (_, i) => ({
      workingDir: `/wt/${i}`, baseBranch: "master", isDirect: false, status: "idle",
    }));
    const compute = vi.fn(async () => {
      await Promise.all(workspaces.map((w) => getWorkspaceDiffStats(w, "master")));
      return response;
    });

    await Promise.all([1, 2, 3].map(() => cache.get("p:false", compute)));
    expect(compute).toHaveBeenCalledTimes(1);
    expect(getDiffShortstat).toHaveBeenCalledTimes(15);

    vi.advanceTimersByTime(2_000);
    await cache.get("p:false", compute);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(getDiffShortstat).toHaveBeenCalledTimes(15);

    // Past the status TTL the build reruns, but idle workspaces' diff stats are still cached.
    vi.advanceTimersByTime(5_000);
    await cache.get("p:false", compute);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(getDiffShortstat).toHaveBeenCalledTimes(15);
  });

  it("does not cache a failure", async () => {
    const cache = createBoardStatusCache(5_000);
    const compute = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(response);
    await expect(cache.get("k", compute)).rejects.toThrow("boom");
    await cache.get("k", compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("shares a slow in-flight computation beyond the TTL", async () => {
    const cache = createBoardStatusCache(5_000);
    let release!: () => void;
    const compute = vi.fn(() => new Promise<BoardStatusResponse>((r) => { release = () => r(response); }));
    const a = cache.get("k", compute);
    vi.advanceTimersByTime(30_000);
    const b = cache.get("k", compute);
    release();
    await Promise.all([a, b]);
    expect(compute).toHaveBeenCalledTimes(1);
  });
});
