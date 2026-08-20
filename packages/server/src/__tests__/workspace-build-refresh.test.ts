// @covers review-merge.update-base.artifact-refresh [resilience,cost]
/**
 * Rebuilding a worktree's generated artifacts after update-base (#275).
 *
 * A worktree's build outputs are gitignored and produced once, by the setup script, when the
 * worktree is created. `update-base` rewrites the worktree's SOURCE and rebuilds nothing, so
 * a branch that was far behind comes back with fresh `src` and stale generated output.
 * Observed driving #218 to master: a ~500-commit-stale branch rebased cleanly, and the very
 * next verify gate failed with `Property 'mergeGateBranchSha' does not exist` — the stale
 * `packages/shared/dist`, not the branch. The cost of finding out was a full verify run.
 *
 * The repair deliberately runs the PROJECT'S OWN setup script rather than anything
 * board-specific, since that is the command that produced the artifacts in the first place.
 * These tests pin the three ways it must stay cheap and safe: no rebuild when nothing moved,
 * no rebuild when there is nothing to run, and never failing the update-base it follows.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Database } from "../db/index.js";

const getProjectSetupScriptMock = vi.fn(async () => "pnpm install -r" as string | null);
vi.mock("../repositories/stack-profile.repository.js", () => ({
  getProjectSetupScript: (...args: unknown[]) => getProjectSetupScriptMock(...(args as [])),
}));

const { refreshWorkspaceBuildArtifacts } = await import("../services/workspace-build-refresh.service.js");

const db = {} as Database;

function makeRunScript(result: { exitCode: number } | Error) {
  return vi.fn(async () => {
    if (result instanceof Error) throw result;
    return { exitCode: result.exitCode, stdout: "", stderr: "", timedOut: false };
  });
}

function call(overrides: Partial<Parameters<typeof refreshWorkspaceBuildArtifacts>[0]> = {}) {
  return refreshWorkspaceBuildArtifacts({
    workingDir: "/repo/.worktrees/ws-1",
    projectId: "project-1",
    database: db,
    headShaBefore: "old",
    headShaAfter: "new",
    runScript: makeRunScript({ exitCode: 0 }) as never,
    ...overrides,
  });
}

describe("refreshWorkspaceBuildArtifacts (#275)", () => {
  beforeEach(() => {
    getProjectSetupScriptMock.mockReset();
    getProjectSetupScriptMock.mockResolvedValue("pnpm install -r");
  });

  it("re-runs the project's setup script when the worktree HEAD moved", async () => {
    const runScript = makeRunScript({ exitCode: 0 });

    const outcome = await call({ runScript: runScript as never });

    expect(outcome).toBe("refreshed");
    expect(runScript).toHaveBeenCalledTimes(1);
    expect(runScript.mock.calls[0].slice(0, 2)).toEqual(["/repo/.worktrees/ws-1", "pnpm install -r"]);
  });

  it("does nothing when HEAD did not move — a no-op rebase rebuilds nothing", async () => {
    const runScript = makeRunScript({ exitCode: 0 });

    const outcome = await call({ headShaBefore: "same", headShaAfter: "same", runScript: runScript as never });

    expect(outcome).toBe("skipped-unchanged");
    expect(runScript).not.toHaveBeenCalled();
    // Not even a preference read — the cheap path stays cheap.
    expect(getProjectSetupScriptMock).not.toHaveBeenCalled();
  });

  it("refreshes when a tip is UNRESOLVABLE — that is not proof nothing moved", async () => {
    const runScript = makeRunScript({ exitCode: 0 });

    const outcome = await call({ headShaBefore: null, headShaAfter: null, runScript: runScript as never });

    expect(outcome).toBe("refreshed");
    expect(runScript).toHaveBeenCalledTimes(1);
  });

  it("skips a project with no setup script instead of inventing a build command", async () => {
    getProjectSetupScriptMock.mockResolvedValue(null);
    const runScript = makeRunScript({ exitCode: 0 });

    expect(await call({ runScript: runScript as never })).toBe("skipped-no-script");
    expect(runScript).not.toHaveBeenCalled();

    getProjectSetupScriptMock.mockResolvedValue("   ");
    expect(await call({ runScript: runScript as never })).toBe("skipped-no-script");
    expect(runScript).not.toHaveBeenCalled();
  });

  it("reports a failing rebuild without throwing — update-base already succeeded", async () => {
    // The rebase landed; failing the whole operation because a rebuild misbehaved would
    // discard real work. The verify gate is still there to catch what this could not fix.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await call({ runScript: makeRunScript({ exitCode: 1 }) as never })).toBe("failed");
    expect(await call({ runScript: makeRunScript(new Error("spawn ENOENT")) as never })).toBe("failed");

    warn.mockRestore();
  });

  it("skips when the workspace has no project", async () => {
    const runScript = makeRunScript({ exitCode: 0 });

    expect(await call({ projectId: null, runScript: runScript as never })).toBe("skipped-no-script");
    expect(runScript).not.toHaveBeenCalled();
  });
});
