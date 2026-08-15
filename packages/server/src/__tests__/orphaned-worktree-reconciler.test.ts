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

describe("#361: reconcileOrphanedWorktrees on the measured kassenbuch state", () => {
  it("removes BOTH orphans that every workingDir-keyed sweeper was blind to, and never the main checkout", async () => {
    const git = makeGit();

    const report = await reconcileOrphanedWorktrees({ repoPath: REPO, baseBranch: "master", claims: KASSENBUCH_CLAIMS, git });

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

    const report = await reconcileOrphanedWorktrees({ repoPath: REPO, baseBranch: "master", claims: KASSENBUCH_CLAIMS, git });

    expect(report.keptWithUnshippedWork).toEqual([WT6]);
    expect(report.removed).toEqual([WT12]);
  });

  it("keeps an orphan with uncommitted edits", async () => {
    const git = makeGit({ getWorkingTreeDiff: vi.fn(async (p) => (p === WT6 ? "diff --git a/src/x.js b/src/x.js\n" : "")) });

    const report = await reconcileOrphanedWorktrees({ repoPath: REPO, baseBranch: "master", claims: KASSENBUCH_CLAIMS, git });

    expect(report.keptWithUnshippedWork).toEqual([WT6]);
  });

  it("fails CLOSED when git cannot be read — an unverifiable worktree is kept, not force-removed", async () => {
    const git = makeGit({ getWorkingTreeDiff: vi.fn(async () => { throw new Error("EBUSY"); }) });

    const report = await reconcileOrphanedWorktrees({ repoPath: REPO, baseBranch: "master", claims: KASSENBUCH_CLAIMS, git });

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

    const report = await reconcileOrphanedWorktrees({ repoPath: REPO, baseBranch: "master", claims: KASSENBUCH_CLAIMS, git });

    expect(report.removed).toEqual([WT6]);
  });

  it("does not spend git calls on the main checkout or a claimed worktree", async () => {
    const claims: WorktreeClaimRow[] = [{ workingDir: WT6, branch: BR6_SURVIVING, status: "closed" }, { workingDir: WT12, branch: BR12, status: "closed" }];
    const git = makeGit();

    const report = await reconcileOrphanedWorktrees({ repoPath: REPO, baseBranch: "master", claims, git });

    expect(report).toEqual({ removed: [], keptWithUnshippedWork: [] });
    expect(vi.mocked(git.getWorkingTreeDiff)).not.toHaveBeenCalled();
    expect(vi.mocked(git.removeWorktree)).not.toHaveBeenCalled();
  });

  it("returns empty (never throws) when the repo cannot be listed", async () => {
    const git = makeGit({ listWorktrees: vi.fn(async () => { throw new Error("not a git repository"); }) });

    await expect(reconcileOrphanedWorktrees({ repoPath: REPO, baseBranch: "master", claims: [], git })).resolves.toEqual({ removed: [], keptWithUnshippedWork: [] });
  });
});

describe("#361: classifyWorktree", () => {
  const base = { mainCheckoutPath: REPO, hasUnshippedWork: false };

  it("never classifies the project's own checkout as removable, whatever the paths look like", () => {
    expect(classifyWorktree({ ...base, worktreePath: REPO, worktreeBranch: "master", claims: [] })).toBe("main_checkout");
    // Windows: `git worktree list` and the DB disagree on separators and drive-letter case.
    expect(classifyWorktree({ ...base, worktreePath: "c:\\projects\\andrena\\agentic-kanban-testprojects\\kassenbuch\\", worktreeBranch: "master", claims: [] })).toBe("main_checkout");
  });

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
