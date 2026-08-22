import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitExec, gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import {
  fastForwardBranchRef,
  syncIncomingIntoWorktree,
  syncIncomingBranch,
  findBranchWorktree,
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
    const result = await fastForwardBranchRef(repo, BRANCH);
    expect(result).toMatchObject({ ok: false, status: "missing" });
  });

  it("creates the branch from an incoming ref", async () => {
    const sha = await commit("worker work");
    await gitExecOrThrow(["update-ref", incomingRefFor(BRANCH), sha], { cwd: repo });
    await gitExecOrThrow(["reset", "--hard", "HEAD~1"], { cwd: repo });

    const result = await fastForwardBranchRef(repo, BRANCH);
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

    expect(await fastForwardBranchRef(repo, BRANCH)).toMatchObject({ ok: true, status: "updated", sha: ahead });
    expect(await fastForwardBranchRef(repo, BRANCH)).toMatchObject({ ok: true, status: "unchanged", sha: ahead });
  });

  it("refuses to move a diverged branch (never discards commits)", async () => {
    const base = (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: repo })).trim();
    const workerSha = await commit("worker side", "worker.txt");
    await gitExecOrThrow(["update-ref", incomingRefFor(BRANCH), workerSha], { cwd: repo });
    // The board's branch went a different way from the same base.
    await gitExecOrThrow(["reset", "--hard", base], { cwd: repo });
    const boardSha = await commit("board side", "board.txt");
    await gitExecOrThrow(["update-ref", `refs/heads/${BRANCH}`, boardSha], { cwd: repo });

    const result = await fastForwardBranchRef(repo, BRANCH);
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

      const refused = await fastForwardBranchRef(repo, BRANCH);
      expect(refused).toMatchObject({ ok: false, status: "held-by-worktree" });
      expect(refused.ok === false && refused.error).toContain("checked out in a worktree");

      const inTree = await syncIncomingIntoWorktree(worktree, BRANCH);
      expect(inTree).toMatchObject({ ok: true, status: "updated", sha: ahead });
      const head = await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: worktree });
      expect(head.trim()).toBe(ahead);
    } finally {
      await gitExec(["worktree", "remove", "--force", worktree], { cwd: repo });
    }
  });

  // #743 — the headline defect: a real workspace ALWAYS has its branch checked out in a
  // board worktree, so the ref-only sync was refused for every single true-remote build
  // and no remote result could ever land. These four cases pin the fix and its limits.
  describe("syncIncomingBranch (#743)", () => {
    it("LANDS a worker push onto a branch that a board worktree holds", async () => {
      const base = (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: repo })).trim();
      const worktree = join(repo, "..", `land-wt-${Date.now()}`);
      await gitExecOrThrow(["worktree", "add", "-b", BRANCH, worktree, base], { cwd: repo });
      try {
        // What a git-transport worker leaves behind: a commit under the incoming ref.
        const ahead = await commit("worker work", "from-worker.txt");
        await gitExecOrThrow(["update-ref", incomingRefFor(BRANCH), ahead], { cwd: repo });
        await gitExecOrThrow(["reset", "--hard", base], { cwd: repo });

        // Before the fix this was the ONLY call the exit path made, and it refused.
        expect(await fastForwardBranchRef(repo, BRANCH)).toMatchObject({ status: "held-by-worktree" });

        const landed = await syncIncomingBranch(repo, BRANCH);
        expect(landed).toMatchObject({ ok: true, status: "updated", via: "worktree", sha: ahead });

        // The REAL branch moved, which is what diff/review/merge read.
        const branchSha = await gitExecOrThrow(["rev-parse", `refs/heads/${BRANCH}`], { cwd: repo });
        expect(branchSha.trim()).toBe(ahead);
        // ...and the worktree the builder is attached to sees the file.
        const inTree = await gitExecOrThrow(["show", `${BRANCH}:from-worker.txt`], { cwd: repo });
        expect(inTree).toContain("worker work");
        const head = await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: worktree });
        expect(head.trim()).toBe(ahead);
        // A diff against the base is non-empty — the board can now review this.
        const changed = await gitExecOrThrow(["diff", "--name-only", `${base}..refs/heads/${BRANCH}`], { cwd: repo });
        expect(changed).toContain("from-worker.txt");
      } finally {
        await gitExec(["worktree", "remove", "--force", worktree], { cwd: repo });
      }
    });

    it("uses the plain ref path when no worktree holds the branch", async () => {
      const base = (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: repo })).trim();
      await gitExecOrThrow(["update-ref", `refs/heads/${BRANCH}`, base], { cwd: repo });
      const ahead = await commit("worker work");
      await gitExecOrThrow(["update-ref", incomingRefFor(BRANCH), ahead], { cwd: repo });
      expect(await syncIncomingBranch(repo, BRANCH)).toMatchObject({ ok: true, via: "ref", sha: ahead });
    });

    it("still HOLDS a genuine divergence — it is not a force-push path (decision 012)", async () => {
      const base = (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: repo })).trim();
      const workerSha = await commit("worker side", "worker.txt");
      await gitExecOrThrow(["update-ref", incomingRefFor(BRANCH), workerSha], { cwd: repo });
      await gitExecOrThrow(["reset", "--hard", base], { cwd: repo });
      const boardSha = await commit("board side", "board.txt");
      const worktree = join(repo, "..", `land-div-${Date.now()}`);
      await gitExecOrThrow(["worktree", "add", "-b", BRANCH, worktree, boardSha], { cwd: repo });
      try {
        const held = await syncIncomingBranch(repo, BRANCH);
        expect(held.ok).toBe(false);
        expect(held.status).toBe("diverged");
        // Neither the branch nor the staging ref was touched.
        expect((await gitExecOrThrow(["rev-parse", `refs/heads/${BRANCH}`], { cwd: repo })).trim()).toBe(boardSha);
        expect((await gitExecOrThrow(["rev-parse", incomingRefFor(BRANCH)], { cwd: repo })).trim()).toBe(workerSha);
      } finally {
        await gitExec(["worktree", "remove", "--force", worktree], { cwd: repo });
      }
    });

    it("finds the worktree holding a branch, and nothing when none does", async () => {
      const base = (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: repo })).trim();
      expect(await findBranchWorktree(repo, BRANCH)).toBeNull();
      const worktree = join(repo, "..", `find-wt-${Date.now()}`);
      await gitExecOrThrow(["worktree", "add", "-b", BRANCH, worktree, base], { cwd: repo });
      try {
        const found = await findBranchWorktree(repo, BRANCH);
        expect(found).toBeTruthy();
        // Compare resolved paths: git reports its own normalization of the path.
        expect(found!.replace(/\\/g, "/").toLowerCase()).toContain(
          worktree.split(/[\\/]/).pop()!.toLowerCase(),
        );
      } finally {
        await gitExec(["worktree", "remove", "--force", worktree], { cwd: repo });
      }
    });
  });
});
