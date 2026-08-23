/**
 * #631 — the Worktrees panel could not see a single sibling worktree.
 *
 * `GET /api/projects/:id/worktrees` ran `listWorktrees(project.repoPath)` — the leading repo
 * only. On `comet` the panel read "Worktrees (1) — No additional worktrees" while 104 orphaned
 * sibling worktrees existed across 13 repos. The panel that exists to surface exactly that
 * debris was structurally unable to see it, and `DELETE` had the same scope, so the cleanup
 * action could not reclaim them either — they had to be removed by hand, per repo.
 *
 * The "no board workspace" verdict is the part with no prior equivalent: a sibling's link to
 * its workspace lives on the per-workspace `repos` row, not on `workspaces.working_dir`, so
 * without reading those rows every sibling looked unowned and the panel could not tell a
 * healthy multi-repo workspace from debris.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const listWorktreesMock = vi.fn();
const removeWorktreeMock = vi.fn();
const listProjectReposMock = vi.fn();
const getWorkspaceRepoClaimsMock = vi.fn();
const getProjectByIdMock = vi.fn();

vi.mock("../services/git.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/git.service.js")>()),
  listWorktrees: (...a: unknown[]) => listWorktreesMock(...a),
  removeWorktree: (...a: unknown[]) => removeWorktreeMock(...a),
}));
vi.mock("../repositories/repo.repository.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../repositories/repo.repository.js")>()),
  listProjectRepos: (...a: unknown[]) => listProjectReposMock(...a),
  getWorkspaceRepoClaims: (...a: unknown[]) => getWorkspaceRepoClaimsMock(...a),
}));
vi.mock("../repositories/project.repository.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../repositories/project.repository.js")>()),
  getProjectById: (...a: unknown[]) => getProjectByIdMock(...a),
}));

const LEADING = "C:\\projects\\comet\\documentation";
const API = "C:\\projects\\comet\\admin-cockpit-backend";
const API_WT = "C:\\projects\\comet\\.worktrees\\admin-cockpit-backend\\ak-1";

beforeEach(() => {
  vi.clearAllMocks();
  getProjectByIdMock.mockResolvedValue({ id: "p1", repoPath: LEADING, defaultBranch: "main" });
  listProjectReposMock.mockResolvedValue([]);
  getWorkspaceRepoClaimsMock.mockResolvedValue([]);
  removeWorktreeMock.mockResolvedValue(undefined);
  listWorktreesMock.mockImplementation(async (repoPath: string) => [{ path: repoPath, branch: "refs/heads/main" }]);
});

/**
 * The service is a factory over injected collaborators; only `getWorktrees`/`removeWorktreeById`
 * matter here.
 *
 * `from().where()` (no join) is the shape `removeWorktreeUnlessShared`'s claim query uses since
 * #735 routed the delete through the guard. `workingDirClaims` seeds it, so a test can put a
 * live sharer in front of the delete; the default is "nothing claims anything".
 */
async function service(workingDirClaims: { id: string; status: string; workingDir: string }[] = []) {
  const { createProjectService } = await import("../services/project.service.js");
  return createProjectService({
    database: {
      select: () => ({
        from: () => ({
          // #815 made this read a LEFT join onto the diff-stat memo. The chain mock has to
          // grow the same link or every call through it dies with "leftJoin is not a
          // function" — `where` stays reachable directly so a caller that stops at the
          // inner join still works.
          innerJoin: () => ({
            where: async () => [],
            leftJoin: () => ({ where: async () => [] }),
          }),
          where: async () => workingDirClaims,
        }),
      }),
    },
  } as never);
}

describe("worktrees endpoint spans every repo (#631)", () => {
  it("lists SIBLING worktrees, which it could not see at all", async () => {
    listProjectReposMock.mockResolvedValue([{ id: "r0", path: API, name: "admin-cockpit-backend" }]);
    listWorktreesMock.mockImplementation(async (repoPath: string) =>
      repoPath === API
        ? [{ path: API, branch: "refs/heads/master" }, { path: API_WT, branch: "refs/heads/feature/ak-1" }]
        : [{ path: LEADING, branch: "refs/heads/main" }],
    );

    const out = await (await service()).getWorktrees("p1");

    const siblings = out.filter((w: { repoName?: string }) => w.repoName);
    expect(siblings).toHaveLength(1);
    expect(siblings[0]).toMatchObject({ repoName: "admin-cockpit-backend", branch: "feature/ak-1", isMain: false });
  });

  it("flags a sibling worktree no `repos` row claims — the orphan report (#630)", async () => {
    listProjectReposMock.mockResolvedValue([{ id: "r0", path: API, name: "admin-cockpit-backend" }]);
    listWorktreesMock.mockImplementation(async (repoPath: string) =>
      repoPath === API
        ? [{ path: API, branch: "refs/heads/master" }, { path: API_WT, branch: "refs/heads/feature/ak-1" }]
        : [{ path: LEADING, branch: "refs/heads/main" }],
    );

    const [sibling] = (await (await service()).getWorktrees("p1")).filter((w: { repoName?: string }) => w.repoName);
    expect(sibling.orphaned).toBe(true);
    expect(sibling.workspace).toBeUndefined();
  });

  it("links a CLAIMED sibling to its workspace and issue", async () => {
    listProjectReposMock.mockResolvedValue([{ id: "r0", path: API, name: "admin-cockpit-backend" }]);
    listWorktreesMock.mockImplementation(async (repoPath: string) =>
      repoPath === API
        ? [{ path: API, branch: "refs/heads/master" }, { path: API_WT, branch: "refs/heads/feature/ak-1" }]
        : [{ path: LEADING, branch: "refs/heads/main" }],
    );
    getWorkspaceRepoClaimsMock.mockResolvedValue([
      { repoPath: API, worktreePath: API_WT, branch: "feature/ak-1", workspaceId: "ws-1", status: "active", issueId: "i1", issueNumber: 1, issueTitle: "Do the thing" },
    ]);

    const [sibling] = (await (await service()).getWorktrees("p1")).filter((w: { repoName?: string }) => w.repoName);
    expect(sibling.orphaned).toBe(false);
    expect(sibling.workspace).toMatchObject({ id: "ws-1", status: "active", issueNumber: 1 });
  });

  it("never lists a sibling repo's MAIN checkout as a worktree", async () => {
    listProjectReposMock.mockResolvedValue([{ id: "r0", path: API, name: "admin-cockpit-backend" }]);
    const out = await (await service()).getWorktrees("p1");
    expect(out.some((w: { path: string }) => w.path === API)).toBe(false);
  });

  it("an unreadable sibling repo does not fail the whole panel", async () => {
    listProjectReposMock.mockResolvedValue([
      { id: "r0", path: API, name: "admin-cockpit-backend" },
      { id: "r1", path: "C:\\gone", name: "gone" },
    ]);
    listWorktreesMock.mockImplementation(async (repoPath: string) => {
      if (repoPath === "C:\\gone") throw new Error("not a git repository");
      if (repoPath === API) return [{ path: API, branch: "refs/heads/master" }, { path: API_WT, branch: "refs/heads/x" }];
      return [{ path: LEADING, branch: "refs/heads/main" }];
    });

    const out = await (await service()).getWorktrees("p1");
    expect(out.filter((w: { repoName?: string }) => w.repoName)).toHaveLength(1);
  });

  it("is unchanged for a single-repo project", async () => {
    listWorktreesMock.mockResolvedValue([
      { path: LEADING, branch: "refs/heads/main" },
      { path: "C:\\projects\\comet\\documentation\\.worktrees\\ak-2", branch: "refs/heads/feature/ak-2" },
    ]);
    const out = await (await service()).getWorktrees("p1");
    expect(out).toHaveLength(2);
    expect(out.every((w: { repoName?: string }) => !w.repoName)).toBe(true);
  });
});

describe("worktree deletion reaches siblings (#631)", () => {
  it("removes from the OWNING sibling repo, not the leading one", async () => {
    // `git worktree remove` run from the leading repo just fails ("is not a working tree"),
    // and the caller swallows it — so the UI's cleanup action silently did nothing.
    getWorkspaceRepoClaimsMock.mockResolvedValue([
      { repoPath: API, worktreePath: API_WT, branch: "x", workspaceId: "ws-1", status: "closed", issueId: "i1", issueNumber: 1, issueTitle: "t" },
    ]);

    await (await service()).removeWorktreeById("p1", { path: API_WT });

    expect(removeWorktreeMock).toHaveBeenCalledWith(API, API_WT);
  });

  it("still removes a LEADING worktree from the leading repo", async () => {
    const leadingWt = "C:\\projects\\comet\\.worktrees\\documentation\\ak-2";
    await (await service()).removeWorktreeById("p1", { path: leadingWt });
    expect(removeWorktreeMock).toHaveBeenCalledWith(LEADING, leadingWt);
  });

  // #735 — this path had no claim analysis of its own, so a `path`-only delete (the panel's
  // cleanup action) could recursive-rm a directory a LIVE workspace is working in. Co-residency
  // (#394) is a supported state, and the loss is unrecoverable, so the refusal is the assertion.
  it("REFUSES to remove a worktree a live workspace still claims, and says so", async () => {
    const leadingWt = "C:\\projects\\comet\\.worktrees\\documentation\\ak-2";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await (await service([{ id: "ws-live", status: "active", workingDir: leadingWt }]))
      .removeWorktreeById("p1", { path: leadingWt });

    expect(removeWorktreeMock).not.toHaveBeenCalled();
    // A refusal that nothing records is indistinguishable from a silent success.
    expect(warn.mock.calls.flat().join(" ")).toContain("skipping removal");
    warn.mockRestore();
  });

  it("REFUSES when the claim query itself fails — a DB hiccup is not a green light", async () => {
    const { createProjectService } = await import("../services/project.service.js");
    const svc = createProjectService({
      database: {
        select: () => ({
          from: () => ({
            // #815 made this read a LEFT join onto the diff-stat memo. The chain mock has to
          // grow the same link or every call through it dies with "leftJoin is not a
          // function" — `where` stays reachable directly so a caller that stops at the
          // inner join still works.
          innerJoin: () => ({
            where: async () => [],
            leftJoin: () => ({ where: async () => [] }),
          }),
            where: async () => { throw new Error("database is locked"); },
          }),
        }),
      },
    } as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await svc.removeWorktreeById("p1", { path: "C:\\projects\\comet\\.worktrees\\documentation\\ak-3" });

    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).toContain("refusing to remove worktree");
    warn.mockRestore();
  });
});
