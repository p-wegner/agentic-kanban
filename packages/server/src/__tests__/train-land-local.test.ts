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
    loadMembers: async (ids) => members.filter((m) => ids.includes(m.workspaceId)),
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

  it("assembles only members the evidence did not defer, and --only/--skip narrow further (#1590)", async () => {
    const evidence = { dropped: [{ workspaceId: "w2", reason: "conflicts with #11", deferred: true }], landed: [] };
    const getTrain = async () => ({ id: "t1", projectId: "p1", label: "train/2026-10-17-08", state: "red", memberWorkspaceIds: ["w1", "w2"], gateEvidence: evidence });
    const gateSteps = [{ name: "g", command: "true" }];
    const a = makeDeps({ getTrain });
    const out = await landTrainLocal({ projectId: "p1", trainId: "t1", skipInstall: true, gateSteps }, a.deps);
    expect(out).toMatchObject({ status: "landed", closed: [11] });
    expect(a.deps.closeMember).toHaveBeenCalledTimes(1);
    expect(a.gitCalls.some((c) => c[0] === "merge" && c.at(-1) === "feature/ak-12-b")).toBe(false);

    const b = makeDeps();
    expect(await landTrainLocal({ projectId: "p1", trainId: "t1", skipInstall: true, only: [12], gateSteps }, b.deps)).toMatchObject({ status: "landed", closed: [12] });
    const c = makeDeps();
    expect(await landTrainLocal({ projectId: "p1", trainId: "t1", skipInstall: true, skip: [12], gateSteps }, c.deps)).toMatchObject({ status: "landed", closed: [11] });
  });

  it("never closes a member whose branch is not merged into the worktree (#1590)", async () => {
    const { deps } = makeDeps({
      git: async (args) => {
        if (args[0] === "merge-base" && args.includes("feature/ak-12-b")) return { code: 1, stdout: "", stderr: "" };
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "master\n", stderr: "" };
        if (args[0] === "rev-parse") return { code: 0, stdout: "abcdef1234567890\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      pathExists: () => true,
    });
    const out = await landTrainLocal({ projectId: "p1", trainId: "t1", continueRun: true, gateSteps: [{ name: "g", command: "true" }] }, deps);
    expect(out).toMatchObject({ status: "landed", closed: [11] });
    expect(deps.closeMember).toHaveBeenCalledTimes(1);
  });

  it("--on-worker places install + the gate on a worker and never runs them on this host (#1612)", async () => {
    const run = vi.fn(async () => ({ code: 0, tail: "" }));
    const runOnWorker = vi.fn(async () => ({ status: "ran" as const, workerName: "w-1", passed: true, log: "" }));
    const { deps } = makeDeps({ run, runOnWorker });
    const out = await landTrainLocal({ projectId: "p1", trainId: "t1", onWorker: "w-1", gateSteps: [{ name: "g", command: "true" }] }, deps);
    expect(out.status).toBe("landed");
    expect(run).not.toHaveBeenCalled();
    expect(runOnWorker).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "p1", workerName: "w-1", changedFiles: ["a.ts", "b.ts"], steps: [{ name: "install", command: "pnpm install -r" }, { name: "g", command: "true" }],
    }));
  });

  it("--on-worker red keeps the worktree and reports the failing step; unavailable is an error, not a pass (#1612)", async () => {
    const red = makeDeps({ runOnWorker: async () => ({ status: "ran", workerName: "w-1", passed: false, failedStep: "typecheck", log: "FAIL  a/x.test.ts > y" }) });
    expect(await landTrainLocal({ projectId: "p1", trainId: "t1", onWorker: true }, red.deps))
      .toMatchObject({ status: "red", step: "typecheck", failedSuites: ["a/x.test.ts"] });
    expect(red.deps.closeMember).not.toHaveBeenCalled();
    expect(red.prefs.get("auto_merge_disabled_p1")).toBe("false");
    const none = makeDeps({ runOnWorker: async () => ({ status: "unavailable", reason: "no allowlisted worker is online" }) });
    expect(await landTrainLocal({ projectId: "p1", trainId: "t1", onWorker: true }, none.deps))
      .toMatchObject({ status: "error", message: expect.stringContaining("no allowlisted worker") });
    expect(none.deps.closeMember).not.toHaveBeenCalled();
  });

  it("defaults to a worker when one is connected, falls back to a capped host gate without one, --on-host skips the worker (#1649)", async () => {
    const steps = [{ name: "g", command: "true" }];
    const run = vi.fn(async () => ({ code: 0, tail: "" }));
    const ran = vi.fn(async () => ({ status: "ran" as const, workerName: "w-1", passed: true, log: "" }));
    const placed = makeDeps({ run, runOnWorker: ran, hostMaxWorkers: () => 4 });
    expect((await landTrainLocal({ projectId: "p1", trainId: "t1", gateSteps: steps }, placed.deps)).status).toBe("landed");
    expect(ran).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();

    const none = vi.fn(async () => ({ status: "unavailable" as const, reason: "no worker" }));
    const hostRun = vi.fn(async () => ({ code: 0, tail: "" }));
    const fallback = makeDeps({ run: hostRun, runOnWorker: none, hostMaxWorkers: () => 4 });
    expect((await landTrainLocal({ projectId: "p1", trainId: "t1", skipInstall: true, gateSteps: steps }, fallback.deps)).status).toBe("landed");
    expect(hostRun).toHaveBeenCalledWith("true", expect.any(String), expect.objectContaining({ KANBAN_TEST_MAX_WORKERS: "4", VITEST_MAX_WORKERS: "4" }));

    const ran2 = vi.fn(async () => ({ status: "ran" as const, workerName: "w-1", passed: true, log: "" }));
    const host = makeDeps({ run: vi.fn(async () => ({ code: 0, tail: "" })), runOnWorker: ran2 });
    await landTrainLocal({ projectId: "p1", trainId: "t1", onHost: true, skipInstall: true, gateSteps: steps }, host.deps);
    expect(ran2).not.toHaveBeenCalled();
  });

  it("the leftover-worktree error names --continue --on-worker (#1649)", async () => {
    const { deps } = makeDeps({ pathExists: () => true });
    expect(await landTrainLocal({ projectId: "p1", trainId: "t1" }, deps))
      .toMatchObject({ status: "error", message: expect.stringContaining("--continue --on-worker") });
  });

  it("derives a sibling .worktrees path and parses failing suites", () => {
    expect(landLocalWorktreePath("/r/proj", "train/2026-10-17-04").replace(/\\/g, "/")).toBe("/r/.worktrees/proj/land-local/2026-10-17-04");
    expect(parseFailedSuites("FAIL  a/b.test.ts > x\n ❯ c/d.test.tsx 3 tests")).toEqual(["a/b.test.ts", "c/d.test.tsx"]);
  });
});

describe("landTrainLocal --from-window label discovery (#1660)", () => {
  const wt = (label: string) => `worktree /r/.worktrees/proj/land-local/${label}\nHEAD abc\nbranch refs/heads/kanban/land-local/${label}\n\n`;
  const withList = (labels: string[], over: Partial<LandLocalDeps> = {}) =>
    makeDeps({
      git: async (args) => {
        if (args[0] === "worktree" && args[1] === "list") return { code: 0, stdout: `worktree /r/proj\nHEAD x\nbranch refs/heads/master\n\n${labels.map(wt).join("")}`, stderr: "" };
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "master\n", stderr: "" };
        if (args[0] === "rev-parse" && args[1] === "--verify") return { code: 1, stdout: "", stderr: "" };
        if (args[0] === "rev-parse") return { code: 0, stdout: "abcdef1234567890\n", stderr: "" };
        if (args[0] === "diff") return { code: 0, stdout: "a.ts\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      pathExists: (p) => labels.some((l) => p.endsWith(`/land-local/${l}`)),
      nowIso: () => "2026-10-20T18:04:00.000Z",
      ...over,
    });
  const gate = [{ name: "g", command: "true" }];

  it("--continue minutes later resumes the red run's worktree and branch", async () => {
    const { deps, gitCalls } = withList(["local-202610201757"]);
    const out = await landTrainLocal({ projectId: "p1", fromWindow: true, continueRun: true, gateSteps: gate }, deps);
    expect(out.status).toBe("landed");
    expect(out).toMatchObject({ label: "local-202610201757" });
    expect(gitCalls.some((a) => a.join(" ").includes("local-202610201804"))).toBe(false);
  });

  it("two leftovers and no --label refuses naming both; --label picks one", async () => {
    const two = withList(["local-202610201757", "local-202610201759"]);
    const out = await landTrainLocal({ projectId: "p1", fromWindow: true, continueRun: true, gateSteps: gate }, two.deps);
    expect(out.status).toBe("error");
    const msg = (out as { message: string }).message;
    expect(msg).toContain("local-202610201757");
    expect(msg).toContain("local-202610201759");
    const picked = withList(["local-202610201757", "local-202610201759"]);
    const ok = await landTrainLocal({ projectId: "p1", fromWindow: true, continueRun: true, label: "local-202610201759", gateSteps: gate }, picked.deps);
    expect(ok.status).toBe("landed");
  });

  it("no worktree: the error lists the land-local worktrees that exist", async () => {
    const { deps } = withList(["train-x"]);
    const out = await landTrainLocal({ projectId: "p1", fromWindow: true, continueRun: true, gateSteps: gate }, deps);
    expect(out.status).toBe("error");
    expect((out as { message: string }).message).toContain("/land-local/train-x");
  });
});
