import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitExec, gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import {
  syncIncomingBranch,
  syncIncomingIntoWorktree,
  clearIncomingRef,
  isBranchCheckedOut,
  incomingRefFor,
} from "../services/worker-remote-sync.service.js";

const BRANCH = "feature/ak-1-sync";

describe("worker-remote-sync (phase 2)", () => {
  let repo: string;

  async function commit(message: string, file = "f.txt", content = message) {
    writeFileSync(join(repo, file), content + "\n");
    await gitExecOrThrow(["add", "."], { cwd: repo });
    await gitExecOrThrow(["commit", "-m", message], { cwd: repo });
    return (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: repo })).trim();
  }

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "sync-repo-"));
    await gitExecOrThrow(["init", "-b", "master", repo], {});
    await commit("base");
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("reports missing when the worker never pushed", async () => {
    const result = await syncIncomingBranch(repo, BRANCH);
    expect(result).toMatchObject({ ok: false, status: "missing" });
  });

  it("creates the branch from an incoming ref", async () => {
    const sha = await commit("worker work");
    await gitExecOrThrow(["update-ref", incomingRefFor(BRANCH), sha], { cwd: repo });
    await gitExecOrThrow(["reset", "--hard", "HEAD~1"], { cwd: repo });

    const result = await syncIncomingBranch(repo, BRANCH);
    expect(result).toMatchObject({ ok: true, status: "created", sha });
    const branchSha = await gitExecOrThrow(["rev-parse", `refs/heads/${BRANCH}`], { cwd: repo });
    expect(branchSha.trim()).toBe(sha);

    await clearIncomingRef(repo, BRANCH);
    const gone = await gitExec(["rev-parse", "--verify", incomingRefFor(BRANCH)], { cwd: repo });
    expect(gone.code).not.toBe(0);
  });

  it("fast-forwards an existing branch and is idempotent", async () => {
    const base = (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: repo })).trim();
    await gitExecOrThrow(["update-ref", `refs/heads/${BRANCH}`, base], { cwd: repo });
    const ahead = await commit("worker follow-up");
    await gitExecOrThrow(["update-ref", incomingRefFor(BRANCH), ahead], { cwd: repo });

    expect(await syncIncomingBranch(repo, BRANCH)).toMatchObject({ ok: true, status: "updated", sha: ahead });
    expect(await syncIncomingBranch(repo, BRANCH)).toMatchObject({ ok: true, status: "unchanged", sha: ahead });
  });

  it("refuses to move a diverged branch (never discards commits)", async () => {
    const base = (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: repo })).trim();
    const workerSha = await commit("worker side", "worker.txt");
    await gitExecOrThrow(["update-ref", incomingRefFor(BRANCH), workerSha], { cwd: repo });
    // The board's branch went a different way from the same base.
    await gitExecOrThrow(["reset", "--hard", base], { cwd: repo });
    const boardSha = await commit("board side", "board.txt");
    await gitExecOrThrow(["update-ref", `refs/heads/${BRANCH}`, boardSha], { cwd: repo });

    const result = await syncIncomingBranch(repo, BRANCH);
    expect(result).toMatchObject({ ok: false, status: "diverged" });
    const still = await gitExecOrThrow(["rev-parse", `refs/heads/${BRANCH}`], { cwd: repo });
    expect(still.trim()).toBe(boardSha);
  });

  it("refuses to move a branch checked out in a worktree, and syncs it in-tree instead", async () => {
    const base = (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: repo })).trim();
    const worktree = join(repo, "..", `sync-wt-${Date.now()}`);
    await gitExecOrThrow(["worktree", "add", "-b", BRANCH, worktree, base], { cwd: repo });
    try {
      expect(await isBranchCheckedOut(repo, BRANCH)).toBe(true);

      const ahead = await commit("worker ahead", "ahead.txt");
      await gitExecOrThrow(["update-ref", incomingRefFor(BRANCH), ahead], { cwd: repo });

      const refused = await syncIncomingBranch(repo, BRANCH);
      expect(refused).toMatchObject({ ok: false, status: "diverged" });
      expect(refused.ok === false && refused.error).toContain("checked out in a worktree");

      const inTree = await syncIncomingIntoWorktree(worktree, BRANCH);
      expect(inTree).toMatchObject({ ok: true, status: "updated", sha: ahead });
      const head = await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: worktree });
      expect(head.trim()).toBe(ahead);
    } finally {
      await gitExec(["worktree", "remove", "--force", worktree], { cwd: repo });
    }
  });
});
