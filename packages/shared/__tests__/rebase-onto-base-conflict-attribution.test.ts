/**
 * `rebaseOntoBase` must not report another rebase's conflicts (#274).
 *
 * Observed live while driving the merge queue: it skipped TWO unrelated workspaces with the
 * IDENTICAL reason — `rebase conflict: packages/shared/__tests__/plugin-manifest.test.ts,
 * packages/shared/src/lib/dynamic-preference-keys.ts, packages/shared/src/lib/plugin-manifest.ts`.
 * Neither branch touched any of those three files; they were exactly the files a different
 * ticket had landed on master earlier the same day. Read-only `merge-tree` at the same
 * moment showed one of the two merged perfectly clean, and the other conflicted in a single
 * different file. So the queue refused mergeable work and pointed conflict resolution at the
 * wrong files.
 *
 * The mechanism: a rebase left IN PROGRESS by an earlier attempt (its `--abort` had failed on
 * `index.lock`) makes the next `git rebase` fail immediately, and the unmerged index entries
 * `git diff --diff-filter=U` then reports belong to THAT earlier attempt, against a base that
 * has since moved. `prepareForReview` always aborted first; this path did not.
 *
 * In-progress state is simulated the way git actually expresses it — a `rebase-merge`
 * directory next to the git dir — so the real `isRebaseInProgress` runs rather than a stub of
 * it. `execGit` is the only seam.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const GIT_DIR = "/worktree/.git";

/** Whether a rebase is "in progress"; flipped by the handlers below, as git would. */
let rebaseInProgress = false;

const execGitMock = vi.fn(async (_args: string[], _cwd: string): Promise<string> => "");

vi.mock("../src/lib/git-service/internal.js", () => ({
  execGit: (args: string[], cwd: string) => execGitMock(args, cwd),
}));
vi.mock("../src/lib/git-service/branch-attach.js", () => ({
  ensureOnBranch: vi.fn(async () => {}),
}));
vi.mock("node:fs", () => ({
  existsSync: (p: string) => rebaseInProgress && String(p).includes("rebase-merge"),
}));

const { rebaseOntoBase } = await import("../src/lib/git-service/rebase.js");

/** Route execGit by git subcommand, so each test states intent rather than call order. */
function routeGit(handlers: Record<string, (args: string[]) => string>) {
  execGitMock.mockImplementation(async (args: string[]) => {
    if (args[0] === "rev-parse" && args[1] === "--absolute-git-dir") return GIT_DIR;
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (args.slice(0, 2).join(" ").startsWith(prefix) || args[0] === prefix) return handler(args);
    }
    return "";
  });
}

/**
 * The base is NOT yet integrated into the branch — i.e. there is genuinely something to
 * rebase. `git merge-base --is-ancestor` signals its answer through the EXIT CODE, so "no"
 * is a throw. Without this the #933 already-integrated guard reads the mock's default
 * empty-success as "yes, already integrated" and skips the rebase these tests are about.
 */
const BASE_NOT_INTEGRATED = {
  "merge-base": (args: string[]) => {
    if (args[1] === "--is-ancestor") throw new Error("exit 1: not an ancestor");
    return "mergebasesha";
  },
};

const CLEAN_TREE = { ...BASE_NOT_INTEGRATED, "status --porcelain": () => "", "rev-parse": () => "sha" };

describe("rebaseOntoBase conflict attribution (#274)", () => {
  beforeEach(() => {
    execGitMock.mockReset();
    execGitMock.mockResolvedValue("");
    rebaseInProgress = false;
  });

  it("aborts a rebase left in progress by an earlier attempt before starting", async () => {
    rebaseInProgress = true;
    const aborts: string[][] = [];
    routeGit({
      ...CLEAN_TREE,
      rebase: (args) => {
        if (args[1] === "--abort") { aborts.push(args); rebaseInProgress = false; return ""; }
        return "";
      },
    });

    const result = await rebaseOntoBase("/worktree", "master", "feature/x");

    expect(aborts).toHaveLength(1);
    expect(result.success).toBe(true);
  });

  it("reports the STUCK rebase, not a file list, when the abort itself fails", async () => {
    // An `index.lock` held by another git process is the usual cause — and is exactly the
    // state that produced the phantom list. Naming files here would be a fabrication.
    rebaseInProgress = true;
    routeGit({
      ...CLEAN_TREE,
      rebase: (args) => {
        if (args[1] === "--abort") throw new Error("fatal: cannot rebase: index.lock exists");
        return "";
      },
      diff: () => "packages/shared/src/lib/plugin-manifest.ts\n",
    });

    const result = await rebaseOntoBase("/worktree", "master", "feature/x");

    expect(result.success).toBe(false);
    expect(result.conflictingFiles).toBeUndefined();
    expect(result.error).toContain("could not be aborted");
    expect(result.error).toContain("index.lock");
  });

  it("does NOT name unmerged files when the failing rebase never actually started", async () => {
    routeGit({
      ...CLEAN_TREE,
      rebase: (args) => {
        if (args[1] === "--abort") return "";
        // Fails without entering a rebase — so nothing in the index is attributable to it.
        throw new Error("fatal: invalid upstream 'master'");
      },
      // Would be the phantom list if it were consulted.
      diff: () => "packages/shared/src/lib/plugin-manifest.ts\n",
    });

    const result = await rebaseOntoBase("/worktree", "master", "feature/x");

    expect(result.success).toBe(false);
    expect(result.conflictingFiles).toBeUndefined();
    expect(result.error).toContain("invalid upstream");
  });

  it("still reports the conflicting files of a REAL conflict", async () => {
    routeGit({
      ...CLEAN_TREE,
      rebase: (args) => {
        if (args[1] === "--abort") { rebaseInProgress = false; return ""; }
        rebaseInProgress = true; // git stops mid-rebase, exactly as on a real conflict
        throw new Error("could not apply abc1234");
      },
      diff: () => "packages/server/src/__tests__/merge-queue.service.test.ts\n",
    });

    const result = await rebaseOntoBase("/worktree", "master", "feature/x");

    expect(result.success).toBe(false);
    expect(result.conflictingFiles).toEqual(["packages/server/src/__tests__/merge-queue.service.test.ts"]);
  });

  it("#933 skips the rebase entirely when the base is already an ancestor of HEAD", async () => {
    // The state fix-and-merge leaves behind: it resolved the conflict by MERGING the base into
    // the branch. Replaying the branch's raw pre-resolution commits would re-hit that same
    // conflict forever, so the rebase must not run at all.
    const rebases: string[][] = [];
    routeGit({
      "status --porcelain": () => "",
      "rev-parse": () => "sha",
      "merge-base": () => "", // --is-ancestor succeeds => base IS already integrated
      rebase: (args) => { rebases.push(args); return ""; },
    });

    const result = await rebaseOntoBase("/worktree", "master", "feature/x");

    expect(result.success).toBe(true);
    expect(result.conflictingFiles).toBeUndefined();
    expect(rebases.filter((a) => a[1] !== "--abort")).toEqual([]);
  });

  it("carries the tips the verdict was computed against, so a stale one is visible", async () => {
    routeGit({
      ...CLEAN_TREE,
      "rev-parse": (args) => (args[1] === "HEAD" ? "branchsha1234567" : "basesha7654321"),
      rebase: (args) => {
        if (args[1] === "--abort") return "";
        rebaseInProgress = true;
        throw new Error("could not apply abc1234");
      },
      diff: () => "a.ts\n",
    });

    const result = await rebaseOntoBase("/worktree", "master", "feature/x");

    expect(result.branchSha).toBe("branchsha1234567");
    expect(result.baseSha).toBe("basesha7654321");
  });
});
