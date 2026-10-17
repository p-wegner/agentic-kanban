import { describe, expect, it, vi } from "vitest";
import {
  landTrainLocal,
  landLocalWorktreePath,
  parseFailedSuites,
  type LandLocalDeps,
} from "../services/train-land-local.service.js";

const members = [
  { workspaceId: "w1", issueId: "i1", issueNumber: 11, branch: "feature/ak-11-a" },
  { workspaceId: "w2", issueId: "i2", issueNumber: 12, branch: "feature/ak-12-b" },
];

function makeDeps(over: Partial<LandLocalDeps> = {}) {
  const prefs = new Map<string, string>([["auto_merge_disabled_p1", "false"]]);
  const holds: number[] = [];
  const gitCalls: string[][] = [];
  const deps: LandLocalDeps = {
    log: () => {},
    getTrain: async () => ({ id: "t1", projectId: "p1", label: "train/2026-10-17-04", state: "gating", memberWorkspaceIds: ["w1", "w2"] }),
    getTrainProjectId: async () => "p1",
    getWindowMemberIds: async () => ["w1", "w2"],
    loadMembers: async () => members,
    getProject: async () => ({ repoPath: "/r/proj", defaultBranch: "master" }),
    getPref: async (k) => prefs.get(k) ?? null,
    setPref: async (k, v) => void prefs.set(k, v),
    deletePref: async (k) => void prefs.delete(k),
    holdWindow: async (_p, minutes) => void holds.push(minutes),
    abandonTrain: vi.fn(async () => {}),
    createTrainRow: vi.fn(async () => {}),
    markTrainLanded: vi.fn(async () => {}),
    closeMember: vi.fn(async () => {}),
    git: async (args) => {
      gitCalls.push(args);
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "master\n", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--verify") return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "abcdef1234567890\n", stderr: "" };
      if (args[0] === "diff") return { code: 0, stdout: "a.ts\nb.ts\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    run: async () => ({ code: 0, tail: "" }),
    pathExists: () => false,
    newId: () => "new-id",
    nowIso: () => "2026-10-17T10:00:00.000Z",
    ...over,
  };
  return { deps, prefs, holds, gitCalls };
}

describe("landTrainLocal (#1586)", () => {
  it("lands green: standard subject, members closed, worktree removed, auto-merge and hold restored", async () => {
    const { deps, prefs, holds, gitCalls } = makeDeps();
    const out = await landTrainLocal({ projectId: "p1", trainId: "t1", gateSteps: [{ name: "g", command: "true" }] }, deps);
    expect(out.status).toBe("landed");
    expect(deps.closeMember).toHaveBeenCalledTimes(2);
    expect(deps.abandonTrain).toHaveBeenCalledWith("t1", expect.stringContaining("land-local"));
    expect(deps.markTrainLanded).toHaveBeenCalledWith("t1", expect.objectContaining({ landedLocally: true }));
    const mergeCall = gitCalls.find((c) => c[0] === "merge" && c.includes("-m") && c.at(-1)?.startsWith("kanban/land-local/"));
    expect(mergeCall?.[mergeCall.indexOf("-m") + 1]).toMatch(/^Merge train 2026-10-17-04: #11 #12\n/);
    expect(gitCalls.some((c) => c[0] === "worktree" && c[1] === "remove")).toBe(true);
    expect(prefs.get("auto_merge_disabled_p1")).toBe("false");
    expect(holds[0]).toBeGreaterThan(0);
    expect(holds.at(-1)).toBe(0);
  });

  it("stops red with the failing suites, keeps the worktree, and still restores auto-merge", async () => {
    const { deps, prefs, holds, gitCalls } = makeDeps({
      run: async (cmd) => (cmd === "boom"
        ? { code: 1, tail: " FAIL  packages/server/src/__tests__/x.test.ts > a\n" }
        : { code: 0, tail: "" }),
    });
    const out = await landTrainLocal({ projectId: "p1", trainId: "t1", skipInstall: true, gateSteps: [{ name: "test:mine", command: "boom" }] }, deps);
    expect(out).toMatchObject({ status: "red", step: "test:mine", failedSuites: ["packages/server/src/__tests__/x.test.ts"] });
    expect(deps.closeMember).not.toHaveBeenCalled();
    expect(gitCalls.some((c) => c[0] === "worktree" && c[1] === "remove")).toBe(false);
    expect(prefs.get("auto_merge_disabled_p1")).toBe("false");
    expect(holds.at(-1)).toBe(0);
  });

  it("deletes the auto-merge pref on exit when it was unset before", async () => {
    const { deps, prefs } = makeDeps();
    prefs.delete("auto_merge_disabled_p1");
    await landTrainLocal({ projectId: "p1", trainId: "t1", skipInstall: true, gateSteps: [{ name: "g", command: "true" }] }, deps);
    expect(prefs.has("auto_merge_disabled_p1")).toBe(false);
  });

  it("--continue needs the leftover worktree; a fresh run refuses an existing one", async () => {
    const a = makeDeps();
    expect((await landTrainLocal({ projectId: "p1", trainId: "t1", continueRun: true }, a.deps)).status).toBe("error");
    const b = makeDeps({ pathExists: () => true });
    expect((await landTrainLocal({ projectId: "p1", trainId: "t1" }, b.deps)).status).toBe("error");
    expect(b.prefs.get("auto_merge_disabled_p1")).toBe("false");
  });

  it("--from-window creates a train row and does not cancel anything", async () => {
    const { deps } = makeDeps();
    const out = await landTrainLocal({ projectId: "p1", fromWindow: true, skipInstall: true, gateSteps: [{ name: "g", command: "true" }] }, deps);
    expect(out.status).toBe("landed");
    expect(deps.createTrainRow).toHaveBeenCalled();
    expect(deps.abandonTrain).not.toHaveBeenCalled();
  });

  it("derives a sibling .worktrees path and parses failing suites", () => {
    expect(landLocalWorktreePath("/r/proj", "train/2026-10-17-04").replace(/\\/g, "/")).toBe("/r/.worktrees/proj/land-local/2026-10-17-04");
    expect(parseFailedSuites("FAIL  a/b.test.ts > x\n ❯ c/d.test.tsx 3 tests")).toEqual(["a/b.test.ts", "c/d.test.tsx"]);
  });
});
