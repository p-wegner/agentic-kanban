import { describe, it, expect } from "vitest";
import { buildConsoleModel, renderConsole, consoleFrame, type ConsoleModel } from "../cli/status-console.js";

const NOW = Date.UTC(2026, 9, 12, 12, 19, 38);
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

const model: ConsoleModel = {
  project: "stable-20261012-2",
  generatedAt: new Date(NOW).toISOString(),
  boardVersion: "19b2329",
  openIssues: 7,
  runningSessions: 3,
  host: { freeGb: 7.3, floorGb: 2, hold: true, reason: "host saturated: 1.9 GB < 2 GB", verifyActive: 2, verifySlots: 3, verifyQueued: 2 },
  workers: [
    { name: "desktop-stable", os: "win", status: "online", load: 2, maxConcurrency: 2, build: "19b2329", heartbeatAt: ago(3),
      tickets: [{ issueNumber: 1414, status: "review", startedAt: ago(72) }, { issueNumber: 1406, status: "build", startedAt: ago(243) }] },
    { name: "wsl-stable", os: "wsl", status: "online", load: 1, maxConcurrency: 1, build: "19b2329", heartbeatAt: ago(2),
      tickets: [{ issueNumber: 1381, status: "build", startedAt: ago(160) }] },
  ],
  trains: [
    { label: "train-12", state: "gating", startedAt: ago(370), finishedAt: null, members: 2, landed: 0, dropped: 0, gateRuns: 1, gateFailure: null },
    { label: "train-11", state: "landed", startedAt: ago(3000), finishedAt: ago(2000), members: 2, landed: 2, dropped: 0, gateRuns: 1, gateFailure: null },
    { label: "train-10", state: "landed", startedAt: ago(5000), finishedAt: ago(4000), members: 3, landed: 2, dropped: 1, gateRuns: 2, gateFailure: null },
  ],
  window: { pending: [1392], firstSeenAt: ago(80), maxWaitMs: 120000 },
  issues: [
    { issueNumber: 1337, title: "todo", statusName: "Todo", column: "Todo" },
    { issueNumber: 1381, title: "build", statusName: "In Progress", column: "Build" },
    { issueNumber: 1416, title: "x".repeat(200), statusName: "In Progress", column: "Build" },
    { issueNumber: 1414, title: "review", statusName: "In Review", column: "Review" },
    { issueNumber: 1380, title: "merge", statusName: "In Review", column: "Merge" },
  ],
  attention: [
    { level: "red", text: "#1416 exit-check red: temp-dir-namespace-guard (feedback 1/2 sent)" },
    { level: "yellow", text: "host saturated: 1.9 GB < 2 GB" },
  ],
  mergedToday: 22,
  errors: [],
};

const base = { nowMs: NOW, intervalSec: 5, timeZone: "UTC" };

describe("renderConsole", () => {
  for (const cols of [80, 140]) {
    it(`snapshot at ${cols} cols, no color`, () => {
      expect(renderConsole(model, { ...base, cols, rows: 40, color: false }).join("\n")).toMatchSnapshot();
    });
    it(`snapshot at ${cols} cols, color`, () => {
      expect(renderConsole(model, { ...base, cols, rows: 40, color: true }).join("\n")).toMatchSnapshot();
    });
    it(`never exceeds ${cols} visible columns`, () => {
      for (const l of renderConsole(model, { ...base, cols, rows: 40, color: false })) expect(l.length).toBeLessThanOrEqual(cols);
    });
  }

  it("answers the operator questions: who runs what, held host, red suite, merged", () => {
    const out = renderConsole(model, { ...base, cols: 120, rows: 40, color: false }).join("\n");
    expect(out).toContain("#1414 review 1m12s");
    expect(out).toContain("held: host saturated");
    expect(out).toContain("train-12");
    expect(out).toContain("temp-dir-namespace-guard");
    expect(out).toContain("MERGED TODAY 22");
  });

  it("keeps WORKERS and ATTENTION when the screen is short, dropping history first", () => {
    const out = renderConsole(model, { ...base, cols: 100, rows: 12, color: false }).join("\n");
    expect(out).toContain("WORKERS");
    expect(out).toContain("ATTENTION");
    expect(out).not.toContain("MERGED TODAY");
  });

  it("uses ASCII glyphs and no escape codes when asked", () => {
    const out = renderConsole(model, { ...base, cols: 100, rows: 40, color: false, ascii: true }).join("\n");
    expect(out).not.toMatch(/[^\x00-\x7f]/);
    expect(out).not.toContain("\x1b");
  });

  it("repaints with cursor home + clear-to-end, not a full clear", () => {
    const frame = consoleFrame(["a", "b"]);
    expect(frame.startsWith("\x1b[H")).toBe(true);
    expect(frame).not.toContain("\x1b[2J");
  });
});

describe("buildConsoleModel", () => {
  it("counts remote sessions as running and surfaces an offline worker", () => {
    const m = buildConsoleModel({
      nowMs: NOW,
      status: {
        project: { id: "p", name: "proj", repoPath: "/x", defaultBranch: "master" },
        generatedAt: new Date(NOW).toISOString(),
        totals: { totalIssues: 0, inProgress: 0, activeWorkspaces: 0, runningSessions: 0 },
        issues: [],
      },
      workers: { workers: [
        { name: "a", effectiveStatus: "online", load: 1, maxConcurrency: 2, assignments: [{ issueNumber: 5, status: "running", startedAt: ago(10) }] },
        { name: "b", effectiveStatus: "offline", load: 0, maxConcurrency: 1, assignments: [] },
      ] },
    });
    expect(m.runningSessions).toBe(1);
    expect(m.attention.some((a) => a.text.startsWith("b:"))).toBe(true);
  });

  it("puts an idle In Review ticket in Review, not Build", () => {
    const issue = (issueNumber: number, statusName: string, wsStatus: string) => ({
      issueNumber, issueId: `i${issueNumber}`, title: "t", statusName,
      workspace: { id: `ws-${issueNumber}`, branch: `b${issueNumber}`, status: wsStatus }, session: { status: "stopped" }, mergeState: null,
    });
    const m = buildConsoleModel({
      nowMs: NOW,
      status: {
        project: { id: "p", name: "proj", repoPath: "/x", defaultBranch: "master" },
        generatedAt: new Date(NOW).toISOString(),
        totals: { totalIssues: 2, inProgress: 2, activeWorkspaces: 2, runningSessions: 0 },
        issues: [issue(1572, "In Review", "idle"), issue(1600, "In Progress", "running")],
      } as any,
    });
    expect(m.issues.map((i) => [i.issueNumber, i.column])).toEqual([[1572, "Review"], [1600, "Build"]]);
  });

  it("hides superseded red trains and month-old workers, shows sha/tag, prefers git's merge count", () => {
    const day = 86400;
    const m = buildConsoleModel({
      nowMs: NOW,
      status: {
        project: { id: "p", name: "proj", repoPath: "/x", defaultBranch: "master" },
        generatedAt: new Date(NOW).toISOString(),
        totals: { totalIssues: 0, inProgress: 0, activeWorkspaces: 0, runningSessions: 0 },
        issues: [],
      },
      host: { freeGb: 9, floorGb: 2, hold: false, verify: { active: 0, slots: 2, queued: 0 }, boardCommit: "2dcf8de74aaaaaaa", boardTag: "stable-20261012-3", mergedToday: 31 },
      workers: { workers: [
        { name: "old", effectiveStatus: "offline", lastHeartbeatAt: ago(48 * day), workerVersion: "0.1.9-dev.1111111" },
        { name: "cur", effectiveStatus: "online", lastHeartbeatAt: ago(3), workerVersion: "0.1.9-dev.2dcf8de" },
        { name: "behind", effectiveStatus: "online", lastHeartbeatAt: ago(3), workerVersion: "0.1.9-dev.1234567" },
      ] },
      trains: { trains: [
        { label: "train-09", state: "landed", startedAt: ago(100), finishedAt: ago(50), memberWorkspaceIds: "[]", gateEvidence: null },
        { label: "train-08", state: "red", startedAt: ago(500), finishedAt: ago(400), memberWorkspaceIds: "[]", gateEvidence: JSON.stringify({ gateFailure: "no members" }) },
      ] } as any,
    });
    expect(m.attention).toEqual([]);
    expect(m.mergedToday).toBe(31);
    expect(m.workers.map((w) => [w.build, w.stale, w.buildStale])).toEqual([["1111111", true, true], ["2dcf8de", false, false], ["1234567", false, true]]);
    const out = renderConsole(m, { ...base, cols: 120, rows: 40, color: false }).join("\n");
    expect(out).toContain("(stable-20261012-3 2dcf8de)");
    expect(out).toContain("1 stale worker");
    expect(out).toContain("1234567!");
    expect(out).not.toContain("hb 4172553s");
  });

  it("retires a red train's attention line once its members landed, left or moved to a newer train (#1583)", () => {
    const iss = (n: number, ws: string, ready: boolean) => ({ issueNumber: n, issueId: `i${n}`, title: "t", statusName: "In Review", workspace: { id: ws, readyForMerge: ready }, session: null }) as any;
    const mk = (issues: any[], trains: any[]) => trainOnly(buildConsoleModel({
      nowMs: NOW,
      status: { project: { id: "p", name: "proj", repoPath: "/x", defaultBranch: "master" }, generatedAt: new Date(NOW).toISOString(), totals: { totalIssues: 0, inProgress: 0, activeWorkspaces: 0, runningSessions: 0 }, issues } as any,
      trains: { trains } as any,
    }));
    const trainOnly = <T extends { attention: Array<{ text: string }> }>(m: T): T => ({ ...m, attention: m.attention.filter((a) => a.text.startsWith("train")) });
    const red = { label: "train-03", state: "red", startedAt: ago(500), finishedAt: ago(400), memberWorkspaceIds: JSON.stringify(["a", "b"]), gateEvidence: JSON.stringify({ gateFailure: "suite x" }) };
    // still waiting: red
    expect(mk([iss(1, "a", true), iss(2, "b", true)], [red]).attention.map((a) => a.text)).toEqual(["train-03 red: suite x"]);
    // all members landed in a later train: no line
    const later = { label: "train-04", state: "landed", startedAt: ago(100), finishedAt: ago(50), memberWorkspaceIds: JSON.stringify(["a", "b"]), gateEvidence: JSON.stringify({ landed: ["a", "b"] }) };
    expect(mk([], [later, red]).attention).toEqual([]);
    // members reworking: says so, yellow
    const m = mk([iss(1, "a", false), iss(2, "b", false)], [red]);
    expect(m.attention).toEqual([{ level: "yellow", text: "train-03 red, members reworking: #1 #2" }]);
  });
});
