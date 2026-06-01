import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import { removeWorktree } from "../services/git.service.js";

describe("git service removeWorktree cleanup fallback", () => {
  let repoPath: string;
  let worktreePath: string;

  beforeEach(async () => {
    execFileMock.mockReset();
    repoPath = await mkdtemp(join(tmpdir(), "kanban-remove-worktree-repo-"));
    worktreePath = await mkdtemp(join(tmpdir(), "kanban-remove-worktree-leftover-"));
    await mkdir(join(worktreePath, "node_modules", ".cache"), { recursive: true });
    await writeFile(join(worktreePath, "node_modules", ".cache", "generated.txt"), "leftover\n");
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
    await rm(worktreePath, { recursive: true, force: true });
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
});
