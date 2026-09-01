/**
 * #361 — the worktree a merged unit left behind, which no existing sweeper could see.
 *
 * The fixture is the MEASURED kassenbuch state at the time of the ticket
 * (project `a745234f-a0e8-4d4a-829a-b0d226af902f`, board HEAD `2671306d2c`):
 *
 * ```
 * $ git worktree list
 * …/kassenbuch                    c747e8e [master]
 * …/.worktrees/ak-12  57338c4 [feature/ak-12-qa-datum-wird-als-iso-2026-03-15-angezei]
 * …/.worktrees/ak-6   401341b [feature/ak-6-pm-pipeline-6-9-code-generation-mvp-skel]
 * ```
 *
 * and all 20 workspace rows of the project carrying `working_dir = null`. That null is what made
 * both orphans unreachable: every prior sweeper (`pruneStaleWorktrees`, `listStaleWorktrees`,
 * `cleanup_project`, `pnpm cli -- cleanup`) selects `status='closed' AND working_dir IS NOT NULL`,
 * and finishing a merge nulls the column. So the assertion that matters is that a nulled
 * `working_dir` makes a worktree REMOVABLE here, not invisible.
 */
import { describe, expect, it, vi } from "vitest";
import {
  classifyWorktree,
  reconcileOrphanedWorktrees,
  describeUnshippedWork,
  type OrphanedWorktreeGitPort,
  type WorktreeClaimRow,
} from "../startup/orphaned-worktree-reconciler.js";

const REPO = "C:/projects/andrena/agentic-kanban-testprojects/kassenbuch";
const WT_BASE = "C:/projects/andrena/agentic-kanban-testprojects/.worktrees";
const WT6 = `${WT_BASE}/ak-6`;
const WT12 = `${WT_BASE}/ak-12`;
const BR6_SURVIVING = "feature/ak-6-pm-pipeline-6-9-code-generation-mvp-skel";
const BR12 = "feature/ak-12-qa-datum-wird-als-iso-2026-03-15-angezei";

/** The project's real workspace rows: every one merged/closed with workingDir already nulled. */
const KASSENBUCH_CLAIMS: WorktreeClaimRow[] = [
  // The step-6 workspace that actually merged — note its branch is the `…-skele` (slug A) one,
  // NOT the `…-skel` branch the surviving worktree sits on.
  { workingDir: null, branch: "feature/ak-6-pm-pipeline-69-code-generation-mvp-skele", status: "closed" },
  { workingDir: null, branch: "feature/ak-6-pm-pipeline-6-9-code-generation-mvp-skel-r2", status: "closed" },
  { workingDir: null, branch: BR12, status: "closed" },
];

function makeGit(overrides: Partial<OrphanedWorktreeGitPort> = {}): OrphanedWorktreeGitPort {
  return {
    listWorktrees: vi.fn(async () => [
      { path: REPO, branch: "master" },
      { path: WT12, branch: BR12 },
      { path: WT6, branch: BR6_SURVIVING },
    ]),
    removeWorktree: vi.fn(async () => {}),
    revParse: vi.fn(async () => "401341b"),
    // Both surviving branches are at/behind master, so nothing is unshipped.
    countUniqueCommits: vi.fn(async () => 0),
    getWorkingTreeDiff: vi.fn(async () => ""),
    // The fixture paths above are REAL paths from the #361 investigation. Without this the
    // suite consulted the actual filesystem: once a cleanup removed `.worktrees/ak-12`, the
    // fail-closed case stopped reaching `getWorkingTreeDiff` at all and started asserting the
    // opposite of its own name. Pin both worktrees as present so the probe is exercised.
    pathExists: vi.fn(() => true),
    ...overrides,
  };
}

/**
 * The workspace rows the shared removal guard reads (#735).
 *
 * Distinct from `claims` above on purpose: `claims` is what this reconciler classifies from
 * (project-scoped, and for the sibling sweep it comes from `repos` rather than `workspaces`),
 * while the guard runs its own UNFILTERED read over `workspaces`. One stub serves both of the
 * guard's queries — `selectWorkingDirClaims` keeps the rows with a non-empty `workingDir`,
 * `findLiveBranchHolders` keeps the ones whose `branch` matches — so a row set with all four
 * columns exercises whichever the guard reaches.
 */
type GuardRow = { id: string; status: string; workingDir: string | null; branch: string | null };

function guardDb(rows: GuardRow[] = []) {
  return {
    select: () => ({ from: () => ({ where: async () => rows }) }),
  } as never;
}

/** A guard read that throws — the DB hiccup that must never read as "safe to delete". */
function brokenGuardDb() {
  return {
    select: () => ({ from: () => ({ where: async () => { throw new Error("database is locked"); } }) }),
  } as never;
}

describe("#361: reconcileOrphanedWorktrees on the measured kassenbuch state", () => {
  it("removes BOTH orphans that every workingDir-keyed sweeper was blind to, and never the main checkout", async () => {
    const git = makeGit();

    const report = await reconcileOrphanedWorktrees({ repoPath: REPO, baseBranch: "master", claims: KASSENBUCH_CLAIMS, git, database: guardDb() });

    expect(report.removed.sort()).toEqual([WT12, WT6].sort());
    expect(report.keptWithUnshippedWork).toEqual([]);
    // The project's own checkout must never be handed to `worktree remove`.
    for (const call of vi.mocked(git.removeWorktree).mock.calls) expect(call[1]).not.toBe(REPO);
    expect(vi.mocked(git.removeWorktree)).toHaveBeenCalledTimes(2);
  });

  it("keeps an orphan whose branch still holds commits that never landed", async () => {
    // `countUniqueCommits > 0` = work on the branch that is not in master. Leaking a directory is
    // recoverable; `worktree remove --force`-ing away real commits is not.
    const git = makeGit({ countUniqueCommits: vi.fn(async (_r, _b, branch) => (branch === BR6_SURVIVING ? 3 : 0)) });

    const report = await reconcileOrphanedWorktrees({ repoPath: REPO, baseBranch: "master", claims: KASSENBUCH_CLAIMS, git, database: guardDb() });

    expect(report.keptWithUnshippedWork).toEqual([WT6]);
    expect(report.removed).toEqual([WT12]);
  });

  it("keeps an orphan with uncommitted edits", async () => {
    const git = makeGit({ getWorkingTreeDiff: vi.fn(async (p) => (p === WT6 ? "diff --git a/src/x.js b/src/x.js\n" : "")) });

    const report = await reconcileOrphanedWorktrees({ repoPath: REPO, baseBranch: "master", claims: KASSENBUCH_CLAIMS, git, database: guardDb() });

    expect(report.keptWithUnshippedWork).toEqual([WT6]);
  });

  it("fails CLOSED when git cannot be read — an unverifiable worktree is kept, not force-removed", async () => {
    const git = makeGit({ getWorkingTreeDiff: vi.fn(async () => { throw new Error("EBUSY"); }) });

    const report = await reconcileOrphanedWorktrees({ repoPath: REPO, baseBranch: "master", claims: KASSENBUCH_CLAIMS, git, database: guardDb() });

    expect(report.removed).toEqual([]);
    expect(report.keptWithUnshippedWork.sort()).toEqual([WT12, WT6].sort());
  });

  it("removes a worktree whose branch was deleted underneath it — nothing is left to hold work", async () => {
    // The `…-skele` shape: the branch that carried the work merged and was deleted, but its
    // worktree registration survived. `revParse` on the missing branch throws.
    const git = makeGit({
      listWorktrees: vi.fn(async () => [{ path: REPO, branch: "master" }, { path: WT6, branch: "feature/ak-6-gone" }]),
      revParse: vi.fn(async (_r, ref) => { if (ref === "feature/ak-6-gone") throw new Error("unknown revision"); return "c747e8e"; }),
    });

    const report = await reconcileOrphanedWorktrees({ repoPath: REPO, baseBranch: "master", claims: KASSENBUCH_CLAIMS, git, database: guardDb() });

    expect(report.removed).toEqual([WT6]);
  });

  it("does not spend git calls on the main checkout or a claimed worktree", async () => {
    const claims: WorktreeClaimRow[] = [{ workingDir: WT6, branch: BR6_SURVIVING, status: "closed" }, { workingDir: WT12, branch: BR12, status: "closed" }];
    const git = makeGit();

    const report = await reconcileOrphanedWorktrees({ repoPath: REPO, baseBranch: "master", claims, git, database: guardDb() });

    expect(report).toEqual({ removed: [], keptWithUnshippedWork: [], keptClaimed: [] });
    expect(vi.mocked(git.getWorkingTreeDiff)).not.toHaveBeenCalled();
    expect(vi.mocked(git.removeWorktree)).not.toHaveBeenCalled();
  });

  it("returns empty (never throws) when the repo cannot be listed", async () => {
    const git = makeGit({ listWorktrees: vi.fn(async () => { throw new Error("not a git repository"); }) });

    await expect(reconcileOrphanedWorktrees({ repoPath: REPO, baseBranch: "master", claims: [], git, database: guardDb() })).resolves.toEqual({ removed: [], keptWithUnshippedWork: [], keptClaimed: [] });
  });
});

/**
 * #735 — the removal is the shared guard's now, and the guard is a SUPERSET of what this
 * file's `claims` can see: its read is unfiltered by project, so a claim this reconciler's
 * project-scoped rows do not contain still stops the delete.
 *
 * These are not duplicates of the `classifyWorktree` cases below. There the claim is IN
 * `claims`; here `claims` says "orphaned" and the guard overrules it — which is the only
 * arrangement under which routing through the guard actually bought something.
 */
describe("#735: the shared guard has the last word on the removal", () => {
  it("REFUSES a worktree a live workspace shares by PATH, even when `claims` calls it orphaned", async () => {
    const git = makeGit();

    const report = await reconcileOrphanedWorktrees({
      repoPath: REPO, baseBranch: "master", claims: KASSENBUCH_CLAIMS, git,
      database: guardDb([{ id: "ws-live", status: "active", workingDir: WT6, branch: "unrelated" }]),
    });

    expect(report.removed).toEqual([WT12]);
    expect(report.keptClaimed).toEqual([WT6]);
    for (const call of vi.mocked(git.removeWorktree).mock.calls) expect(call[1]).not.toBe(WT6);
  });

  it("REFUSES a worktree whose BRANCH a live workspace holds with a nulled workingDir", async () => {
    // The absorbed strength: a completed merge nulls `working_dir`, so a path-keyed sharer
    // query sees nothing while the workspace is still live on the branch. This is the exact
    // case this reconciler was built for, and the guard now answers it too.
    const git = makeGit();

    const report = await reconcileOrphanedWorktrees({
      repoPath: REPO, baseBranch: "master", claims: KASSENBUCH_CLAIMS, git,
      database: guardDb([{ id: "ws-live", status: "active", workingDir: null, branch: BR6_SURVIVING }]),
    });

    expect(report.keptClaimed).toEqual([WT6]);
    expect(report.removed).toEqual([WT12]);
  });

  it("does NOT refuse when the branch holder is terminal — a closed row claims nothing", async () => {
    const git = makeGit();

    const report = await reconcileOrphanedWorktrees({
      repoPath: REPO, baseBranch: "master", claims: KASSENBUCH_CLAIMS, git,
      database: guardDb([{ id: "ws-done", status: "closed", workingDir: null, branch: BR6_SURVIVING }]),
    });

    expect(report.removed.sort()).toEqual([WT12, WT6].sort());
    expect(report.keptClaimed).toEqual([]);
  });

  // #859: the observed incident — a worktree deleted as "orphaned" while a workspace row
  // pointed at exactly that workingDir, and while its 48s provisioning was still in flight.
  // The reconciler's `claims` snapshot is project-scoped and read once per sweep, so the
  // guard itself must refuse (a) any workspace row naming the path, whatever its status,
  // and (b) any in-flight create marker (#630) owned by a live process.
  it("REFUSES a worktree ANY workspace row still names — terminal status included (#859)", async () => {
    const git = makeGit();

    const report = await reconcileOrphanedWorktrees({
      repoPath: REPO, baseBranch: "master", claims: KASSENBUCH_CLAIMS, git,
      // A closed row that still NAMES the path: invisible to `findLiveWorktreeSharers`
      // (not live) and — being outside the sweep's own claims — to `classifyWorktree`.
      database: guardDb([{ id: "ws-closed", status: "closed", workingDir: WT6, branch: null }]),
    });

    expect(report.keptClaimed).toEqual([WT6]);
    expect(report.removed).toEqual([WT12]);
    for (const call of vi.mocked(git.removeWorktree).mock.calls) expect(call[1]).not.toBe(WT6);
  });

  it("REFUSES a worktree an in-flight workspace create (live #630 marker) is still provisioning (#859)", async () => {
    const git = makeGit();

    // The marker row: no workspace row exists yet (workingDir/branch empty so neither
    // workspace-keyed read claims it), but `worktree_path` names WT6 and the owning pid is
    // alive — the exact window in which the incident's worktree was deleted.
    const marker = {
      id: "ws-in-flight", status: "provisioning", workingDir: null, branch: null,
      issueId: "issue-1", phase: "siblings", worktreePath: WT6, serverPid: process.pid,
    };

    const report = await reconcileOrphanedWorktrees({
      repoPath: REPO, baseBranch: "master", claims: KASSENBUCH_CLAIMS, git,
      database: guardDb([marker as never]),
    });

    expect(report.keptClaimed).toEqual([WT6]);
    expect(report.removed).toEqual([WT12]);
    for (const call of vi.mocked(git.removeWorktree).mock.calls) expect(call[1]).not.toBe(WT6);
  });

  it("does NOT let a DEAD process's provisioning marker block the sweep — crashed-create debris stays removable (#859)", async () => {
    const git = makeGit();

    // Same marker shape, but its owning process is gone. `reconcileAbandonedProvisioning`
    // depends on the sweep having removed the removable debris before it reports.
    const marker = {
      id: "ws-abandoned", status: "provisioning", workingDir: null, branch: null,
      issueId: "issue-1", phase: "siblings", worktreePath: WT6, serverPid: 999_999_999,
    };

    const report = await reconcileOrphanedWorktrees({
      repoPath: REPO, baseBranch: "master", claims: KASSENBUCH_CLAIMS, git,
      database: guardDb([marker as never]),
    });

    expect(report.removed.sort()).toEqual([WT12, WT6].sort());
    expect(report.keptClaimed).toEqual([]);
  });

  it("REFUSES every removal when the claim read itself fails — a locked DB is not a green light", async () => {
    const git = makeGit();

    const report = await reconcileOrphanedWorktrees({
      repoPath: REPO, baseBranch: "master", claims: KASSENBUCH_CLAIMS, git, database: brokenGuardDb(),
    });

    expect(report.removed).toEqual([]);
    expect(report.keptClaimed.sort()).toEqual([WT12, WT6].sort());
    expect(vi.mocked(git.removeWorktree)).not.toHaveBeenCalled();
  });
});

describe("#981: the kept-worktree message says WHICH kind of work, and base-ignored dirt is not work", () => {
  /** One unclaimed worktree, fully merged, with whatever dirt the test supplies. */
  function oneWorktree(overrides: Partial<OrphanedWorktreeGitPort>): OrphanedWorktreeGitPort {
    return makeGit({
      listWorktrees: vi.fn(async () => [
        { path: REPO, branch: "master" },
        { path: WT12, branch: BR12 },
      ]),
      ...overrides,
    });
  }

  it("an untracked file the BASE branch ignores does not pin the worktree — the measured ak-952 shape", async () => {
    // `.test-impact/` was gitignored by #954; a branch predating that entry carries the file
    // unignored, and the conflated probe kept the worktree as `unshipped_work` forever.
    const git = oneWorktree({
      getTrackedWorkingTreeDiff: vi.fn(async () => ""),
      listUntrackedFiles: vi.fn(async () => [".test-impact/outcomes.jsonl"]),
      filterIgnoredAtBase: vi.fn(async () => [".test-impact/outcomes.jsonl"]),
    });

    const report = await reconcileOrphanedWorktrees({
      repoPath: REPO, baseBranch: "master", claims: [], git, database: guardDb(),
    });

    expect(report.removed).toEqual([WT12]);
    expect(report.keptWithUnshippedWork).toEqual([]);
  });

  it("an untracked file the base does NOT ignore still keeps the worktree", async () => {
    const git = oneWorktree({
      getTrackedWorkingTreeDiff: vi.fn(async () => ""),
      listUntrackedFiles: vi.fn(async () => ["src/rescue-me.ts", ".test-impact/outcomes.jsonl"]),
      filterIgnoredAtBase: vi.fn(async () => [".test-impact/outcomes.jsonl"]),
    });

    const report = await reconcileOrphanedWorktrees({
      repoPath: REPO, baseBranch: "master", claims: [], git, database: guardDb(),
    });

    expect(report.removed).toEqual([]);
    expect(report.keptWithUnshippedWork).toEqual([WT12]);
  });

  it("a FAILING ignore filter keeps every untracked path — the error direction must not lose work", async () => {
    const git = oneWorktree({
      getTrackedWorkingTreeDiff: vi.fn(async () => ""),
      listUntrackedFiles: vi.fn(async () => [".test-impact/outcomes.jsonl"]),
      filterIgnoredAtBase: vi.fn(async () => { throw new Error("check-ignore exploded"); }),
    });

    const report = await reconcileOrphanedWorktrees({
      repoPath: REPO, baseBranch: "master", claims: [], git, database: guardDb(),
    });

    expect(report.removed).toEqual([]);
    expect(report.keptWithUnshippedWork).toEqual([WT12]);
  });

  it("tracked modifications still keep it, unchanged", async () => {
    const git = oneWorktree({
      getTrackedWorkingTreeDiff: vi.fn(async () => "diff --git a/src/x.ts b/src/x.ts\n"),
      listUntrackedFiles: vi.fn(async () => []),
    });

    const report = await reconcileOrphanedWorktrees({
      repoPath: REPO, baseBranch: "master", claims: [], git, database: guardDb(),
    });

    expect(report.keptWithUnshippedWork).toEqual([WT12]);
  });

  it("a port WITHOUT the #981 methods degrades to the conflated verdict, not to removal", async () => {
    const git = oneWorktree({ getWorkingTreeDiff: vi.fn(async () => "?? something\n") });

    const report = await reconcileOrphanedWorktrees({
      repoPath: REPO, baseBranch: "master", claims: [], git, database: guardDb(),
    });

    expect(report.keptWithUnshippedWork).toEqual([WT12]);
  });

  it("the message distinguishes unmerged commits from untracked-only dirt", () => {
    // The whole point of #981: the old sentence asserted the first for both, which is what
    // trained readers to ignore the notice.
    expect(describeUnshippedWork({ kind: "unmerged_commits", count: 3 })).toContain("3 commit(s)");
    const untracked = describeUnshippedWork({ kind: "untracked_only", files: [".test-impact/outcomes.jsonl"] });
    expect(untracked).toContain("NO unmerged commits");
    expect(untracked).toContain(".test-impact/outcomes.jsonl");
    expect(describeUnshippedWork({ kind: "dirty_tracked" })).toContain("tracked");
    expect(describeUnshippedWork({ kind: "detached_head" })).toContain("detached");
  });
});

describe("#361: classifyWorktree", () => {
  const base = { mainCheckoutPath: REPO, hasUnshippedWork: false };

  it("never classifies the project's own checkout as removable, whatever the paths look like", () => {
    expect(classifyWorktree({ ...base, worktreePath: REPO, worktreeBranch: "master", claims: [] })).toBe("main_checkout");
    // A trailing separator must not make the checkout look like a different directory —
    // `git worktree list` and the DB disagree about it on every platform.
    expect(classifyWorktree({ ...base, worktreePath: `${REPO}/`, worktreeBranch: "master", claims: [] })).toBe("main_checkout");
  });

  // Separator direction and drive-letter case are WINDOWS disagreements between
  // `git worktree list` and the DB, and `pathKey` reconciles them only on win32 — off it a
  // backslash is a filename character and case is significant. #828: this had never run
  // off Windows, where it fails.
  it.runIf(process.platform === "win32")(
    "reconciles separator direction and drive-letter case with the checkout (win32)",
    () => {
      expect(classifyWorktree({ ...base, worktreePath: "c:\\projects\\andrena\\agentic-kanban-testprojects\\kassenbuch\\", worktreeBranch: "master", claims: [] })).toBe("main_checkout");
    },
  );

  it("treats a nulled workingDir on a CLOSED workspace as no claim — the #361 blind spot", () => {
    expect(classifyWorktree({ ...base, worktreePath: WT6, worktreeBranch: BR6_SURVIVING, claims: KASSENBUCH_CLAIMS })).toBe("orphaned");
  });

  it("still protects a LIVE workspace on that branch whose workingDir was nulled", () => {
    // Inverting the blind spot must not make live work removable.
    for (const status of ["active", "idle", "running", "review"]) {
      expect(classifyWorktree({ ...base, worktreePath: WT6, worktreeBranch: BR6_SURVIVING, claims: [{ workingDir: null, branch: BR6_SURVIVING, status }] }), status).toBe("claimed");
    }
  });

  it("leaves a worktree a workspace row still names to pruneStaleWorktrees, whatever its status", () => {
    expect(classifyWorktree({ ...base, worktreePath: WT6, worktreeBranch: BR6_SURVIVING, claims: [{ workingDir: WT6, branch: "something-else", status: "closed" }] })).toBe("claimed");
  });

  it("does not let an empty branch string match an empty claim branch", () => {
    // A detached-HEAD worktree (no branch) must not be 'claimed' by a row with a null branch.
    expect(classifyWorktree({ ...base, worktreePath: WT6, worktreeBranch: "", claims: [{ workingDir: null, branch: null, status: "active" }] })).toBe("orphaned");
  });
});
