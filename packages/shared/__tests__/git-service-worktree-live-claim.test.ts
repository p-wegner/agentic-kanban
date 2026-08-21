// #699 — createWorktree recursively DELETED a live worktree and the uncommitted work in it.
//
// Measured on the dev board: two worktree directories (`ak-697`, `ak-670`) were left as
// empty shells with no git registration, and the agent working in one watched its own
// checkout dissolve over ~15 minutes. That is what a recursive delete looks like from
// inside: children go in sorted order — dotfiles (`.git`, `.claude`) first, so the agent
// loses its repository before anything else — and on Windows the final rmdir fails while
// the agent's CWD is inside, leaving exactly an empty directory behind.
//
// The leftover-cleanup that deletes it had two guards and BOTH asked git:
// `isRegisteredWorktreePath` (is it in `git worktree list`?) and `isForeignCheckout`
// (does its `.git` point elsewhere?). Git is the authority that has already failed in the
// only case that matters — a live worktree whose `.git` file has become unreadable is
// unregistered AND has no `.git`, so it reads as "a plain leftover directory". Worse,
// `createWorktree` calls `pruneWorktrees()` on its first line and captures the list it
// checks against afterwards, so it emptied the evidence it was about to consult.
//
// Two independent guards now cover it, and each is pinned separately below:
//  1. the registration list is captured BEFORE the prune;
//  2. an optional `isPathClaimed` port lets a caller answer from the DB, which is the only
//     source that still knows the path belongs to a non-terminal workspace.
// Neither refuses the call — both fall through to the numeric-suffix path that already
// existed for the locked-directory case.

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorktree } from "../src/lib/git-service.js";

const GIT_IO_TIMEOUT_MS = Number(process.env.VITEST_GIT_IO_TIMEOUT) || 120_000;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolvePromise(stdout.toString());
    });
  });
}

const WORK = "work the agent has not committed yet\n";

describe("createWorktree never deletes a LIVE worktree (#699)", () => {
  let parent: string;
  let repo: string;
  let livePath: string;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "ak-wt-live-claim-"));
    repo = join(parent, "app");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init"]);
    await writeFile(join(repo, "app.txt"), "marker\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "initial commit"]);
    await git(repo, ["branch", "-M", "main"]);

    // A live worktree for issue 999, holding uncommitted work.
    livePath = await createWorktree(repo, "feature/ak-999-original-slug", "main");
    await writeFile(join(livePath, "uncommitted.txt"), WORK);
  }, GIT_IO_TIMEOUT_MS);

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  /**
   * The trigger is a SECOND branch that sanitizes to the same `ak-999` leaf — i.e. two
   * workspaces for one issue, which is a shape the board can produce (#673). The first
   * worktree's `.git` is removed to model the damaged-but-live state; without it the
   * pre-prune capture below is never exercised, because git would simply keep the
   * registration and the old guard would already hold.
   */
  it("keeps a live worktree whose .git file is damaged, because the registration list is read BEFORE the prune", async () => {
    await unlink(join(livePath, ".git"));

    const second = await createWorktree(repo, "feature/ak-999-different-slug", "main");

    expect(resolve(second)).not.toBe(resolve(livePath));
    expect(existsSync(join(livePath, "uncommitted.txt"))).toBe(true);
    expect(readFileSync(join(livePath, "uncommitted.txt"), "utf8")).toBe(WORK);
  }, GIT_IO_TIMEOUT_MS);

  /**
   * The DB guard covers what the pre-prune capture cannot: a registration lost during an
   * EARLIER call, so it is already absent when this one starts. Modelled by pruning first,
   * which is precisely the state the earlier call would have left behind.
   */
  it("keeps a directory a live workspace claims, even with the registration already gone", async () => {
    await unlink(join(livePath, ".git"));
    await git(repo, ["worktree", "prune"]);

    const asked: string[] = [];
    const second = await createWorktree(repo, "feature/ak-999-different-slug", "main", {
      isPathClaimed: (candidate) => {
        asked.push(candidate);
        return resolve(candidate) === resolve(livePath);
      },
    });

    expect(asked.map((p) => resolve(p))).toContain(resolve(livePath));
    expect(resolve(second)).not.toBe(resolve(livePath));
    expect(existsSync(join(livePath, "uncommitted.txt"))).toBe(true);
  }, GIT_IO_TIMEOUT_MS);

  /**
   * The guard must not turn every leftover into a permanent squatter — the cleanup exists
   * because a merged/closed workspace really does leave a directory behind, and a claim
   * check that answered "yes" for those would leak a suffixed path per creation.
   */
  it("still reclaims an UNCLAIMED leftover directory at the target path", async () => {
    const leftover = join(parent, ".worktrees", "app", "ak-1000");
    await mkdir(leftover, { recursive: true });
    await writeFile(join(leftover, "stale.txt"), "from a closed workspace\n");

    const wt = await createWorktree(repo, "feature/ak-1000-fresh", "main", {
      isPathClaimed: () => false,
    });

    expect(resolve(wt)).toBe(resolve(leftover));
    expect(existsSync(join(leftover, "stale.txt"))).toBe(false);
    expect(existsSync(join(wt, "app.txt"))).toBe(true);
  }, GIT_IO_TIMEOUT_MS);
});
