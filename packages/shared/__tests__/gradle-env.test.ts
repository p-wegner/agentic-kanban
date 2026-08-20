import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { gradleUserHomeForWorktree, removeGradleUserHomeForWorktree, GRADLE_HOMES_ROOT } from "../src/lib/gradle-env";

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

  // The key must survive the different spellings of one directory that real call sites
  // produce (a DB workingDir, a forward-slashed copy, a trailing separator). Hashing the
  // RAW string forked a separate multi-GB cache + daemon registry per spelling, which is
  // exactly the daemon sharing this function exists to guarantee.
  it("normalises a trailing separator to the same home", () => {
    const base = resolve("/repos/proj/.worktrees/ak-9");
    expect(gradleUserHomeForWorktree(base + "/")).toBe(gradleUserHomeForWorktree(base));
  });

  it("normalises redundant path segments to the same home", () => {
    const base = resolve("/repos/proj/.worktrees/ak-9");
    expect(gradleUserHomeForWorktree(resolve("/repos/proj/.worktrees/./ak-9"))).toBe(gradleUserHomeForWorktree(base));
    expect(gradleUserHomeForWorktree(resolve("/repos/proj/other/../.worktrees/ak-9"))).toBe(gradleUserHomeForWorktree(base));
  });

  it.runIf(process.platform === "win32")("folds drive-letter/path case on Windows (case-insensitive FS)", () => {
    expect(gradleUserHomeForWorktree(String.raw`C:\Repos\Proj\.worktrees\ak-9`))
      .toBe(gradleUserHomeForWorktree(String.raw`c:\repos\proj\.worktrees\ak-9`));
  });

  it.runIf(process.platform !== "win32")("does NOT fold case on POSIX (two real directories)", () => {
    expect(gradleUserHomeForWorktree("/repos/Proj/.worktrees/ak-9"))
      .not.toBe(gradleUserHomeForWorktree("/repos/proj/.worktrees/ak-9"));
  });
});

// The home lives OUTSIDE the worktree, so removing the worktree never removed it: every
// worktree that ever ran gradle leaked one multi-GB cache, forever.
describe("removeGradleUserHomeForWorktree", () => {
  it("deletes the worktree's gradle home", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "ak-gradle-wt-"));
    const home = gradleUserHomeForWorktree(worktree);
    mkdirSync(join(home, "caches"), { recursive: true });
    writeFileSync(join(home, "caches", "big.bin"), "x");
    expect(existsSync(home)).toBe(true);

    await expect(removeGradleUserHomeForWorktree(worktree)).resolves.toBe(true);
    expect(existsSync(home)).toBe(false);
  });

  it("is a no-op success when there is no home yet (never throws on teardown)", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "ak-gradle-wt-"));
    await expect(removeGradleUserHomeForWorktree(worktree)).resolves.toBe(true);
  });

  it("only ever targets a path under the gradle-homes root", () => {
    expect(gradleUserHomeForWorktree("/anything/at/all").startsWith(GRADLE_HOMES_ROOT)).toBe(true);
  });
});
