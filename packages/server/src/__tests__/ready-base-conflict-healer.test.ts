import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../repositories/workspace-merge-prevalidation.repository.js", () => ({ clearWorkspaceReadyForMerge: vi.fn(async () => undefined) }));
vi.mock("../repositories/workspace-crud.repository.js", () => ({ setWorkspaceReadyForMerge: vi.fn(async () => undefined) }));
vi.mock("../repositories/issue-comments.repository.js", () => ({ insertIssueComment: vi.fn(async () => undefined) }));
vi.mock("../repositories/merge-hold.repository.js", () => ({ setMergeHold: vi.fn(async () => undefined) }));

import {
  formatBaseConflictFixTurn,
  reconcileReadyBaseConflicts,
  resetReadyBaseConflictHealerStateForTests,
  type ReadyBaseConflictHealDeps,
} from "../startup/ready-base-conflict-healer.js";
import { isKeepBothOnly, keepBothSides } from "../services/base-conflict-keep-both.js";
import { setWorkspaceReadyForMerge } from "../repositories/workspace-crud.repository.js";
import { clearWorkspaceReadyForMerge } from "../repositories/workspace-merge-prevalidation.repository.js";
import { setMergeHold } from "../repositories/merge-hold.repository.js";

const candidate = { workspaceId: "ws1", issueId: "i1", issueNumber: 1569, projectId: "p1", branch: "feature/x", workingDir: "/wt" };

function makeDeps(over: Partial<ReadyBaseConflictHealDeps> = {}): ReadyBaseConflictHealDeps {
  return {
    database: {} as never,
    listCandidates: async () => [candidate],
    resolveRepo: async () => ({ repoPath: "/repo", baseBranch: "master" }),
    isBusy: async () => false,
    detectConflicts: async () => ({ hasConflicts: true, files: ["a.ts"] }),
    rebase: async () => ({ success: false, conflictingFiles: ["a.ts"] }),
    rebaseKeepBoth: async () => false,
    baseCommitsTouching: async () => ["abc1234 feat: touched a.ts"],
    branchTip: async () => "tip1",
    hasLiveSession: async () => true,
    sendTurn: vi.fn(async () => undefined),
    relaunch: vi.fn(async () => undefined),
    ...over,
  };
}

describe("ready base-conflict healer (#1584)", () => {
  beforeEach(() => {
    resetReadyBaseConflictHealerStateForTests();
    vi.clearAllMocks();
  });

  it("leaves a ready workspace that merges cleanly alone", async () => {
    const rebase = vi.fn();
    const r = await reconcileReadyBaseConflicts(makeDeps({ detectConflicts: async () => ({ hasConflicts: false, files: [] }), rebase }));
    expect(rebase).not.toHaveBeenCalled();
    expect(r.skipped).toBe(1);
  });

  it("rebases a conflicting workspace and stops when the rebase is clean", async () => {
    const deps = makeDeps({ rebase: vi.fn(async () => ({ success: true })) });
    const r = await reconcileReadyBaseConflicts(deps);
    expect(deps.rebase).toHaveBeenCalledWith("ws1");
    expect(r.rebased).toEqual(["ws1"]);
    expect(deps.sendTurn).not.toHaveBeenCalled();
  });

  it("on a rebase conflict gives the builder ONE turn naming the files and the base commits", async () => {
    const deps = makeDeps();
    const r = await reconcileReadyBaseConflicts(deps);
    expect(r.turned).toEqual(["ws1"]);
    expect(deps.sendTurn).toHaveBeenCalledTimes(1);
    const prompt = (deps.sendTurn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(prompt).toContain("- a.ts");
    expect(prompt).toContain("abc1234 feat: touched a.ts");
    expect(clearWorkspaceReadyForMerge).toHaveBeenCalled();

    // Same tip, later pass: not asked twice.
    const again = await reconcileReadyBaseConflicts({ ...deps, nowMs: Date.now() + 10 * 60_000 });
    expect(again.turned).toEqual([]);
    expect(deps.sendTurn).toHaveBeenCalledTimes(1);
  });

  it("relaunches the builder when it has no live session", async () => {
    const deps = makeDeps({ hasLiveSession: async () => false });
    await reconcileReadyBaseConflicts(deps);
    expect(deps.relaunch).toHaveBeenCalledTimes(1);
    expect(deps.sendTurn).not.toHaveBeenCalled();
  });

  it("restores readyForMerge when the turn cannot be delivered", async () => {
    const deps = makeDeps({ sendTurn: vi.fn(async () => { throw new Error("busy"); }) });
    const r = await reconcileReadyBaseConflicts(deps);
    expect(r.turned).toEqual([]);
    expect(setWorkspaceReadyForMerge).toHaveBeenCalled();
  });

  it("resolves a CONTINUE.md-only conflict mechanically with no turn", async () => {
    const deps = makeDeps({
      rebase: async () => ({ success: false, conflictingFiles: ["CONTINUE.md"] }),
      rebaseKeepBoth: vi.fn(async () => true),
    });
    const r = await reconcileReadyBaseConflicts(deps);
    expect(r.keptBoth).toEqual(["ws1"]);
    expect(deps.sendTurn).not.toHaveBeenCalled();
  });

  it("falls back to a turn when the mechanical resolution fails", async () => {
    const deps = makeDeps({ rebase: async () => ({ success: false, conflictingFiles: ["CONTINUE.md"] }) });
    const r = await reconcileReadyBaseConflicts(deps);
    expect(r.turned).toEqual(["ws1"]);
  });

  it("places a merge hold once the turn cap is burned on a moved tip", async () => {
    let tip = 0;
    const deps = makeDeps({ branchTip: async () => `tip${++tip}` });
    let t = Date.now();
    for (let i = 0; i < 3; i++) {
      await reconcileReadyBaseConflicts({ ...deps, nowMs: (t += 10 * 60_000) });
    }
    expect(deps.sendTurn).toHaveBeenCalledTimes(2);
    expect(setMergeHold).toHaveBeenCalledTimes(1);
  });

  it("does not touch a busy workspace", async () => {
    const rebase = vi.fn();
    const r = await reconcileReadyBaseConflicts(makeDeps({ isBusy: async () => true, rebase }));
    expect(rebase).not.toHaveBeenCalled();
    expect(r.skipped).toBe(1);
  });
});

describe("keep-both resolution", () => {
  it("keeps both sides and drops markers and the diff3 base", () => {
    const merged = keepBothSides("top\n<<<<<<< HEAD\nours\n||||||| base\norig\n=======\ntheirs\n>>>>>>> branch\nbottom");
    expect(merged).toBe("top\nours\ntheirs\nbottom");
  });

  it("only CONTINUE.md qualifies", () => {
    expect(isKeepBothOnly(["CONTINUE.md"])).toBe(true);
    expect(isKeepBothOnly(["CONTINUE.md", "a.ts"])).toBe(false);
    expect(isKeepBothOnly([])).toBe(false);
  });

  it("the fix turn lists files even when git named none", () => {
    expect(formatBaseConflictFixTurn({ branch: "b", baseBranch: "master", files: [], baseCommits: [] })).toContain("git did not name them");
  });
});
