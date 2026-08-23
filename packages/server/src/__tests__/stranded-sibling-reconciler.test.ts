// @covers workspaces.multiRepo.strandedSiblingReconciler [git]
//
// Startup reconciler for the multi-repo crash gap (review finding #18): the merge
// pipeline stamps mergedAt + closes the workspace BEFORE the sibling merges run, so a
// crash in that window strands sibling repos unmerged with the issue marked Done — and
// no other startup task sees them. reconcileStrandedSiblingMerges detects the persisted
// progress state (repos rows with mergedHeadSha NULL on a mergedAt-stamped workspace),
// git-verifies the strand, lands it via the guarded sibling pipeline, and records
// everything on the issue. Real temp git repos + real test DB.
//
// Deliberately carries no always-run gate marker (#778 considered it; the token itself is
// not spelled here, because `always-run-marker-ratchet.test.ts` scans for the literal and
// would read a mention as a claim). That marker's criterion is
// "reaches state outside its own import graph", and this suite reaches nothing of the kind
// — it imports `reconcileStrandedSiblingMerges` (and transitively git-exec) directly, so
// scoped test selection already picks it up whenever the code it guards changes. The
// compensator's 5-minute production cadence is an argument about blast radius, not about
// import-graph blindness, and force-marking on that basis would erode the one property that
// keeps the always-run set from drifting back into a hand-maintained list.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { __resetGitExecSchedulerForTests } from "@agentic-kanban/shared/lib/git-exec";
import { projects, workspaces, issues, projectStatuses, issueComments } from "@agentic-kanban/shared/schema";
import * as gitService from "../services/git.service.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { insertWorkspaceRepo, listWorkspaceRepos, setWorkspaceRepoMergedSha } from "../repositories/repo.repository.js";
import { reconcileStrandedSiblingMerges } from "../startup/merge-workflow.js";
import type { Database } from "../db/index.js";

function exec(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.toString());
    });
  });
}

async function createTempRepo(prefix: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  const dir = join(parent, "repo");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir);
  await exec("git", ["init"], dir);
  await writeFile(join(dir, "README.md"), "# Test\n");
  await exec("git", ["add", "."], dir);
  await exec("git", ["commit", "-m", "Initial commit"], dir);
  await exec("git", ["branch", "-M", "main"], dir);
  return dir;
}

/**
 * Commit through the raw `git` CLI — deliberately NOT through the git-exec adapter, because
 * that is what production looks like: the commits a reconciler observes were made by an
 * AGENT in a worktree, i.e. by another process entirely.
 *
 * Which is why it also drops the adapter's read-dedupe memo (#398, `GIT_DEDUPE_MEMO_TTL_MS`
 * = 1.5s). That memo is invalidated by adapter-driven mutations only; an out-of-band commit
 * is bounded purely by the TTL. Production is safe on that margin — the stranded-sibling
 * compensator ticks every 5 MINUTES — but this test compresses four ticks into ~2 seconds,
 * so without the reset tick 3 re-reads tick 2's memoized `rev-list --count` and `merge-tree`
 * and cannot see the new blocker at all. That is what made the #737 over-suppression test
 * red from the day it landed (#778): the signature was never the problem, the elapsed time
 * the test failed to simulate was.
 */
async function commitFile(dir: string, file: string, content: string, message: string): Promise<void> {
  await writeFile(join(dir, file), content);
  await exec("git", ["add", "."], dir);
  await exec("git", ["commit", "-m", message], dir);
  __resetGitExecSchedulerForTests();
}

const BRANCH = "feature/strand";

let db: TestDb;
let siblingRepo: string;
let projectId: string;
let issueId: string;
let workspaceId: string;
const cleanupDirs: string[] = [];

beforeEach(async () => {
  ({ db } = createTestDb());
  siblingRepo = await createTempRepo("kanban-strand-sib-");
  cleanupDirs.push(siblingRepo);

  const now = new Date().toISOString();
  projectId = randomUUID();
  await db.insert(projects).values({ id: projectId, name: "p", repoPath: "/lead", repoName: "lead", defaultBranch: "main" });
  const statusId = randomUUID();
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "Done", sortOrder: 3, createdAt: now });
  issueId = randomUUID();
  await db.insert(issues).values({ id: issueId, projectId, statusId, title: "t", issueNumber: 180 });
  workspaceId = randomUUID();
  // The crash aftermath: leading merged (mergedAt stamped), workspace closed, workingDir nulled.
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: BRANCH, workingDir: null, baseBranch: "main",
    status: "closed", mergedAt: now, closedAt: now,
  });
}, 60000);

afterEach(async () => {
  while (cleanupDirs.length) {
    const dir = cleanupDirs.pop()!;
    try { await rm(join(dir, ".."), { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

async function insertStrandedSibling(): Promise<string> {
  const worktreePath = await gitService.createWorktree(siblingRepo, BRANCH, "main");
  await commitFile(worktreePath, "change.txt", "stranded work\n", "feat: stranded sibling change");
  await insertWorkspaceRepo({
    workspaceId, projectId, path: siblingRepo, name: "sibling",
    worktreePath, branch: BRANCH, baseBranch: "main",
  }, db);
  return worktreePath;
}

async function commentsForIssue(): Promise<{ body: string }[]> {
  return db.select({ body: issueComments.body }).from(issueComments).where(eq(issueComments.issueId, issueId));
}

describe("reconcileStrandedSiblingMerges (#18)", () => {
  it("lands a stranded sibling merge, stamps the row, cleans up, and records it on the issue", async () => {
    await insertStrandedSibling();

    const result = await reconcileStrandedSiblingMerges(db as unknown as Database);
    expect(result).toEqual({ landed: 1, preserved: 0 });

    // The stranded work landed on the sibling's base branch.
    const log = await exec("git", ["log", "--oneline", "main"], siblingRepo);
    expect(log).toContain("stranded sibling change");

    // Progress state stamped, and the now-merged sibling branch/worktree cleaned.
    const [row] = await listWorkspaceRepos(workspaceId, db);
    expect(row.mergedHeadSha).toMatch(/^[0-9a-f]{40}$/);
    const branches = await exec("git", ["branch", "--list", BRANCH], siblingRepo);
    expect(branches.trim()).toBe("");

    // Loud on the issue timeline.
    const comments = await commentsForIssue();
    expect(comments.some((c) => /landed 1 sibling repo merge/i.test(c.body))).toBe(true);

    // Idempotent: a second run finds nothing pending.
    const second = await reconcileStrandedSiblingMerges(db as unknown as Database);
    expect(second).toEqual({ landed: 0, preserved: 0 });
    // 240s, not 90s: this drives REAL git across two repos plus a worktree, twice (the
    // idempotency re-run). Measured at 110s while the pre-merge gate's own vitest fleet was
    // saturating the machine, which timed it out at 90s and — because a red gate withholds
    // EVERY merge board-wide (#206) — deadlocked the board on a test whose work had actually
    // succeeded. Same reasoning as #174 raising append-only-hotfile-merge 30s -> 120s.
  }, 240000);

  it("preserves the sibling branch and records the blocker when the strand cannot land (conflict)", async () => {
    const worktreePath = await insertStrandedSibling();
    // Conflicting edits on the sibling branch vs its main.
    await commitFile(worktreePath, "README.md", "# branch version\n", "feat: branch edit");
    await commitFile(siblingRepo, "README.md", "# main version\n", "feat: main edit");

    const result = await reconcileStrandedSiblingMerges(db as unknown as Database);
    expect(result).toEqual({ landed: 0, preserved: 1 });

    // Nothing destroyed.
    const branches = await exec("git", ["branch", "--list", BRANCH], siblingRepo);
    expect(branches.trim()).not.toBe("");
    const mainLog = await exec("git", ["log", "--oneline", "main"], siblingRepo);
    expect(mainLog).not.toContain("branch edit");

    // The gap is DETECTABLE: recorded loudly on the issue.
    const comments = await commentsForIssue();
    expect(comments.some((c) => /Multi-repo merge INCOMPLETE/.test(c.body))).toBe(true);
    // Same real-git-under-load reasoning as the case above.
  }, 240000);

  it("does not re-post the same conflict comment on every tick, but DOES report a genuine change (#737)", async () => {
    const worktreePath = await insertStrandedSibling();
    // Conflicting edits on the sibling branch vs its main — a strand that can never land.
    await commitFile(worktreePath, "README.md", "# branch version\n", "feat: branch edit");
    await commitFile(siblingRepo, "README.md", "# main version\n", "feat: main edit");

    // #151 put this reconciler on the ancestor reconciler's 5-minute cadence, so "one tick"
    // is not a boot — it repeats forever. An unchanged strand must be announced ONCE.
    await reconcileStrandedSiblingMerges(db as unknown as Database);
    expect(await commentsForIssue()).toHaveLength(1);

    await reconcileStrandedSiblingMerges(db as unknown as Database);
    expect(await commentsForIssue()).toHaveLength(1);

    // ...but suppressing a REAL change would be worse than the duplication: a second
    // conflicting file is a different blocker and must reach the timeline.
    await commitFile(worktreePath, "extra.txt", "branch extra\n", "feat: branch extra");
    await commitFile(siblingRepo, "extra.txt", "main extra\n", "feat: main extra");

    await reconcileStrandedSiblingMerges(db as unknown as Database);
    const after = await commentsForIssue();
    expect(after).toHaveLength(2);
    expect(after.filter((c) => /Multi-repo merge INCOMPLETE/.test(c.body))).toHaveLength(2);
    // The genuine change is not merely COUNTED — the new comment must name the new
    // blocker, which is what makes it worth reaching the timeline at all (#778).
    expect(after[0].body).toContain("README.md");
    expect(after[0].body).not.toContain("extra.txt");
    expect(after[1].body).toContain("extra.txt");

    // And that new state is itself only reported once.
    await reconcileStrandedSiblingMerges(db as unknown as Database);
    expect(await commentsForIssue()).toHaveLength(2);
    // Same real-git-under-load reasoning as the cases above (four reconciler passes).
  }, 240000);

  // #793: the residue #778 left behind. The guard MESSAGE names only the first five
  // conflicting files and elides the rest into "…", so two conflict sets agreeing on their
  // first five render byte-identically. Deriving the signature from the message alone
  // therefore suppresses a genuine change of blocker whenever the movement is confined to
  // the sixth-and-beyond file.
  //
  // The confounder this case has to remove is `uniqueCommits`: in the #737 case above the
  // new blocker arrives as a NEW branch commit, which moves `strandPendingParts` and would
  // change the signature regardless. Here the branch commit is AMENDED, so the branch stays
  // exactly one commit ahead of main across both ticks and the ONLY thing that moves is the
  // identity of the seventh conflicting file — which the elided message cannot express.
  it("reports a change confined to the SEVENTH conflicting file, which the elided message hides (#793)", async () => {
    const worktreePath = await insertStrandedSibling();
    const files = ["c1.txt", "c2.txt", "c3.txt", "c4.txt", "c5.txt", "c6.txt", "c7.txt"];

    // main's side of every conflict, including the two candidate seventh files.
    for (const f of [...files, "c8.txt"]) await writeFile(join(siblingRepo, f), `main ${f}\n`);
    await exec("git", ["add", "."], siblingRepo);
    await exec("git", ["commit", "-m", "feat: main side of the conflicts"], siblingRepo);
    __resetGitExecSchedulerForTests();

    // The branch's side: seven add/add conflicts, in ONE commit on top of the strand.
    for (const f of files) await writeFile(join(worktreePath, f), `branch ${f}\n`);
    await exec("git", ["add", "."], worktreePath);
    await exec("git", ["commit", "-m", "feat: branch side of the conflicts"], worktreePath);
    __resetGitExecSchedulerForTests();

    await reconcileStrandedSiblingMerges(db as unknown as Database);
    const first = await commentsForIssue();
    expect(first.filter((c) => /Multi-repo merge INCOMPLETE/.test(c.body))).toHaveLength(1);
    const firstBlocker = first[first.length - 1].body;
    // The message really is elided — this is the property that makes the case bite.
    expect(firstBlocker).toContain("c1.txt");
    expect(firstBlocker).toContain("…");
    expect(firstBlocker).not.toContain("c7.txt");

    // AMEND the branch commit so the seventh conflicting file becomes c8.txt instead of
    // c7.txt: same commit count, same first five files, same rendered message.
    await rm(join(worktreePath, "c7.txt"));
    await writeFile(join(worktreePath, "c8.txt"), "branch c8.txt\n");
    await exec("git", ["add", "-A"], worktreePath);
    await exec("git", ["commit", "--amend", "--no-edit"], worktreePath);
    __resetGitExecSchedulerForTests();

    await reconcileStrandedSiblingMerges(db as unknown as Database);
    const second = await commentsForIssue();
    expect(second.filter((c) => /Multi-repo merge INCOMPLETE/.test(c.body))).toHaveLength(2);
    // ...and the elision is exactly why the two bodies are indistinguishable: the timeline
    // entry exists because the SIGNATURE moved, not because the text did.
    expect(second[second.length - 1].body).toBe(firstBlocker);

    // The new blocker state is itself announced only once (#737 stays closed).
    await reconcileStrandedSiblingMerges(db as unknown as Database);
    expect((await commentsForIssue()).filter((c) => /Multi-repo merge INCOMPLETE/.test(c.body))).toHaveLength(2);
    // Same real-git-under-load reasoning as the cases above (three reconciler passes).
  }, 240000);

  it("is a no-op when the sibling merge already landed (mergedHeadSha stamped)", async () => {
    await insertStrandedSibling();
    const [row] = await listWorkspaceRepos(workspaceId, db);
    await setWorkspaceRepoMergedSha(row.id, "0000000000000000000000000000000000000000", db);

    const result = await reconcileStrandedSiblingMerges(db as unknown as Database);
    expect(result).toEqual({ landed: 0, preserved: 0 });
    expect(await commentsForIssue()).toEqual([]);
  }, 60000);

  it("is a no-op for a sibling row with no commits ahead (not a strand)", async () => {
    const worktreePath = await gitService.createWorktree(siblingRepo, BRANCH, "main");
    await insertWorkspaceRepo({
      workspaceId, projectId, path: siblingRepo, name: "sibling",
      worktreePath, branch: BRANCH, baseBranch: "main",
    }, db);

    const result = await reconcileStrandedSiblingMerges(db as unknown as Database);
    expect(result).toEqual({ landed: 0, preserved: 0 });
    expect(await commentsForIssue()).toEqual([]);
  }, 60000);
});
