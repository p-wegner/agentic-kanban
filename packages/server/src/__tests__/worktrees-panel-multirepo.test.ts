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

/** The service is a factory over injected collaborators; only `getWorktrees`/`removeWorktreeById` matter here. */
async function service() {
  const { createProjectService } = await import("../services/project.service.js");
  return createProjectService({
    database: {
      select: () => ({ from: () => ({ innerJoin: () => ({ where: async () => [] }) }) }),
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
});
