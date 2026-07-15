// @covers projects.register.cloneUrl [config]
//
// Clone-from-URL registration (server deployments): repos land under a configurable
// repos root instead of requiring a pre-existing local path. These tests cover the
// pure parts — URL → directory-name derivation and repos-root resolution; the actual
// `git clone` is exercised by registering a real repo in integration/verification.

import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneRepo, getReposRoot, repoDirNameFromUrl } from "../services/repo-clone.service.js";
import { DATA_DIR } from "../db/data-dir.js";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";

vi.mock("@agentic-kanban/shared/lib/git-exec", () => ({
  gitExecOrThrow: vi.fn(),
}));

describe("repoDirNameFromUrl", () => {
  it("uses the URL basename minus .git", () => {
    expect(repoDirNameFromUrl("https://github.com/user/my-repo.git")).toBe("my-repo");
    expect(repoDirNameFromUrl("https://github.com/user/my-repo")).toBe("my-repo");
    expect(repoDirNameFromUrl("git@github.com:user/my-repo.git")).toBe("my-repo");
  });

  it("survives trailing slashes and sanitizes unsafe characters", () => {
    expect(repoDirNameFromUrl("https://example.com/group/repo/")).toBe("repo");
    expect(repoDirNameFromUrl("https://example.com/we ird&name.git")).toBe("we-ird-name");
  });

  it("rejects URLs it cannot derive a name from", () => {
    expect(() => repoDirNameFromUrl("https://example.com/...")).toThrow(/Cannot derive/);
  });
});

describe("getReposRoot", () => {
  const saved = process.env.KANBAN_REPOS_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.KANBAN_REPOS_DIR;
    else process.env.KANBAN_REPOS_DIR = saved;
  });

  it("prefers KANBAN_REPOS_DIR", () => {
    process.env.KANBAN_REPOS_DIR = join("some", "explicit", "root");
    expect(getReposRoot()).toBe(join("some", "explicit", "root"));
  });

  it("falls back to <data dir>/repos", () => {
    delete process.env.KANBAN_REPOS_DIR;
    expect(getReposRoot()).toBe(join(DATA_DIR, "repos"));
  });
});

describe("cloneRepo failure cleanup", () => {
  const savedRoot = process.env.KANBAN_REPOS_DIR;
  let root: string;

  afterEach(() => {
    if (savedRoot === undefined) delete process.env.KANBAN_REPOS_DIR;
    else process.env.KANBAN_REPOS_DIR = savedRoot;
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
    vi.mocked(gitExecOrThrow).mockReset();
  });

  it("removes the partial target dir it created when the clone fails, so a retry is not blocked", async () => {
    root = mkdtempSync(join(tmpdir(), "kanban-repo-clone-test-"));
    process.env.KANBAN_REPOS_DIR = root;
    vi.mocked(gitExecOrThrow).mockImplementation(async (args) => {
      const target = args[args.length - 1];
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, ".git"), "partial");
      throw new Error("simulated timeout/kill mid-clone");
    });

    await expect(cloneRepo("https://example.com/some-repo.git")).rejects.toThrow(
      "simulated timeout/kill mid-clone",
    );

    const target = join(root, "some-repo");
    expect(existsSync(target)).toBe(false);

    // Retry must not be blocked by the previous attempt's leftovers.
    vi.mocked(gitExecOrThrow).mockResolvedValue("");
    await expect(cloneRepo("https://example.com/some-repo.git")).resolves.toBe(target);
  });

  it("does not delete a pre-existing empty target dir when the clone fails", async () => {
    root = mkdtempSync(join(tmpdir(), "kanban-repo-clone-test-"));
    process.env.KANBAN_REPOS_DIR = root;
    const target = join(root, "some-repo");
    mkdirSync(target, { recursive: true });
    vi.mocked(gitExecOrThrow).mockRejectedValue(new Error("simulated failure"));

    await expect(cloneRepo("https://example.com/some-repo.git")).rejects.toThrow("simulated failure");

    expect(existsSync(target)).toBe(true);
  });
});
