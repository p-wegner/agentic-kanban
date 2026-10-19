// @gate:always-run when:scripts/promote-plan.mjs — imports scripts/promote-plan.mjs, which no package-local diff links to (#687).
/**
 * The rolling release candidate (#1631): a landing followed by an idle queue starts exactly one
 * sweep, a second landing during it starts no parallel one, and `pnpm promote` reuses a green
 * verdict on the tip without sweeping again. Driven through `runRollingRcSweepTick` with fake
 * deps — no git, no database, no probe.
 */
import { describe, expect, it } from "vitest";
import { parseSweepVerdict, planSweepAcquisition } from "../../../../scripts/promote-plan.mjs";
import { resolveRiskPosture } from "../services/risk-posture.service.js";
import { RISK_POSTURES } from "@agentic-kanban/shared/lib/risk-posture";
import { emptyRcState, findRcCandidate, serializeRcState, upsertRcCandidate, type RcStateFile } from "../services/rc-state.js";
import {
  decideRollingRcSweep,
  runRollingRcSweepTick,
  type RollingRcHealthRow,
  type RollingRcSweepDeps,
} from "../services/rc-rolling-sweep.service.js";
import type { RcSweepMode } from "@agentic-kanban/shared/types";

const PROJECT = { projectId: "p1", repoPath: "/repo" };
const T0 = Date.parse("2026-10-19T10:00:00.000Z");

function fakeBoard(opts: { mode?: RcSweepMode; masterSha?: string } = {}) {
  const board = {
    mode: opts.mode ?? ("on-idle-after-landing" as RcSweepMode),
    master: opts.masterSha ?? "m1",
    idle: true,
    probeInFlight: false,
    state: emptyRcState() as RcStateFile,
    branches: new Map<string, string>(),
    health: null as RollingRcHealthRow | null,
    sweeps: [] as string[],
    nowMs: T0,
  };
  const deps: RollingRcSweepDeps = {
    listProjects: async () => [PROJECT],
    readMode: async () => board.mode,
    isQueueIdle: async () => board.idle,
    isProbeInFlight: async () => board.probeInFlight,
    readMasterSha: async () => board.master,
    listRcBranches: async () => [...board.branches.keys()],
    readBranchSha: async (_p, b) => board.branches.get(b) ?? null,
    isAncestor: async (_p, a, d) => a === d || (a.startsWith("m") && d.startsWith("m") && Number(a.slice(1)) <= Number(d.slice(1))),
    isShipped: async () => false,
    pointBranch: async (_p, b, sha) => void board.branches.set(b, sha),
    readState: () => board.state,
    writeState: (_p, s) => void (board.state = s),
    readLatestRcHealth: async () => board.health,
    requestSweep: async (_p, branch) => {
      board.sweeps.push(`${branch}@${board.branches.get(branch)}`);
      board.probeInFlight = true;
      return { started: true, reason: "interval_elapsed" };
    },
    dateStamp: "20261019",
    get nowMs() { return board.nowMs; },
  };
  return { board, deps };
}

describe("rolling rc sweep (#1631)", () => {
  it("a landing followed by an idle queue starts exactly one sweep, on a freshly cut rc", async () => {
    const { board, deps } = fakeBoard();
    const [first] = await runRollingRcSweepTick(deps);
    expect(first!.started).toBe(true);
    expect(first!.decision.action).toBe("cut");
    expect(board.sweeps).toEqual(["rc/20261019@m1"]);
    expect(findRcCandidate(board.state, "rc/20261019")).toMatchObject({ sha: "m1", state: "sweeping" });

    // Further ticks while the sweep runs, and with nothing new landed, start nothing.
    await runRollingRcSweepTick(deps);
    await runRollingRcSweepTick(deps);
    expect(board.sweeps).toHaveLength(1);
  });

  it("does not start while the merge queue is busy, and starts once it goes idle", async () => {
    const { board, deps } = fakeBoard();
    board.idle = false;
    const [busy] = await runRollingRcSweepTick(deps);
    expect(busy!.decision).toEqual({ action: "skip", reason: "queue_busy" });
    expect(board.sweeps).toHaveLength(0);
    board.idle = true;
    await runRollingRcSweepTick(deps);
    expect(board.sweeps).toHaveLength(1);
  });

  it("a second landing during the sweep does not start a parallel one; the next tick after it finishes advances the rc", async () => {
    const { board, deps } = fakeBoard();
    await runRollingRcSweepTick(deps);
    board.master = "m2"; // more landed while the sweep is in flight
    const [during] = await runRollingRcSweepTick(deps);
    expect(during!.decision).toEqual({ action: "skip", reason: "sweep_in_flight" });
    expect(board.sweeps).toHaveLength(1);

    // The sweep finishes green on the OLD sha; the verdict is recorded on it, then the rc rolls forward.
    board.probeInFlight = false;
    board.health = { sha: "m1", outcome: "green", failedSuites: [] };
    const [after] = await runRollingRcSweepTick(deps);
    expect(after!.decision).toMatchObject({ action: "advance", branch: "rc/20261019", sha: "m2" });
    expect(board.branches.get("rc/20261019")).toBe("m2");
    expect(board.sweeps).toEqual(["rc/20261019@m1", "rc/20261019@m2"]);
  });

  it("records the verdict on the rc sha: green, and red with its failing suites", async () => {
    const { board, deps } = fakeBoard();
    await runRollingRcSweepTick(deps);
    board.probeInFlight = false;
    board.health = { sha: "m1", outcome: "green", failedSuites: [] };
    const [done] = await runRollingRcSweepTick(deps);
    expect(done!.decision).toEqual({ action: "skip", reason: "already_green" });
    expect(findRcCandidate(board.state, "rc/20261019")).toMatchObject({ sha: "m1", state: "green" });

    const red = fakeBoard();
    await runRollingRcSweepTick(red.deps);
    red.board.probeInFlight = false;
    red.board.health = { sha: "m1", outcome: "red", failedSuites: ["a.test.ts"] };
    const [r] = await runRollingRcSweepTick(red.deps);
    expect(r!.decision).toEqual({ action: "skip", reason: "rc_red" });
    expect(findRcCandidate(red.board.state, "rc/20261019")).toMatchObject({ state: "red", failedSuites: ["a.test.ts"] });
    // A red rc is healed ON the candidate: master moving does not cut past it.
    red.board.master = "m2";
    await runRollingRcSweepTick(red.deps);
    expect(red.board.sweeps).toHaveLength(1);
  });

  it("a project on `on-promote` is never swept by the board", async () => {
    const { board, deps } = fakeBoard({ mode: "on-promote" });
    const [r] = await runRollingRcSweepTick(deps);
    expect(r!.decision).toEqual({ action: "skip", reason: "on_promote" });
    expect(board.sweeps).toHaveLength(0);
    expect(board.state.candidates).toHaveLength(0);
  });

  it("re-sweeps a `sweeping` candidate whose probe died without an answer, but only after the back-off", () => {
    const base = { mode: "on-idle-after-landing" as const, queueIdle: true, probeInFlight: false, masterSha: "m1", tipIsAncestorOfMaster: true, shipped: false };
    const candidate = { branch: "rc/20261019", sha: "m1", tipSha: "m1", state: "sweeping" as const, cutAt: null, updatedAt: new Date(T0).toISOString(), tag: null, failedSuites: [], note: null };
    expect(decideRollingRcSweep({ ...base, candidate, nowMs: T0 + 60_000 })).toEqual({ action: "skip", reason: "retry_backoff" });
    expect(decideRollingRcSweep({ ...base, candidate, nowMs: T0 + 31 * 60_000 })).toMatchObject({ action: "sweep", branch: "rc/20261019" });
  });
});

describe("posture field rcSweep", () => {
  it("sprint and flow sweep on idle after a landing; every other level keeps its cadence", () => {
    const modes = Object.fromEntries(RISK_POSTURES.map((level) => [level, resolveRiskPosture(new Map([["risk_posture_p1", level]]), "p1").rcSweep]));
    expect(modes).toEqual({
      strict: "on-promote",
      standard: "on-promote",
      iterate: "on-promote",
      fast: "on-promote",
      sprint: "on-idle-after-landing",
      flow: "on-idle-after-landing",
    });
  });
});

describe("promote after a rolling sweep", () => {
  it("reuses a green verdict on the tip without requesting another sweep", () => {
    const tip = "abc1234def";
    const verdict = parseSweepVerdict(
      { sha: tip, branch: "rc/20261019", outcome: "green", message: null, createdAt: new Date(Date.now() - 20 * 60_000).toISOString() },
      { branch: "rc/20261019" },
    );
    expect(verdict.ok).toBe(true);
    const plan = planSweepAcquisition({ verdict, headSha: tip, direction: { ok: true, reason: "forward", detail: "rc is ahead of stable" }, canRequest: true });
    expect(plan.request).toBe(false);
  });
});

describe("rc-state writer mirror", () => {
  it("serializes what the mjs writer would", () => {
    const state = upsertRcCandidate(emptyRcState(), "rc/20261019", { sha: "m1", state: "cut" }, "2026-10-19T10:00:00.000Z");
    expect(serializeRcState(state)).toBe(`${JSON.stringify({ version: 1, candidates: state.candidates }, null, 2)}\n`);
  });
});
