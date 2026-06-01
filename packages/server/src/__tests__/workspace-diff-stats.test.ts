import { describe, expect, it, vi, beforeEach } from "vitest";

const getDiffShortstat = vi.fn();

vi.mock("../services/git.service.js", () => ({
  getDiffShortstat: (...args: unknown[]) => getDiffShortstat(...args),
}));

import { getWorkspaceDiffStats } from "../services/workspace-diff-stats.js";

describe("workspace-diff-stats", () => {
  beforeEach(() => {
    getDiffShortstat.mockReset();
  });

  it("computes active workspace diff stats with the same ref semantics as board status", async () => {
    getDiffShortstat.mockResolvedValue({ filesChanged: 2, insertions: 64, deletions: 0 });

    const stats = await getWorkspaceDiffStats({
      workingDir: "C:/repo/.worktrees/feature",
      baseBranch: null,
      isDirect: false,
      status: "active",
    }, "main");

    expect(stats).toEqual({ filesChanged: 2, insertions: 64, deletions: 0 });
    expect(getDiffShortstat).toHaveBeenCalledWith("C:/repo/.worktrees/feature", "main");
  });

  it("uses HEAD for direct workspace diff stats", async () => {
    getDiffShortstat.mockResolvedValue({ filesChanged: 1, insertions: 4, deletions: 2 });

    await getWorkspaceDiffStats({
      workingDir: "C:/repo",
      baseBranch: "main",
      isDirect: true,
      status: "active",
    }, "main");

    expect(getDiffShortstat).toHaveBeenCalledWith("C:/repo", "HEAD");
  });
});
