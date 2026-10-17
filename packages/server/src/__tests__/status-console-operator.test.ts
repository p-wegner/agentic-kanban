import { describe, it, expect, beforeEach } from "vitest";
import { buildConsoleModel, renderConsole, type ConsoleModel, type ConsolePayloads } from "../cli/status-console.js";
import { chainKindOf, chainRefOf } from "../cli/status-console-extras.js";
import { classifyStall } from "../services/console-extras.service.js";
import { reportVerifyChainProgress } from "../services/verify-chain-registry.js";
import { listVerifyChains, resetVerifyChainSemaphoreForTests, runUnderVerifyChainSemaphore } from "../services/verify-chain-semaphore.js";

// #1449: everything the operator had to look up during the 2026-10-12/13 drives is in the frame.
const NOW = Date.UTC(2026, 9, 13, 17, 19, 0);
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

const model: ConsoleModel = {
  project: "agentic-kanban", generatedAt: new Date(NOW).toISOString(), boardVersion: null, boardTag: "stable-20261013-3", boardCommit: "2dcf8de",
  openIssues: 6, runningSessions: 2,
  host: { freeGb: 3.1, floorGb: 2, hold: false, reason: null, verifyActive: 1, verifySlots: 1, verifyQueued: 2 },
  workers: [
    { name: "ao-pf38", os: "win", status: "online", load: 1, maxConcurrency: 3, build: "2dcf8de", heartbeatAt: ago(4), freeRamGb: 11.2, freeDiskGb: 84, pinned: ["maxConcurrency"], desiredPending: true,
      tickets: [{ issueNumber: 1431, status: "running", phase: "fix", startedAt: ago(600) }], verifyJobs: ["rc-sweep 1a2b3c4d5 (full) tests 12/340"] },
    { name: "wsl-stable", os: "wsl", status: "online", load: 0, maxConcurrency: 2, build: "2dcf8de", heartbeatAt: ago(2), authExpired: true, tickets: [] },
  ],
  trains: [{ label: "train/2026-10-13-05", state: "red", startedAt: ago(4000), finishedAt: ago(3500), members: 2, landed: 0, dropped: 2, gateRuns: 1, gateFailure: null,
    droppedDetail: [{ ref: "#1429", reason: "conflicts with #1430 in status-console.ts" }, { ref: "#1430", reason: "gate red: worker-cli-isolation", deferred: true }] }],
  window: { pending: [1429, 1430], firstSeenAt: ago(900), maxWaitMs: 120000 },
  issues: [{ issueNumber: 1431, title: "a", statusName: "In Progress", column: "Build" }],
  attention: [
    { level: "red", text: "merges held: base_red (master 1a2b3c4d), holding #1429 #1430" },
    { level: "yellow", text: "#1437 In Progress: no running session or queued chain" },
    { level: "red", text: "#1441 Agent hang watchdog: no output for 900s" },
  ],
  mergedToday: 18,
  chains: [
    { kind: "workspace gate", ref: "#1435", where: "host", state: "running", ageMs: 725000, stage: "tests", filesDone: 120, filesTotal: 340 },
    { kind: "base-health probe", ref: "master", where: "host", state: "queued", ageMs: 240000, position: 1, waitReason: "held for memory: 1.9 GB free; re-checked every 30s" },
    { kind: "rc sweep", ref: "1a2b3c4d5", where: "ao-pf38", state: "running", ageMs: 95000, stage: "(full) tests 12/340" },
  ],
  baseHealth: { outcome: "red", sha: "1a2b3c4d5e6f", createdAt: ago(7200), failedSuites: ["status-console", "worker-cli-isolation", "x"] },
  mergeHold: { reason: "base_red", held: [1429, 1430] },
  rc: { branch: "rc/20261013", sha: "abc1234def", state: "sweeping", updatedAt: ago(300) },
  unpromoted: 7,
  placement: { mode: "prefer-worker", workers: ["ao-pf38"] },
  connectCodes: [{ codeHint: "k3f9", status: "active", steps: [{ step: "paired", status: "ok" }, { step: "doctor", status: "failed" }] }],
  errors: [],
};
const base = { nowMs: NOW, intervalSec: 5, timeZone: "UTC" };

describe("operator console frame (#1449)", () => {
  for (const cols of [80, 140]) {
    for (const color of [false, true]) {
      it(`snapshot at ${cols} cols, ${color ? "color" : "no color"}`, () => {
        expect(renderConsole(model, { ...base, cols, rows: 60, color }).join("\n")).toMatchSnapshot();
      });
    }
    it(`fits ${cols} columns`, () => {
      for (const l of renderConsole(model, { ...base, cols, rows: 60, color: false })) expect(l.length).toBeLessThanOrEqual(cols);
    });
  }

  it("answers the operator questions from the frame alone", () => {
    const out = renderConsole(model, { ...base, cols: 200, rows: 60, color: false }).join("\n");
    for (const s of ["workspace gate #1435", "held for memory", "master red 1a2b3c4d", "holding #1429 #1430", "rc/20261013", "7 merges not yet promoted",
      "verify placement prefer-worker", "ram 11.2G disk 84G", "[auth-expired]", "running/fix", "dropped #1429: conflicts with #1430", "NEW WORKER CONNECTIONS", "since 00:00 local"]) {
      expect(out).toContain(s);
    }
  });
});

describe("short pane with a long attention list (#1567)", () => {
  const nums = Array.from({ length: 15 }, (_, k) => 1550 + k);
  const crowded: ConsoleModel = {
    ...model,
    openIssues: 16,
    issues: [
      ...nums.map((n) => ({ issueNumber: n, title: "t", statusName: "In Review", column: "Review" as const })),
      { issueNumber: 1565, title: "b", statusName: "Build", column: "Build" as const },
    ],
    attention: [
      ...nums.slice(0, 14).map((n) => ({ level: "yellow" as const, text: `#${n} In Review waiting on train/2026-10-17-01` })),
      { level: "red" as const, text: "#1565 Agent hang watchdog: no output for 900s" },
    ],
  };

  it("keeps header, pipeline summary, train line and a capped attention list at 34 rows", () => {
    const out = renderConsole(crowded, { ...base, cols: 127, rows: 34, color: false });
    expect(out.length).toBeLessThanOrEqual(34);
    expect(out[0]).toContain("agentic-kanban");
    const text = out.join("\n");
    expect(text).toContain("In Review 15");
    expect(text).toContain("MERGE TRAIN");
    expect(text).toContain("14 In Review waiting on train/2026-10-17-01: #1550 #1551");
    expect(text.split("\n").filter((l) => /^ [✖⚠]/.test(l)).length).toBeLessThanOrEqual(Math.max(3, Math.floor(34 / 4)));
  });

  it("caps ungroupable attention with a +N more pointer", () => {
    const many: ConsoleModel = { ...crowded, attention: Array.from({ length: 20 }, (_, k) => ({ level: "red" as const, text: `reason ${k}` })) };
    const text = renderConsole(many, { ...base, cols: 127, rows: 34, color: false }).join("\n");
    expect(text).toContain("+12 more (a: all issues)");
  });
});

describe("chain progress and elapsed (#1462)", () => {
  it("shows stage, files done/total and elapsed on every running chain line", () => {
    for (const cols of [80, 140]) {
      const out = renderConsole(model, { ...base, cols, rows: 60, color: false }).join("\n");
      expect(out).toMatch(/workspace gate #1435\s+host\s+12m05s\s+tests 120\/340/);
      expect(out).toMatch(/rc sweep 1a2b3c4d5\s+ao-pf38\s+1m35s\s+\(full\) tests 12\/340/);
    }
  });

  it("derives a worker chain's age from the job start time in the heartbeat", () => {
    const m = buildConsoleModel({
      nowMs: NOW,
      status: { project: { id: "p", name: "proj", repoPath: "/x", defaultBranch: "master" }, generatedAt: new Date(NOW).toISOString(), totals: { totalIssues: 0, inProgress: 0, activeWorkspaces: 0, runningSessions: 0 }, issues: [] },
      workers: { workers: [{ name: "wsl", effectiveStatus: "online", verifyJobs: [{ kind: "rc-sweep", sha: "1a2b3c4d5e6f", tier: "full", stage: "verify", filesDone: 3, filesTotal: 9, startedAt: ago(30) }] }] },
    });
    expect(m.chains?.[0]).toMatchObject({ where: "wsl", ageMs: 30000 });
  });

  it("carries a host chain's reported stage and files into the snapshot", async () => {
    resetVerifyChainSemaphoreForTests();
    let seen: ReturnType<typeof listVerifyChains> = [];
    await runUnderVerifyChainSemaphore(async () => {
      reportVerifyChainProgress("gate #7", { stage: "tests", filesDone: 4, filesTotal: 10 });
      seen = listVerifyChains();
    }, "gate #7");
    expect(seen[0]).toMatchObject({ stage: "tests", filesDone: 4, filesTotal: 10 });
  });
});

describe("buildConsoleModel with extras", () => {
  const status = { project: { id: "p", name: "ak" }, issues: [
    { issueNumber: 1437, issueId: "i1", title: "t", statusName: "In Progress", workspace: { id: "ws-1437", branch: "feature/ak-1437", status: "active" }, session: null, remoteUnlanded: null, attention: null, mergeState: null },
    { issueNumber: 1441, issueId: "i2", title: "t", statusName: "In Review", workspace: { id: "ws-1441", branch: "feature/ak-1441", status: "reviewing" }, session: { status: "stopped" }, mergeState: null },
    { issueNumber: 1444, issueId: "i3", title: "t", statusName: "In Progress", workspace: { id: "ws-1444", branch: "b" }, session: { status: "running" }, mergeState: null },
  ] } as unknown as ConsolePayloads["status"];

  it("flags stranded work, stalls and a base_red hold; leaves a running session alone", () => {
    const m = buildConsoleModel({
      status, nowMs: NOW,
      host: { freeGb: 5, floorGb: 2, hold: false, verify: { active: 0, slots: 1, queued: 0 }, unpromotedMerges: 3 },
      window: { ok: true, window: { projectId: "p", pending: [{ workspaceId: "ws-1437", issueNumber: 1437, issueTitle: null, readySince: null }], firstSeenAt: ago(10), config: { maxSize: 4, maxWaitMs: 120000, fromPosture: false, postureLevel: "standard" }, lastVerdict: { release: false, reason: "base_red" }, lastEvaluatedAt: ago(1) } } as never,
      extras: {
        chains: [{ label: "pre-merge gate for workspace ws-1444", priority: "gate", state: "running", ageMs: 5000 }],
        baseHealth: { outcome: "red", sha: "deadbeefcafe", branch: "master", createdAt: ago(60), message: null, failedSuites: ["a"] },
        stalls: [{ issueNumber: 1441, kind: "watchdog", text: "Agent hang watchdog: no output for 900s", at: ago(30) }],
      },
    });
    const text = m.attention.map((a) => a.text).join("\n");
    expect(text).not.toContain("#1437 In Progress: no running"); // #1566: held in the window, so driven
    expect(text).toContain("#1441 Agent hang watchdog");
    expect(text).not.toContain("#1441 In Review: no running");
    expect(text).not.toContain("#1444");
    expect(text).toContain("merges held: base_red (master deadbeef), holding #1437");
    expect(m.unpromoted).toBe(3);
    expect(m.chains?.[0]).toMatchObject({ kind: "workspace gate", ref: "#1444", where: "host" });
  });
});

describe("ATTENTION has-a-driver predicate (#1566)", () => {
  const mk = (n: number, extra: Record<string, unknown> = {}) => ({ issueNumber: n, issueId: `i${n}`, title: "t", statusName: "In Review", workspace: { id: `ws-${n}`, branch: `b${n}`, status: "reviewing" }, session: { status: "stopped" }, mergeState: null, attention: null, remoteUnlanded: null, ...extra });
  const status = { project: { id: "p", name: "ak" }, issues: [mk(1), mk(2), mk(3), mk(4), mk(5, { session: { status: "running" }, remoteUnlanded: { workerId: "04544649aaaa", sessionId: "s", label: "remote — committed work not yet landed" } }), mk(6, { remoteUnlanded: { workerId: "04544649aaaa", sessionId: "s", label: "ended" } })] } as unknown as ConsolePayloads["status"];
  const trains = { ok: true, trains: [
    { id: "t1", projectId: "p", label: "train/x", memberWorkspaceIds: JSON.stringify(["ws-1", "ws-2"]), state: "gating", gateEvidence: null, bisectResult: null, reconciledReason: null, startedAt: ago(1000), finishedAt: null },
    { id: "t0", projectId: "p", label: "train/old", memberWorkspaceIds: JSON.stringify(["ws-4"]), state: "landed", gateEvidence: null, bisectResult: null, reconciledReason: null, startedAt: ago(9000), finishedAt: ago(8000) },
  ] } as unknown as ConsolePayloads["trains"];
  const window = { ok: true, window: { projectId: "p", pending: [{ workspaceId: "ws-3", issueNumber: 3, issueTitle: null, readySince: null }], firstSeenAt: ago(10), config: { maxSize: 4, maxWaitMs: 1800000, fromPosture: true, postureLevel: "sprint" }, lastVerdict: { release: false, reason: "accumulating" }, lastEvaluatedAt: ago(1) } } as unknown as ConsolePayloads["window"];

  it("treats train members, window waiters and running builders as driven; still flags a driverless ticket", () => {
    const text = buildConsoleModel({ status, trains, window, nowMs: NOW }).attention.map((a) => a.text).join("\n");
    expect(text).not.toContain("#1 In Review");
    expect(text).not.toContain("#2 In Review");
    expect(text).not.toContain("#3 In Review");
    expect(text).not.toContain("#5 ");
    expect(text).toContain("#4 In Review: no running session or queued chain"); // its train already landed
    expect(text).toContain("#6 unlanded result"); // session ended
  });
});

describe("chain labels and stalls", () => {
  it("classifies kinds and refs", () => {
    expect(chainKindOf("implement-exit typecheck for workspace w")).toBe("implement-exit check");
    expect(chainKindOf("base-branch health probe")).toBe("base-health probe");
    expect(chainKindOf("E2E smoke lane for workspace w")).toBe("e2e smoke");
    expect(chainRefOf("gate #1435", [])).toBe("#1435");
  });
  it("names watchdog, no-worker and refused-push stalls", () => {
    expect(classifyStall(["Agent hang watchdog: no output for 900s"])?.kind).toBe("watchdog");
    expect(classifyStall(["[dispatch:launch-failed] NO_AVAILABLE_WORKER - remote launch"])?.kind).toBe("no_worker");
    expect(classifyStall(["refused refs/incoming/ws-1: stale but clean rebase"])?.text).toContain("refs/incoming/ws-1");
    expect(classifyStall(["ordinary error"])).toBeNull();
  });
});

describe("listVerifyChains", () => {
  beforeEach(() => resetVerifyChainSemaphoreForTests());
  it("reports the running chain and a queued one with its wait reason", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const first = runUnderVerifyChainSemaphore(() => gate, "gate #1");
    const second = runUnderVerifyChainSemaphore(async () => undefined, "base-branch health probe", undefined, undefined, { priority: "background" });
    const chains = listVerifyChains();
    expect(chains.map((c) => [c.label, c.state])).toEqual([["gate #1", "running"], ["base-branch health probe", "queued"]]);
    expect(chains[1]!.position).toBe(1);
    expect(chains[1]!.waitReason).toBeTruthy();
    release();
    await Promise.all([first, second]);
    expect(listVerifyChains()).toEqual([]);
  });
});
