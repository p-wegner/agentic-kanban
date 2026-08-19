/**
 * #628 — the agent must not wait out the dependency installs.
 *
 * MEASURED on `comet` (17 repos): `mvn -B -DskipTests dependency:go-offline` takes 209 s per
 * repo WARM, and 16 of them ran sequentially, inline, before the workspace row was written and
 * the deferred launch fired. So the agent read its first file 30-60 minutes after the ticket
 * started, and a server restart in that window meant it never started at all.
 *
 * `background` moves the installs AFTER the launch. The protection that `setupFailedBlocking`
 * (#169) gave by refusing the LAUNCH has to move with them, so these tests pin BOTH halves:
 * provisioning returns without installing, and the merge gate refuses to land a branch whose
 * installs are outstanding or failed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  summarizeRepoInstalls,
  isRepoInstallOutstanding,
  blocksMerge,
} from "@agentic-kanban/shared/lib/repo-install-state";

const listProjectReposMock = vi.fn();
const getPreferenceMock = vi.fn();
const runSetupScriptMock = vi.fn();
const setInstallStateMock = vi.fn();

vi.mock("../repositories/repo.repository.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../repositories/repo.repository.js")>()),
  listProjectRepos: (...args: unknown[]) => listProjectReposMock(...args),
  findCrossProjectBranchHolders: async () => [],
  setWorkspaceRepoInstallState: (...args: unknown[]) => setInstallStateMock(...args),
}));
vi.mock("../repositories/preferences.repository.js", () => ({
  getPreference: (...args: unknown[]) => getPreferenceMock(...args),
}));
vi.mock("@agentic-kanban/shared/lib/setup-script", () => ({
  runSetupScript: (...args: unknown[]) => runSetupScriptMock(...args),
  DEFAULT_SETUP_SCRIPT_TIMEOUT_MS: 300_000,
}));

const { provisionSiblingWorktrees, resolveSiblingInstallOptions, runBackgroundSiblingInstalls } =
  await import("../services/workspace-repos.service.js");

const db = {} as never;

function repoRows(n: number, withSetup = true) {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    path: `C:/repos/repo${i}`,
    name: `repo${i}`,
    defaultBranch: "main",
    composeFile: null,
    setupScript: withSetup ? `install-${i}` : null,
  }));
}

const fakeGit = {
  revParse: async () => "sha",
  createWorktree: async (repoPath: string) => `${repoPath}/.worktrees/b`,
  removeWorktree: async () => {},
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  getPreferenceMock.mockResolvedValue(null);
  runSetupScriptMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  setInstallStateMock.mockResolvedValue(undefined);
});

describe("resolveSiblingInstallOptions accepts the third mode (#628)", () => {
  it("reads `background`", async () => {
    getPreferenceMock.mockImplementation(async (key: string) =>
      key.startsWith("sibling_install_mode") ? "background" : null,
    );
    expect((await resolveSiblingInstallOptions("p", db)).installMode).toBe("background");
  });

  it("still falls back to `sequential` for an unrecognised value — a provisioning default must not move on a typo", async () => {
    getPreferenceMock.mockImplementation(async (key: string) =>
      key.startsWith("sibling_install_mode") ? "backgrond" : null,
    );
    expect((await resolveSiblingInstallOptions("p", db)).installMode).toBe("sequential");
  });
});

describe("provisioning does not install in background mode (#628)", () => {
  it("returns as soon as the worktrees exist, with every repo marked deferred", async () => {
    listProjectReposMock.mockResolvedValue(repoRows(4));

    const out = await provisionSiblingWorktrees({
      gitService: fakeGit, database: db, projectId: "p", branch: "b", installMode: "background",
    });

    expect(out).toHaveLength(4);
    expect(out.every((s) => s.installDeferred)).toBe(true);
    // The whole point: not one install ran on the provisioning path.
    expect(runSetupScriptMock).not.toHaveBeenCalled();
  });

  it("marks only the repos that HAVE a setup script as deferred", async () => {
    listProjectReposMock.mockResolvedValue([
      ...repoRows(2),
      { id: "r9", path: "C:/repos/repo9", name: "repo9", defaultBranch: "main", composeFile: null, setupScript: null },
    ]);
    const out = await provisionSiblingWorktrees({
      gitService: fakeGit, database: db, projectId: "p", branch: "b", installMode: "background",
    });
    expect(out.map((s) => s.installDeferred)).toEqual([true, true, false]);
  });

  it("the inline modes are untouched — `sequential` still installs before returning", async () => {
    listProjectReposMock.mockResolvedValue(repoRows(3));
    const out = await provisionSiblingWorktrees({
      gitService: fakeGit, database: db, projectId: "p", branch: "b", installMode: "sequential",
    });
    expect(runSetupScriptMock).toHaveBeenCalledTimes(3);
    expect(out.some((s) => s.installDeferred)).toBe(false);
  });

  it("`skipSetup` beats `background` — nothing is deferred because nothing was ever going to run", async () => {
    listProjectReposMock.mockResolvedValue(repoRows(3));
    const out = await provisionSiblingWorktrees({
      gitService: fakeGit, database: db, projectId: "p", branch: "b",
      installMode: "background", skipSetup: true,
    });
    expect(runSetupScriptMock).not.toHaveBeenCalled();
    expect(out.some((s) => s.installDeferred)).toBe(false);
  });
});

describe("the background runner reports per-repo state (#628)", () => {
  const siblings = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      path: `C:/repos/repo${i}`, name: `repo${i}`, worktreePath: `C:/wt/repo${i}`,
      branch: "b", baseBranch: "main", baseCommitSha: "sha", composeFile: null,
      installDeferred: true,
    }));

  it("moves each repo running -> done and runs one install at a time", async () => {
    listProjectReposMock.mockResolvedValue(repoRows(3));
    let inFlight = 0;
    let maxInFlight = 0;
    runSetupScriptMock.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await runBackgroundSiblingInstalls({
      workspaceId: "w1", projectId: "p", siblings: siblings(3), database: db, installMode: "background",
    });

    expect(maxInFlight).toBe(1);
    const states = setInstallStateMock.mock.calls.map((c) => (c[0] as { state: string }).state);
    expect(states).toEqual(["running", "done", "running", "done", "running", "done"]);
  });

  it("records `failed` with the exit code and stderr, and keeps going for the other repos", async () => {
    listProjectReposMock.mockResolvedValue(repoRows(2));
    runSetupScriptMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "could not resolve org.example:thing" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

    await runBackgroundSiblingInstalls({
      workspaceId: "w1", projectId: "p", siblings: siblings(2), database: db, installMode: "background",
    });

    const calls = setInstallStateMock.mock.calls.map((c) => c[0] as { state: string; detail?: string | null });
    expect(calls.map((c) => c.state)).toEqual(["running", "failed", "running", "done"]);
    expect(calls[1].detail).toContain("exit 1");
    expect(calls[1].detail).toContain("could not resolve");
  });

  it("a throwing install is recorded as failed, not swallowed into `done`", async () => {
    listProjectReposMock.mockResolvedValue(repoRows(1));
    runSetupScriptMock.mockRejectedValue(new Error("spawn ENOENT"));

    await runBackgroundSiblingInstalls({
      workspaceId: "w1", projectId: "p", siblings: siblings(1), database: db, installMode: "background",
    });

    const calls = setInstallStateMock.mock.calls.map((c) => c[0] as { state: string; detail?: string | null });
    expect(calls.map((c) => c.state)).toEqual(["running", "failed"]);
    expect(calls[1].detail).toContain("ENOENT");
  });

  it("does nothing at all when no sibling was deferred", async () => {
    await runBackgroundSiblingInstalls({
      workspaceId: "w1", projectId: "p", database: db, installMode: "background",
      siblings: siblings(2).map((s) => ({ ...s, installDeferred: false })),
    });
    expect(runSetupScriptMock).not.toHaveBeenCalled();
    expect(setInstallStateMock).not.toHaveBeenCalled();
  });

  it("reports progress on every transition so the board can render `installing 3/16`", async () => {
    listProjectReposMock.mockResolvedValue(repoRows(2));
    const onProgress = vi.fn();
    await runBackgroundSiblingInstalls({
      workspaceId: "w1", projectId: "p", siblings: siblings(2), database: db,
      installMode: "background", onProgress,
    });
    expect(onProgress).toHaveBeenCalledTimes(4);
  });
});

describe("the install-state vocabulary (#628)", () => {
  it("treats NULL as nothing-outstanding, so inline-install projects are unaffected", () => {
    expect(isRepoInstallOutstanding(null)).toBe(false);
    expect(blocksMerge(null)).toBe(false);
    expect(summarizeRepoInstalls([null, null]).installing).toBe(false);
    expect(summarizeRepoInstalls([null, null]).tracked).toBe(0);
  });

  it("blocks a merge while pending/running AND when an install failed", () => {
    expect(blocksMerge("pending")).toBe(true);
    expect(blocksMerge("running")).toBe(true);
    expect(blocksMerge("failed")).toBe(true);
    expect(blocksMerge("done")).toBe(false);
    expect(blocksMerge("skipped")).toBe(false);
  });

  it("summarizes a mid-flight run", () => {
    const s = summarizeRepoInstalls(["done", "done", "running", "pending", "failed", null]);
    expect(s).toEqual({ tracked: 5, done: 2, failed: 1, outstanding: 2, installing: true });
  });
});
