/**
 * #632 — Project Health checked the leading repo and nothing else.
 *
 * `validateGitRepo`, `getDirtyTrackedSourceFiles` and the base-branch lookup all read
 * `project.repoPath`; `listProjectRepos` was never called. So `comet`'s row rendered with no
 * warnings while 16 of its 17 repos had never been looked at — and it rendered IDENTICALLY to
 * a genuinely clean project, next to others in the same list that did show `Git check failed`.
 * Absence of a warning meant two different things and the UI could not tell them apart.
 *
 * A dirty or detached SIBLING is exactly as merge-blocking as a dirty leading repo, so the
 * checks run across every registered repo, warnings are labelled with the repo they came
 * from, and `reposChecked` is reported so silence cannot be read as a pass.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getProjectHealthRowsMock = vi.fn();
const listProjectReposMock = vi.fn();
const gitExecMock = vi.fn();
const dirtyFilesMock = vi.fn();

vi.mock("../repositories/project-health.repository.js", () => ({
  getProjectHealthRows: (...a: unknown[]) => getProjectHealthRowsMock(...a),
  getIssueCountsByStatus: async () => [],
}));
vi.mock("../repositories/repo.repository.js", () => ({
  listProjectRepos: (...a: unknown[]) => listProjectReposMock(...a),
}));
vi.mock("@agentic-kanban/shared/lib/git-exec", () => ({
  gitExec: (...a: unknown[]) => gitExecMock(...a),
}));
vi.mock("./dirty-main-checkout.js", () => ({}));
vi.mock("../services/dirty-main-checkout.js", () => ({
  getDirtyTrackedSourceFiles: (...a: unknown[]) => dirtyFilesMock(...a),
}));
vi.mock("../repositories/preferences.repository.js", () => ({ getPreference: async () => null }));
vi.mock("../repositories/base-branch-health.repository.js", () => ({ getLatestBaseBranchHealth: async () => null }));

const { getProjectHealth } = await import("../services/project-health.service.js");

const db = {} as never;
const LEADING = "C:/projects/comet/documentation";

beforeEach(() => {
  vi.clearAllMocks();
  getProjectHealthRowsMock.mockResolvedValue([
    { id: "p1", name: "comet", color: null, repoPath: LEADING, defaultBranch: "main" },
  ]);
  listProjectReposMock.mockResolvedValue([]);
  gitExecMock.mockResolvedValue({ stdout: "sha", stderr: "", code: 0 });
  dirtyFilesMock.mockResolvedValue([]);
});

function siblings(...names: string[]) {
  return names.map((name, i) => ({ id: `r${i}`, path: `C:/projects/comet/${name}`, name }));
}

describe("project health across every repo (#632)", () => {
  it("reports how many repos it checked, so silence is not mistaken for a pass", async () => {
    listProjectReposMock.mockResolvedValue(siblings(...Array.from({ length: 16 }, (_, i) => `repo${i}`)));
    const res = await getProjectHealth(db);
    expect(res.projects[0].reposChecked).toBe(17);
  });

  it("is 1 for a single-repo project, so nothing changes there", async () => {
    const res = await getProjectHealth(db);
    expect(res.projects[0].reposChecked).toBe(1);
    expect(res.projects[0].warnings).toEqual([]);
  });

  it("surfaces a dirty SIBLING, which used to be invisible", async () => {
    listProjectReposMock.mockResolvedValue(siblings("api", "web"));
    dirtyFilesMock.mockImplementation(async (path: string) =>
      path.endsWith("/api") ? ["src/Main.kt", "src/Other.kt"] : [],
    );

    const { warnings } = (await getProjectHealth(db)).projects[0];

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("api:");
    expect(warnings[0]).toContain("2 uncommitted source file(s)");
  });

  it("names the repo a git failure came from — an unlabelled one is unactionable", async () => {
    listProjectReposMock.mockResolvedValue(siblings("api", "web"));
    gitExecMock.mockImplementation(async (_args: string[], opts: { cwd: string }) =>
      opts.cwd.endsWith("/web")
        ? { stdout: "", stderr: "", code: 128, error: new Error("fatal: not a git repository") }
        : { stdout: "sha", stderr: "", code: 0 },
    );

    const { warnings } = (await getProjectHealth(db)).projects[0];
    expect(warnings).toEqual(["web: Invalid git repository or bad HEAD"]);
  });

  it("leaves the LEADING repo's warnings unlabelled, so existing wording is unchanged", async () => {
    dirtyFilesMock.mockResolvedValue(["src/a.ts"]);
    const { warnings } = (await getProjectHealth(db)).projects[0];
    expect(warnings[0]).toMatch(/^Dirty main checkout: 1 uncommitted source file/);
  });

  it("checks every repo even when several are broken — one failure hides no other", async () => {
    listProjectReposMock.mockResolvedValue(siblings("api", "web", "infra"));
    gitExecMock.mockImplementation(async (_a: string[], opts: { cwd: string }) =>
      opts.cwd.endsWith("/api") || opts.cwd.endsWith("/infra")
        ? { stdout: "", stderr: "", code: 128, error: new Error("fatal: not a git repository") }
        : { stdout: "sha", stderr: "", code: 0 },
    );

    const { warnings, reposChecked } = (await getProjectHealth(db)).projects[0];
    expect(reposChecked).toBe(4);
    expect(warnings).toHaveLength(2);
    expect(warnings.some((w) => w.startsWith("api:"))).toBe(true);
    expect(warnings.some((w) => w.startsWith("infra:"))).toBe(true);
  });

  it("still reports the leading repo when the sibling list cannot be read", async () => {
    listProjectReposMock.mockRejectedValue(new Error("db gone"));
    const res = await getProjectHealth(db);
    expect(res.projects[0].reposChecked).toBe(1);
  });

  it("skips the dirty check for a repo whose git check already failed", async () => {
    listProjectReposMock.mockResolvedValue(siblings("api"));
    gitExecMock.mockImplementation(async (_a: string[], opts: { cwd: string }) =>
      opts.cwd.endsWith("/api")
        ? { stdout: "", stderr: "", code: 128, error: new Error("fatal: not a git repository") }
        : { stdout: "sha", stderr: "", code: 0 },
    );

    const { warnings } = (await getProjectHealth(db)).projects[0];
    expect(warnings).toEqual(["api: Invalid git repository or bad HEAD"]);
    // Only the leading repo reached the dirty check.
    expect(dirtyFilesMock).toHaveBeenCalledTimes(1);
    expect(dirtyFilesMock).toHaveBeenCalledWith(LEADING);
  });
});
