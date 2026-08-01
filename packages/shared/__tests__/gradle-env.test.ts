import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { gradleUserHomeForWorktree } from "../src/lib/gradle-env";

describe("gradleUserHomeForWorktree", () => {
  it("derives a path under the OS temp dir, keyed by the worktree", () => {
    const worktreePath = "/repos/proj/.worktrees/ak-42";
    const home = gradleUserHomeForWorktree(worktreePath);
    expect(home.startsWith(tmpdir())).toBe(true);
    expect(home).toContain("kanban-gradle-homes");
    expect(home).toContain("ak-42");
  });

  it("gives distinct worktrees distinct homes", () => {
    const homeA = gradleUserHomeForWorktree("/repos/proj/.worktrees/ak-1");
    const homeB = gradleUserHomeForWorktree("/repos/proj/.worktrees/ak-2");
    expect(homeA).not.toBe(homeB);
  });

  it("gives distinct homes for same-named worktrees under different repos", () => {
    const homeA = gradleUserHomeForWorktree("/repos/proj-a/.worktrees/ak-1");
    const homeB = gradleUserHomeForWorktree("/repos/proj-b/.worktrees/ak-1");
    expect(homeA).not.toBe(homeB);
  });

  it("is deterministic for the same worktree path", () => {
    const path = "/repos/proj/.worktrees/ak-7";
    expect(gradleUserHomeForWorktree(path)).toBe(gradleUserHomeForWorktree(path));
  });
});
