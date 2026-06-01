import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import { deleteBranch, removeWorktree } from "../services/git.service.js";

describe("git service removeWorktree cleanup fallback", () => {
  let tempRoot: string;
  let repoPath: string;
  let worktreePath: string;

  beforeEach(async () => {
    execFileMock.mockReset();
    tempRoot = await mkdtemp(join(tmpdir(), "kanban-remove-worktree-"));
    repoPath = join(tempRoot, "repo");
    worktreePath = join(tempRoot, ".worktrees", "leftover");
    await mkdir(repoPath, { recursive: true });
    await mkdir(join(worktreePath, "node_modules", ".cache"), { recursive: true });
    await writeFile(join(worktreePath, "node_modules", ".cache", "generated.txt"), "leftover\n");
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("removes a non-empty directory left behind when git worktree remove fails", async () => {
    execFileMock.mockImplementation((_cmd, args, _opts, callback) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        callback(new Error("git worktree remove failed"), "", "fatal: Directory not empty");
        return;
      }
      if (args[0] === "worktree" && args[1] === "prune") {
        callback(null, "", "");
        return;
      }
      callback(new Error(`unexpected git args: ${args.join(" ")}`), "", "");
    });

    await expect(removeWorktree(repoPath, worktreePath)).resolves.toBeUndefined();

    expect(existsSync(worktreePath)).toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock.mock.calls[0][1]).toEqual(["worktree", "remove", "--force", worktreePath]);
    expect(execFileMock.mock.calls[1][1]).toEqual(["worktree", "prune"]);
  });

  it("does not recursively remove paths outside the managed worktrees directory", async () => {
    const unsafePath = join(tempRoot, "not-a-managed-worktree");
    await mkdir(join(unsafePath, "important"), { recursive: true });
    await writeFile(join(unsafePath, "important", "data.txt"), "keep\n");

    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(new Error("git worktree remove failed"), "", "fatal: not a working tree");
    });

    await expect(removeWorktree(repoPath, unsafePath)).rejects.toThrow(
      "Refusing to recursively remove unsafe worktree path",
    );

    expect(existsSync(join(unsafePath, "important", "data.txt"))).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("cleans up an already-merged worktree missing .git before retrying branch deletion", async () => {
    execFileMock.mockImplementation((_cmd, args, _opts, callback) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        callback(
          new Error("git worktree remove failed"),
          "",
          `fatal: validation failed, cannot remove working tree: '${worktreePath}/.git' does not exist`,
        );
        return;
      }
      if (args[0] === "branch" && args[1] === "-d") {
        if (execFileMock.mock.calls.filter((call) => call[1]?.[0] === "branch").length === 1) {
          callback(
            new Error("git branch failed"),
            "",
            `error: Cannot delete branch 'feature/ak-1-test' checked out at '${worktreePath}'`,
          );
          return;
        }
        callback(null, "", "");
        return;
      }
      if (args[0] === "worktree" && args[1] === "prune") {
        callback(null, "", "");
        return;
      }
      callback(new Error(`unexpected git args: ${args.join(" ")}`), "", "");
    });

    await expect(removeWorktree(repoPath, worktreePath)).resolves.toBeUndefined();
    await expect(deleteBranch(repoPath, "feature/ak-1-test")).resolves.toBeUndefined();

    expect(existsSync(worktreePath)).toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(5);
    expect(execFileMock.mock.calls[0][1]).toEqual(["worktree", "remove", "--force", worktreePath]);
    expect(execFileMock.mock.calls[1][1]).toEqual(["worktree", "prune"]);
    expect(execFileMock.mock.calls[2][1]).toEqual(["branch", "-d", "feature/ak-1-test"]);
    expect(execFileMock.mock.calls[3][1]).toEqual(["worktree", "prune"]);
    expect(execFileMock.mock.calls[4][1]).toEqual(["branch", "-d", "feature/ak-1-test"]);
  });
});
