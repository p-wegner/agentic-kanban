/**
 * #626/#627 — sibling provisioning was one sequential loop, and on a real 17-repo project it
 * never finished.
 *
 * Reproduced on `comet`: 104 orphaned git worktrees across 13 repos against ZERO rows in
 * `workspaces`, because `git worktree add` + `mvn dependency:go-offline` (209 s warm, measured)
 * ran one repo at a time, inline, before anything was persisted. Two independent costs were
 * conflated in that loop:
 *
 *  - **Worktree creation** is genuinely independent per repo — nothing about `git worktree add`
 *    in repo A constrains repo B — so serializing it bought nothing at all.
 *  - **Dependency installs** are NOT independent: parallel Maven/npm hit one shared local
 *    cache. So they stay sequential by default and go parallel only when a project says so.
 *
 * These tests use a fake git service so timing and failure are controllable; the real-git
 * behaviour of the same function is covered by `workspace-repos-service.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const listProjectReposMock = vi.fn();
const getPreferenceMock = vi.fn();
const runSetupScriptMock = vi.fn();

vi.mock("../repositories/repo.repository.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../repositories/repo.repository.js")>()),
  listProjectRepos: (...args: unknown[]) => listProjectReposMock(...args),
  findCrossProjectBranchHolders: async () => [],
}));
vi.mock("../repositories/preferences.repository.js", () => ({
  getPreference: (...args: unknown[]) => getPreferenceMock(...args),
}));
vi.mock("@agentic-kanban/shared/lib/setup-script", () => ({
  runSetupScript: (...args: unknown[]) => runSetupScriptMock(...args),
  DEFAULT_SETUP_SCRIPT_TIMEOUT_MS: 300_000,
}));

const { provisionSiblingWorktrees, resolveSiblingInstallOptions } = await import(
  "../services/workspace-repos.service.js"
);

const db = {} as never;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function repos(n: number, opts: { setup?: boolean } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    path: `C:/repos/repo${i}`,
    name: `repo${i}`,
    defaultBranch: "main",
    composeFile: null,
    setupScript: opts.setup ? `install-${i}` : null,
  }));
}

/** A git service that records overlap: the max number of createWorktree calls in flight. */
function trackingGit(opts: { delayMs?: number; failOn?: string } = {}) {
  let inFlight = 0;
  const state = { maxInFlight: 0, created: [] as string[], removed: [] as string[] };
  return {
    state,
    service: {
      revParse: async () => "sha",
      createWorktree: async (repoPath: string) => {
        inFlight++;
        state.maxInFlight = Math.max(state.maxInFlight, inFlight);
        await sleep(opts.delayMs ?? 10);
        inFlight--;
        if (opts.failOn === repoPath) throw new Error(`boom in ${repoPath}`);
        state.created.push(repoPath);
        return `${repoPath}/.worktrees/b`;
      },
      removeWorktree: async (repoPath: string) => {
        state.removed.push(repoPath);
      },
    } as never,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getPreferenceMock.mockResolvedValue(null);
  runSetupScriptMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
});

describe("worktree creation is concurrent (#626)", () => {
  it("creates several sibling worktrees at once instead of one at a time", async () => {
    listProjectReposMock.mockResolvedValue(repos(8));
    const git = trackingGit({ delayMs: 20 });

    const out = await provisionSiblingWorktrees({
      gitService: git.service, database: db, projectId: "p", branch: "feature/ak-1",
    });

    expect(out).toHaveLength(8);
    expect(git.state.maxInFlight).toBeGreaterThan(1);
  });

  it("stays BOUNDED — 17 repos must not storm one disk with 17 concurrent checkouts", async () => {
    listProjectReposMock.mockResolvedValue(repos(17));
    const git = trackingGit({ delayMs: 15 });

    await provisionSiblingWorktrees({
      gitService: git.service, database: db, projectId: "p", branch: "feature/ak-1",
    });

    expect(git.state.maxInFlight).toBeLessThanOrEqual(6);
  });

  it("returns siblings in the project's repo order, not completion order", async () => {
    listProjectReposMock.mockResolvedValue(repos(6));
    const git = trackingGit({ delayMs: 5 });
    const out = await provisionSiblingWorktrees({
      gitService: git.service, database: db, projectId: "p", branch: "b",
    });
    expect(out.map((s) => s.name)).toEqual(["repo0", "repo1", "repo2", "repo3", "repo4", "repo5"]);
  });
});

describe("all-or-nothing survives concurrency (#626)", () => {
  it("rolls back worktrees that succeeded ALONGSIDE the failure, not just before it", async () => {
    // The sequential loop only ever had to undo iterations that ran EARLIER. Concurrently, a
    // worktree can finish after the failing one starts — miss those and every failed create
    // leaves debris, which is the orphan-worktree failure this ticket came from.
    listProjectReposMock.mockResolvedValue(repos(6));
    const git = trackingGit({ delayMs: 10, failOn: "C:/repos/repo0" });

    await expect(
      provisionSiblingWorktrees({ gitService: git.service, database: db, projectId: "p", branch: "b" }),
    ).rejects.toThrow(/boom in C:\/repos\/repo0/);

    // Everything that got created must have been removed — no orphans left behind.
    expect(git.state.removed.sort()).toEqual(git.state.created.sort());
    expect(git.state.created.length).toBeGreaterThan(0);
  });

  it("never runs a setup script when any worktree failed", async () => {
    listProjectReposMock.mockResolvedValue(repos(4, { setup: true }));
    const git = trackingGit({ delayMs: 5, failOn: "C:/repos/repo2" });

    await expect(
      provisionSiblingWorktrees({ gitService: git.service, database: db, projectId: "p", branch: "b" }),
    ).rejects.toThrow();

    expect(runSetupScriptMock).not.toHaveBeenCalled();
  });

  it("reports a repo with no default branch as the failure, and cleans up", async () => {
    const rs = repos(3);
    rs[1].defaultBranch = null as never;
    listProjectReposMock.mockResolvedValue(rs);
    const git = trackingGit({ delayMs: 5 });

    await expect(
      provisionSiblingWorktrees({ gitService: git.service, database: db, projectId: "p", branch: "b" }),
    ).rejects.toThrow(/has no default branch/);
    expect(git.state.removed.sort()).toEqual(git.state.created.sort());
  });
});

describe("dependency installs: sequential by default, parallel on request (#627)", () => {
  /** Instrument runSetupScript the same way: how many ran at once? */
  function trackInstalls(delayMs = 20) {
    let inFlight = 0;
    const state = { maxInFlight: 0 };
    runSetupScriptMock.mockImplementation(async () => {
      inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, inFlight);
      await sleep(delayMs);
      inFlight--;
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    return state;
  }

  it("runs installs ONE at a time by default — a shared package cache contends", async () => {
    listProjectReposMock.mockResolvedValue(repos(5, { setup: true }));
    const state = trackInstalls();

    await provisionSiblingWorktrees({
      gitService: trackingGit({ delayMs: 1 }).service, database: db, projectId: "p", branch: "b",
    });

    expect(runSetupScriptMock).toHaveBeenCalledTimes(5);
    expect(state.maxInFlight).toBe(1);
  });

  it("overlaps installs when the project opted into `parallel`", async () => {
    listProjectReposMock.mockResolvedValue(repos(5, { setup: true }));
    const state = trackInstalls();

    await provisionSiblingWorktrees({
      gitService: trackingGit({ delayMs: 1 }).service, database: db, projectId: "p", branch: "b",
      installMode: "parallel",
    });

    expect(state.maxInFlight).toBeGreaterThan(1);
    expect(state.maxInFlight).toBeLessThanOrEqual(4);
  });

  it("passes the configured timeout through, and nothing when unset", async () => {
    listProjectReposMock.mockResolvedValue(repos(1, { setup: true }));
    const git = trackingGit({ delayMs: 1 });

    await provisionSiblingWorktrees({
      gitService: git.service, database: db, projectId: "p", branch: "b", installTimeoutMs: 900_000,
    });
    expect(runSetupScriptMock).toHaveBeenLastCalledWith(expect.any(String), "install-0", { timeoutMs: 900_000 });

    await provisionSiblingWorktrees({
      gitService: git.service, database: db, projectId: "p", branch: "b",
    });
    expect(runSetupScriptMock).toHaveBeenLastCalledWith(expect.any(String), "install-0", {});
  });

  it("a failing install is still non-fatal — the workspace gets its worktrees", async () => {
    listProjectReposMock.mockResolvedValue(repos(3, { setup: true }));
    runSetupScriptMock.mockRejectedValue(new Error("npm ci exploded"));

    const out = await provisionSiblingWorktrees({
      gitService: trackingGit({ delayMs: 1 }).service, database: db, projectId: "p", branch: "b",
    });
    expect(out).toHaveLength(3);
  });
});

describe("resolveSiblingInstallOptions (#627)", () => {
  it("defaults to today's behaviour when nothing is set", async () => {
    getPreferenceMock.mockResolvedValue(null);
    expect(await resolveSiblingInstallOptions("p", db)).toEqual({
      installMode: "sequential", installTimeoutMs: undefined,
    });
  });

  it("reads `parallel` case-insensitively", async () => {
    getPreferenceMock.mockImplementation(async (key: string) =>
      key.startsWith("sibling_install_mode") ? " Parallel " : null,
    );
    expect((await resolveSiblingInstallOptions("p", db)).installMode).toBe("parallel");
  });

  it("ignores an unrecognised mode rather than guessing", async () => {
    getPreferenceMock.mockImplementation(async (key: string) =>
      key.startsWith("sibling_install_mode") ? "concurrent-ish" : null,
    );
    expect((await resolveSiblingInstallOptions("p", db)).installMode).toBe("sequential");
  });

  it("accepts a bounded timeout and rejects nonsense", async () => {
    const withTimeout = async (v: string | null) => {
      getPreferenceMock.mockImplementation(async (key: string) =>
        key.startsWith("sibling_install_timeout_ms") ? v : null,
      );
      return (await resolveSiblingInstallOptions("p", db)).installTimeoutMs;
    };
    expect(await withTimeout("900000")).toBe(900_000);
    expect(await withTimeout("5")).toBeUndefined();            // below the 30s floor
    expect(await withTimeout("99999999999")).toBeUndefined();  // above the 3h ceiling
    expect(await withTimeout("soon")).toBeUndefined();
  });

  it("survives an unreadable preference store", async () => {
    getPreferenceMock.mockRejectedValue(new Error("db gone"));
    expect(await resolveSiblingInstallOptions("p", db)).toEqual({
      installMode: "sequential", installTimeoutMs: undefined,
    });
  });
});
