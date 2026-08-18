/**
 * #539 part (b) — `workspaceHasCommittedWork` is the ONE leading-OR-sibling probe.
 *
 * Two properties are pinned here because getting either wrong is a work-losing bug:
 *
 *  1. **Sibling awareness** (#69). A sibling-only ticket commits nothing in the leading
 *     worktree. The three readers that used a leading-only count therefore read it as
 *     "no work" — exit-workflow force-closed the issue with the sibling commit stranded,
 *     and the two reconcilers silently declined to recover the workspace at all.
 *  2. **The unknown policy stays per-caller.** exit-workflow needs `unknown -> true`
 *     ("might be work, don't close it"); the reconcilers need `unknown -> false` ("no
 *     evidence, don't act"). They are mirror images, so the helper takes the policy as an
 *     argument rather than picking one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const listWorkspaceRepos = vi.fn();
vi.mock("../repositories/repo.repository.js", () => ({
  listWorkspaceRepos: (...args: unknown[]) => listWorkspaceRepos(...args),
}));

const { workspaceHasCommittedWork } = await import("../services/workspace-commits.js");

const db = {} as never;
const leadingOnly = { id: "ws1", workingDir: "/wt/lead", baseBranch: "main" };

/** A `countAhead` that answers per cwd; anything unlisted answers 0. */
function counter(byCwd: Record<string, number | null>) {
  return vi.fn(async (cwd: string) => (cwd in byCwd ? byCwd[cwd] : 0));
}

beforeEach(() => {
  listWorkspaceRepos.mockReset();
  listWorkspaceRepos.mockResolvedValue([]);
});

describe("workspaceHasCommittedWork", () => {
  it("is true when the LEADING repo is ahead — siblings are never probed", async () => {
    const countAhead = counter({ "/wt/lead": 2 });
    await expect(
      workspaceHasCommittedWork(leadingOnly, null, db, { onUnknown: false, countAhead }),
    ).resolves.toBe(true);
    expect(listWorkspaceRepos).not.toHaveBeenCalled();
  });

  it("is true when only a SIBLING worktree is ahead (#69 sibling-only ticket)", async () => {
    listWorkspaceRepos.mockResolvedValue([
      { path: "/repos/api", worktreePath: "/wt/api", branch: "feature/x", baseBranch: "main" },
    ]);
    const countAhead = counter({ "/wt/lead": 0, "/wt/api": 1 });
    await expect(
      workspaceHasCommittedWork(leadingOnly, null, db, { onUnknown: false, countAhead }),
    ).resolves.toBe(true);
  });

  it("falls back to counting the sibling BRANCH from its main checkout once the worktree is gone", async () => {
    listWorkspaceRepos.mockResolvedValue([
      { path: "/repos/api", worktreePath: null, branch: "feature/x", baseBranch: "main" },
    ]);
    const countAhead = vi.fn(async (cwd: string, base: string, headRef?: string) =>
      cwd === "/repos/api" && base === "main" && headRef === "feature/x" ? 3 : 0,
    );
    await expect(
      workspaceHasCommittedWork(leadingOnly, null, db, { onUnknown: false, countAhead }),
    ).resolves.toBe(true);
  });

  it("is false when neither the leading repo nor any sibling is ahead", async () => {
    listWorkspaceRepos.mockResolvedValue([
      { path: "/repos/api", worktreePath: "/wt/api", branch: "feature/x", baseBranch: "main" },
    ]);
    const countAhead = counter({});
    await expect(
      workspaceHasCommittedWork(leadingOnly, null, db, { onUnknown: false, countAhead }),
    ).resolves.toBe(false);
  });

  it("an unknown leading count still consults the siblings before deciding", async () => {
    listWorkspaceRepos.mockResolvedValue([
      { path: "/repos/api", worktreePath: "/wt/api", branch: "feature/x", baseBranch: "main" },
    ]);
    const countAhead = counter({ "/wt/lead": null, "/wt/api": 1 });
    await expect(
      workspaceHasCommittedWork(leadingOnly, null, db, { onUnknown: false, countAhead }),
    ).resolves.toBe(true);
  });

  it("an unknown leading count with silent siblings resolves to the CALLER's policy", async () => {
    const countAhead = counter({ "/wt/lead": null });
    // exit-workflow: unknown must not license closing the workspace.
    await expect(
      workspaceHasCommittedWork(leadingOnly, null, db, { onUnknown: true, countAhead }),
    ).resolves.toBe(true);
    // the reconcilers: unknown must not make them act.
    await expect(
      workspaceHasCommittedWork(leadingOnly, null, db, { onUnknown: false, countAhead }),
    ).resolves.toBe(false);
  });

  it("a sibling git failure reads as no-change for that sibling, not for the workspace", async () => {
    listWorkspaceRepos.mockResolvedValue([
      { path: "/repos/api", worktreePath: "/wt/api", branch: "feature/x", baseBranch: "main" },
      { path: "/repos/web", worktreePath: "/wt/web", branch: "feature/x", baseBranch: "main" },
    ]);
    const countAhead = vi.fn(async (cwd: string) => {
      if (cwd === "/wt/api") throw new Error("git exploded");
      return cwd === "/wt/web" ? 1 : 0;
    });
    await expect(
      workspaceHasCommittedWork(leadingOnly, null, db, { onUnknown: false, countAhead }),
    ).resolves.toBe(true);
  });

  it("a DIRECT workspace counts against its start sha and never probes siblings", async () => {
    const countAhead = vi.fn(async (cwd: string, base: string) =>
      cwd === "/repo" && base === "abc123" ? 1 : 0,
    );
    await expect(
      workspaceHasCommittedWork(
        { id: "ws2", workingDir: "/repo", baseBranch: null, isDirect: true, baseCommitSha: "abc123" },
        null,
        db,
        { onUnknown: false, countAhead },
      ),
    ).resolves.toBe(true);
    expect(listWorkspaceRepos).not.toHaveBeenCalled();
  });

  it("falls back to the project default branch when the workspace has none", async () => {
    const countAhead = vi.fn(async (_cwd: string, base: string) => (base === "develop" ? 1 : 0));
    await expect(
      workspaceHasCommittedWork(
        { id: "ws3", workingDir: "/wt/lead", baseBranch: null },
        "develop",
        db,
        { onUnknown: false, countAhead },
      ),
    ).resolves.toBe(true);
  });

  it("is false with no working directory at all", async () => {
    const countAhead = counter({});
    await expect(
      workspaceHasCommittedWork({ id: "ws4", workingDir: null, baseBranch: "main" }, null, db, {
        onUnknown: true, countAhead,
      }),
    ).resolves.toBe(false);
    expect(countAhead).not.toHaveBeenCalled();
  });
});
