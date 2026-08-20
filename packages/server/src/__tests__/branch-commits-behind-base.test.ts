/**
 * Regression test for issue #365 — real git, no mocks.
 *
 * `workspaceHasCommits()` / `hasCommittedChanges()` used to ask
 * `git diff --quiet <base>`. With a SINGLE ref that is a diff of the WORKING TREE against
 * the base branch TIP, so it exits non-zero — "has changes" — for a workspace that has made
 * ZERO commits of its own and is merely BEHIND its base. Such workspaces were reported as
 * having commits and parked at ready_for_merge, stalling their pipeline unit (#363), and the
 * #629 guard could not catch it because it re-checked with the same predicate.
 *
 * These tests pin the observable difference between the two predicates on a real repo.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
// #539: the implementation moved into the shared git-service (the SSOT for git ops);
// `commitsAhead` is `getCommitCountAhead`, which gained the `headRef` parameter that
// kept the server-side duplicate alive.
import { getCommitCountAhead as commitsAhead, hasCommitsAhead } from "@agentic-kanban/shared/lib/git-service";

async function git(args: string[], cwd: string): Promise<void> {
  const res = await gitExec(args, { cwd });
  if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.error?.message}`);
}

describe("branch-commits: a branch BEHIND its base has no commits (#365)", () => {
  let repo: string;
  let worktree: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "kanban-ak365-"));
    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "t@example.com"], repo);
    await git(["config", "user.name", "T"], repo);
    await writeFile(join(repo, "README.md"), "# base\n");
    await git(["add", "README.md"], repo);
    await git(["commit", "-m", "initial"], repo);

    // A workspace branch cut from main that commits NOTHING.
    worktree = join(repo, "wt-empty");
    await git(["worktree", "add", "-b", "feature/empty", worktree, "main"], repo);

    // Now move the base ahead, so the worktree is strictly BEHIND main.
    await writeFile(join(repo, "base-moved.txt"), "base advanced\n");
    await git(["add", "base-moved.txt"], repo);
    await git(["commit", "-m", "base moves ahead"], repo);
  }, 60000);

  afterAll(async () => {
    try {
      await git(["worktree", "remove", "--force", worktree], repo);
    } catch { /* best effort */ }
    await rm(repo, { recursive: true, force: true }).catch(() => {});
  });

  it("the OLD predicate (`git diff --quiet <base>`) wrongly reports changes", async () => {
    // This is the bug, asserted so nobody reintroduces the predicate believing it equivalent.
    const res = await gitExec(["diff", "--quiet", "main"], { cwd: worktree });
    expect(res.code).not.toBe(0);
  });

  it("counts zero commits ahead for a branch that only fell behind", async () => {
    expect(await commitsAhead(worktree, "main")).toBe(0);
    expect(await hasCommitsAhead(worktree, "main")).toBe(false);
  });

  it("still sees a real commit once the workspace makes one", async () => {
    await writeFile(join(worktree, "work.txt"), "agent work\n");
    await git(["add", "work.txt"], worktree);
    await git(["commit", "-m", "agent work"], worktree);
    expect(await commitsAhead(worktree, "main")).toBe(1);
    expect(await hasCommitsAhead(worktree, "main")).toBe(true);
  });

  it("ignores uncommitted working-tree edits — the question is commits, not dirt", async () => {
    await writeFile(join(worktree, "uncommitted.txt"), "not committed\n");
    // one real commit from the previous test, and nothing more
    expect(await commitsAhead(worktree, "main")).toBe(1);
  });

  it("reads an unanswerable count as 'has commits' rather than discarding work", async () => {
    expect(await commitsAhead(worktree, "no/such/ref")).toBeNull();
    expect(await hasCommitsAhead(worktree, "no/such/ref")).toBe(true);
  });
});
