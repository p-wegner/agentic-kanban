/**
 * #630 — the orphaned-worktree sweep only ever looked at the LEADING repo.
 *
 * `pruneOrphanedWorktrees` reconciles `project.repoPath` against the `workspaces` rows. For a
 * multi-repo project that leaves every SIBLING worktree unswept, and siblings are exactly where
 * the debris accumulates: an interrupted create leaves worktrees on disk with no workspace row
 * at all. Measured on `comet` (17 repos): 104 orphaned worktrees across 13 repos against ZERO
 * workspace rows, regenerating indefinitely because the monitor restarted the ticket each time
 * the server came back.
 *
 * The claims for a sibling repo live in per-workspace `repos` rows (worktree_path/branch),
 * not on the `workspaces` row, so "is this claimed?" has to be asked per repo path. These
 * tests cover that wiring; the classification itself is `orphaned-worktree-reconciler.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const reconcileMock = vi.fn();
vi.mock("../startup/orphaned-worktree-reconciler.js", () => ({
  reconcileOrphanedWorktrees: (...args: unknown[]) => reconcileMock(...args),
}));

const { pruneOrphanedSiblingWorktrees } = await import("../startup/startup-tasks.js");

/** Real directories, because the sweep skips a repo path that does not exist on disk. */
function realDirs(n: number): string[] {
  const base = mkdtempSync(join(tmpdir(), "kanban-sibling-sweep-"));
  const { mkdirSync } = require("node:fs") as typeof import("node:fs");
  return Array.from({ length: n }, (_, i) => {
    const d = join(base, `repo${i}`);
    mkdirSync(d, { recursive: true });
    return d;
  });
}

/** A `db` stand-in whose select chain resolves to the claim rows it was handed. */
function fakeDb(claims: unknown[] = []) {
  return {
    select: () => ({ from: () => ({ innerJoin: () => ({ where: async () => claims }) }) }),
  } as never;
}

const git = {} as never;
const project = { id: "p1", name: "comet" };

beforeEach(() => {
  vi.clearAllMocks();
  reconcileMock.mockResolvedValue({ removed: [], keptWithUnshippedWork: [] });
});

describe("sibling orphan sweep (#630)", () => {
  it("reconciles EVERY sibling repo, not just the leading one", async () => {
    const dirs = realDirs(3);
    const listRepos = vi.fn(async () =>
      dirs.map((path, i) => ({ id: `r${i}`, path, name: `repo${i}`, defaultBranch: "main" })),
    ) as never;

    await pruneOrphanedSiblingWorktrees(project, { database: fakeDb(), git, listRepos });

    expect(reconcileMock).toHaveBeenCalledTimes(3);
    expect(reconcileMock.mock.calls.map((c) => (c[0] as { repoPath: string }).repoPath).sort())
      .toEqual([...dirs].sort());
  });

  it("uses each repo's OWN default branch as the base, never the project's", async () => {
    const [a, b] = realDirs(2);
    const listRepos = vi.fn(async () => [
      { id: "r0", path: a, name: "api", defaultBranch: "develop" },
      { id: "r1", path: b, name: "web", defaultBranch: null },
    ]) as never;

    await pruneOrphanedSiblingWorktrees(project, { database: fakeDb(), git, listRepos });

    const bases = reconcileMock.mock.calls.map((c) => (c[0] as { baseBranch: string }).baseBranch);
    expect(bases).toEqual(["develop", "master"]); // null falls back, it does not skip the repo
  });

  it("passes the per-repo claim rows through, so a live sibling worktree is not treated as debris", async () => {
    const [a] = realDirs(1);
    const claims = [{ workingDir: `${a}/.worktrees/x`, branch: "feature/ak-1", status: "active" }];
    const listRepos = vi.fn(async () => [{ id: "r0", path: a, name: "api", defaultBranch: "main" }]) as never;

    await pruneOrphanedSiblingWorktrees(project, { database: fakeDb(claims), git, listRepos });

    expect((reconcileMock.mock.calls[0][0] as { claims: unknown[] }).claims).toEqual(claims);
  });

  it("skips a repo whose path no longer exists rather than failing the sweep", async () => {
    const [a] = realDirs(1);
    const listRepos = vi.fn(async () => [
      { id: "r0", path: a, name: "api", defaultBranch: "main" },
      { id: "r1", path: join(tmpdir(), "kanban-definitely-not-here-630"), name: "gone", defaultBranch: "main" },
    ]) as never;

    await pruneOrphanedSiblingWorktrees(project, { database: fakeDb(), git, listRepos });

    expect(reconcileMock).toHaveBeenCalledTimes(1);
  });

  it("keeps sweeping after one repo throws — a startup task must never abort mid-project", async () => {
    const dirs = realDirs(3);
    const listRepos = vi.fn(async () =>
      dirs.map((path, i) => ({ id: `r${i}`, path, name: `repo${i}`, defaultBranch: "main" })),
    ) as never;
    reconcileMock.mockImplementation(async (args: { repoPath: string }) => {
      if (args.repoPath === dirs[1]) throw new Error("git exploded");
      return { removed: [], keptWithUnshippedWork: [] };
    });

    await expect(
      pruneOrphanedSiblingWorktrees(project, { database: fakeDb(), git, listRepos }),
    ).resolves.toBeUndefined();
    expect(reconcileMock).toHaveBeenCalledTimes(3);
  });

  it("is a no-op for a single-repo project (no sibling rows at all)", async () => {
    const listRepos = vi.fn(async () => []) as never;
    await pruneOrphanedSiblingWorktrees(project, { database: fakeDb(), git, listRepos });
    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it("survives an unreadable repo list", async () => {
    const listRepos = vi.fn(async () => { throw new Error("db gone"); }) as never;
    await expect(
      pruneOrphanedSiblingWorktrees(project, { database: fakeDb(), git, listRepos }),
    ).resolves.toBeUndefined();
    expect(reconcileMock).not.toHaveBeenCalled();
  });
});
