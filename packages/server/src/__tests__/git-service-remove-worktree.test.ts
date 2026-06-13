import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

  it("does not delete junction target when recursively removing a worktree with a junction", async () => {
    // Create a separate source dir (simulates mainCheckout/node_modules) with a sentinel file
    const sourceDir = join(tempRoot, "source-main");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "sentinel.txt"), "must-survive\n");

    // Create the junction/symlink inside the worktree dir
    const junctionPath = join(worktreePath, "node_modules");
    if (process.platform === "win32") {
      await execFileAsync("cmd", ["/c", "mklink", "/J", junctionPath, sourceDir]);
    } else {
      await symlink(sourceDir, junctionPath, "dir");
    }

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

    // Worktree directory itself must be gone
    expect(existsSync(worktreePath)).toBe(false);
    // Junction target (source dir) and its sentinel file must be untouched
    expect(existsSync(sourceDir)).toBe(true);
    expect(existsSync(join(sourceDir, "sentinel.txt"))).toBe(true);
  });

  it("does not delete NESTED packages/<pkg>/node_modules junction targets when removing a worktree (#780)", async () => {
    // Simulate the "Dependency Symlinks" layout: the shared store lives in the main
    // checkout and is junctioned into the worktree at packages/<pkg>/node_modules.
    const sharedStore = join(tempRoot, "shared-pnpm-store");
    await mkdir(sharedStore, { recursive: true });
    await writeFile(join(sharedStore, "drizzle-orm.js"), "module.exports = {};\n");

    // Real (non-link) nested directory structure, then a nested junction inside it.
    const nestedParent = join(worktreePath, "packages", "server");
    await mkdir(nestedParent, { recursive: true });
    const nestedJunction = join(nestedParent, "node_modules");
    // Use fs.symlink with the "junction" type on Windows (real junction, same as the
    // bootstrap) — avoids shelling out through the mocked child_process.execFile.
    await symlink(sharedStore, nestedJunction, process.platform === "win32" ? "junction" : "dir");

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

    // Worktree directory itself must be gone
    expect(existsSync(worktreePath)).toBe(false);
    // The shared store behind the NESTED junction must be untouched
    expect(existsSync(sharedStore)).toBe(true);
    expect(existsSync(join(sharedStore, "drizzle-orm.js"))).toBe(true);
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
