// @gate:always-run - spawns the .claude/hooks Stop hook script and drives real git repos,
// so it reaches state outside its own import graph and import-graph scoping cannot see it.
/**
 * #770 — the Stop hook must call a file dirty only when its CONTENT differs.
 *
 * Observed in the field: the hook listed `packages/server/src/worker/worker-repo.ts` as STRANDED
 * and told the session to commit it while the worktree blob and the index blob were byte-identical
 * (`ebe8e79f…` on both sides); `git diff` for the path was empty and `git add` staged nothing. The
 * instruction was therefore to make an empty commit — and the tempting way to "make it go away" in
 * a shared checkout is `git add`-ing a wider pathspec, which is exactly how another agent's staged
 * work gets swept into the wrong commit.
 *
 * The fix replaces the `git status --porcelain` (index-state) question with the two TREE
 * comparisons `git diff --name-status HEAD` (worktree vs HEAD) and `git diff --cached
 * --name-status HEAD` (index vs HEAD). A path whose content equals HEAD's cannot appear in either.
 *
 * NOTE on testability: a contemporary `git status` also refreshes the index and content-compares,
 * so the stat-cache divergence the ticket observed cannot be manufactured on demand in a temp repo
 * (verified: an identical-byte rewrite, a future mtime, and a present `index.lock` all leave
 * `status` clean here). That is why `trackedSourceChanges` takes an injectable git runner — the
 * invariant is pinned deterministically at that seam, and the real-repo cases below cover the
 * ordinary path.
 */
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { readFileSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const requireCjs = createRequire(import.meta.url);
const hookPath = resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  ".claude",
  "hooks",
  "check-uncommitted.js",
);
type Changes = { edited: string[]; deleted: string[]; all: string[] };
const { trackedSourceChanges, porcelainSourceChanges, classifyStranded } = requireCjs(hookPath) as {
  trackedSourceChanges: (cwd: string, run?: (args: string[]) => string | null) => Changes;
  porcelainSourceChanges: (cwd: string) => Changes;
  classifyStranded: (c: Changes) => { action: string };
};

const NUL = "\0";
const A = "packages/server/src/worker/worker-repo.ts";

async function git(cwd: string, args: string[]): Promise<void> {
  await new Promise<void>((res, reject) =>
    execFile("git", args, { cwd }, (err) => (err ? reject(err) : res())),
  );
}

async function writeFileIn(repo: string, rel: string, body: string): Promise<void> {
  const p = join(repo, rel);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, body);
}

describe("check-uncommitted hook — dirty detection is content-based (#770)", () => {
  it("reports NOTHING when both content diffs are empty, whatever the stat cache says", () => {
    // The observed state: index blob == worktree blob == HEAD blob. Both tree comparisons are
    // empty, so no path may be reported — this is the case that produced "commit a no-op".
    const changes = trackedSourceChanges("irrelevant", () => "");
    expect(changes.all).toEqual([]);
    expect(classifyStranded(changes)).toEqual({ action: "ok" });
  });

  it("asks git for TREE comparisons, never for `status --porcelain`", () => {
    // This is the case that goes red on a revert to the porcelain implementation: it neither
    // consulted an injected runner nor asked a content question. `git status` reports index
    // STATE (which a stale stat entry, a mode flip or a type change satisfies with identical
    // bytes); `git diff [--cached] HEAD` compares TREES.
    const asked: string[][] = [];
    trackedSourceChanges("x", (args) => {
      asked.push(args);
      return "";
    });
    expect(asked).toEqual([
      ["diff", "--name-status", "-z", "HEAD"],
      ["diff", "--cached", "--name-status", "-z", "HEAD"],
    ]);
    expect(asked.flat()).not.toContain("--porcelain");
  });

  it("still reports a worktree edit, a staged-only edit, a deletion and a rename target", () => {
    const worktreeEdit = trackedSourceChanges("x", (args) =>
      args.includes("--cached") ? "" : `M${NUL}${A}${NUL}`,
    );
    expect(worktreeEdit.edited).toEqual([A]);

    // Staged then reverted in the worktree: worktree-vs-HEAD alone would miss it, so the
    // `--cached` half is not optional — a commit here WOULD change the tree.
    const stagedOnly = trackedSourceChanges("x", (args) =>
      args.includes("--cached") ? `M${NUL}${A}${NUL}` : "",
    );
    expect(stagedOnly.edited).toEqual([A]);

    const deleted = trackedSourceChanges("x", (args) =>
      args.includes("--cached") ? "" : `D${NUL}${A}${NUL}`,
    );
    expect(deleted.deleted).toEqual([A]);
    expect(classifyStranded(deleted).action).toBe("restore");

    // A rename must count as ONE edit at the new path, never as a deletion — otherwise a
    // rename-heavy branch trips the deletion-dominant "restore" verdict.
    const renamed = trackedSourceChanges("x", (args) =>
      args.includes("--cached")
        ? ""
        : `R100${NUL}packages/server/src/old.ts${NUL}packages/server/src/new.ts${NUL}`,
    );
    expect(renamed).toMatchObject({ edited: ["packages/server/src/new.ts"], deleted: [] });
  });

  it("does not double-count a path that both content diffs report", () => {
    const changes = trackedSourceChanges("x", () => `M${NUL}${A}${NUL}`);
    expect(changes.all).toEqual([A]);
  });

  it("ignores non-source paths in the content diff, as the porcelain parser did", () => {
    const changes = trackedSourceChanges("x", (args) =>
      args.includes("--cached") ? "" : `M${NUL}docs/state.md${NUL}M${NUL}pnpm-lock.yaml${NUL}`,
    );
    expect(changes.all).toEqual([]);
  });

  it("falls back when EITHER content diff fails, not only when both do (#1006)", async () => {
    // The gate failure this pins: `trackedSourceChanges returned [] instead of the changed file`
    // on a box under memory pressure. `gitOut` swallows its spawn timeout into `null`, so one
    // `git diff` blowing the budget while the other answers fast used to yield the successful
    // half's answer as the WHOLE answer — a silent, confident "clean" for a dirty tree, which is
    // strictly worse than the both-failed case because nothing looks wrong.
    const repo = await mkdtemp(join(tmpdir(), "ak-1006-partial-"));
    try {
      await git(repo, ["init", "-q", "-b", "main"]);
      await git(repo, ["config", "user.email", "t@e.com"]);
      await git(repo, ["config", "user.name", "T"]);
      await writeFileIn(repo, A, "export const a = 1;\n");
      await git(repo, ["add", "-A"]);
      await git(repo, ["commit", "-q", "-m", "seed"]);
      await writeFileIn(repo, A, "export const a = 2;\n");

      // Worktree half times out (null), staged half succeeds and is legitimately empty.
      const worktreeFailed = trackedSourceChanges(repo, (args) =>
        args.includes("--cached") ? "" : null,
      );
      expect(worktreeFailed.all).toEqual([A]);

      // And the mirror image: staged half times out, worktree half answers.
      const stagedFailed = trackedSourceChanges(repo, (args) =>
        args.includes("--cached") ? null : "",
      );
      expect(stagedFailed.all).toEqual([A]);
    } finally {
      await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  it("falls back to the porcelain answer when git cannot diff at all (never goes silent)", async () => {
    // `run` returning null for both = no HEAD, or git unusable. Over-reporting is recoverable;
    // silence is not, so the legacy stat-cache classifier is the fallback rather than `[]`.
    const repo = await mkdtemp(join(tmpdir(), "ak-770-fallback-"));
    try {
      await git(repo, ["init", "-q", "-b", "main"]);
      await git(repo, ["config", "user.email", "t@e.com"]);
      await git(repo, ["config", "user.name", "T"]);
      await writeFileIn(repo, A, "export const a = 1;\n");
      await git(repo, ["add", "-A"]);
      await git(repo, ["commit", "-q", "-m", "seed"]);
      await writeFileIn(repo, A, "export const a = 2;\n");
      expect(trackedSourceChanges(repo, () => null).all).toEqual([A]);
      expect(porcelainSourceChanges(repo).all).toEqual([A]);
    } finally {
      await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});

describe("check-uncommitted hook — real repo, content vs metadata (#770)", () => {
  let repo = "";
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "ak-770-repo-"));
    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["config", "user.email", "t@e.com"]);
    await git(repo, ["config", "user.name", "T"]);
    await writeFileIn(repo, A, "export const a = 1;\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "seed"]);
  });
  afterEach(async () => {
    // #1006 — retry the removal. Every child here is a synchronous `execFile`/`spawn` that has
    // already exited, so an EPERM is Windows closing the last `.git` handle asynchronously, not a
    // holder to diagnose. Left unretried it fails a test whose assertions passed.
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("a tracked file rewritten with IDENTICAL bytes is neither stranded nor in-flight", async () => {
    // The ticket's third acceptance case: touching a tracked file without changing its bytes
    // must leave the hook silent. (`git status` is also clean here on this git build, so this
    // case documents the invariant rather than reproducing the original divergence.)
    await writeFileIn(repo, A, "export const a = 1;\n");
    expect(trackedSourceChanges(repo).all).toEqual([]);
  });

  it("a real byte change is still reported", async () => {
    await writeFileIn(repo, A, "export const a = 2; // changed\n");
    expect(trackedSourceChanges(repo).all).toEqual([A]);
  });

  it("a change staged and then reverted in the worktree is still reported", async () => {
    await writeFileIn(repo, A, "export const a = 2;\n");
    await git(repo, ["add", A]);
    await writeFileIn(repo, A, "export const a = 1;\n"); // back to HEAD's bytes
    expect(trackedSourceChanges(repo).all).toEqual([A]);
  });

  it("the hook SCRIPT exits 0 on an identical-bytes rewrite and 1 on a real edit", async () => {
    // End-to-end through the wired script, with the hook copied into the fixture so it resolves
    // the fixture as its main checkout.
    mkdirSync(join(repo, ".claude", "hooks"), { recursive: true });
    const copied = join(repo, ".claude", "hooks", "check-uncommitted.js");
    writeFileSync(copied, readFileSync(hookPath, "utf8"));

    const run = () =>
      new Promise<number | null>((res, reject) => {
        const child = spawn(process.execPath, [copied], {
          cwd: repo,
          stdio: ["pipe", "ignore", "ignore"],
        });
        child.on("error", reject);
        child.on("close", (c) => res(c));
        child.stdin!.end(JSON.stringify({ session_id: "no-such-session" }));
      });

    await writeFileIn(repo, A, "export const a = 1;\n"); // identical bytes, fresh mtime
    expect(await run()).toBe(0);

    await writeFileIn(repo, A, "export const a = 3;\n");
    // Age the edit past #884's fresh-foreign window: a just-written file with no strong
    // attribution is deliberately not demanded (it may be another live session's hand);
    // past the window the real edit returns to stranded, which is what this test pins.
    const agedSec = (Date.now() - 3 * 60 * 1000) / 1000;
    utimesSync(join(repo, A), agedSec, agedSec);
    expect(await run()).toBe(1);
  });
});
