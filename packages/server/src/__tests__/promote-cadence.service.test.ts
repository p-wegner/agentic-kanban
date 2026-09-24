/**
 * The promotion cadence (#1238, decision 019 part 4): the pref shape, when the daily tick is
 * due, what one scheduler tick fires, and that the abandon rule the fired run applies is the
 * one `rc-state` encodes. Nothing here spawns a process — `fire` is injected.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isPromoteCadenceDue,
  parsePromoteCadence,
  parsePromoteCadenceState,
  promoteCadencePrefKey,
  promoteCadenceStatePrefKey,
  runDuePromoteCadences,
  type PromoteCadenceDeps,
} from "../services/promote-cadence.service.js";
import { planRcCandidate, parseRcState } from "../services/rc-state.js";

const PROJECT = "11111111-2222-4333-8444-555555555555";
/** 2026-09-24 09:30 LOCAL time — the cadence is written in the operator's zone. */
const at = (h: number, m: number, day = 24) => new Date(2026, 8, day, h, m, 0, 0).getTime();

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) {
    try { rmSync(tempDirs.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("parsePromoteCadence", () => {
  it("reads off, absent and blank as off; daily@HH:MM as a local minute of day", () => {
    expect(parsePromoteCadence(null)).toMatchObject({ kind: "off", error: null, raw: "off" });
    expect(parsePromoteCadence("  OFF ")).toMatchObject({ kind: "off", error: null });
    expect(parsePromoteCadence("daily@06:30")).toMatchObject({ kind: "daily", minuteOfDay: 6 * 60 + 30, raw: "daily@06:30", error: null });
    expect(parsePromoteCadence("Daily@6:05")).toMatchObject({ kind: "daily", minuteOfDay: 365, raw: "daily@06:05" });
  });

  it("refuses a shape it does not know, as off WITH an error rather than a guess", () => {
    expect(parsePromoteCadence("hourly")).toMatchObject({ kind: "off", error: expect.stringContaining("daily@HH:MM") });
    expect(parsePromoteCadence("daily@25:00")).toMatchObject({ kind: "off", error: expect.stringContaining("time of day") });
    expect(parsePromoteCadence("daily@06")).toMatchObject({ kind: "off" });
  });

  it("builds registered pref keys — the family compiles only because the prefixes are in the table", () => {
    expect(promoteCadencePrefKey(PROJECT)).toBe(`promote_cadence_${PROJECT}`);
    expect(promoteCadenceStatePrefKey(PROJECT)).toBe(`promote_cadence_state_${PROJECT}`);
    expect(parsePromoteCadenceState("{ nope")).toEqual({ lastFiredAt: null, lastPid: null });
    expect(parsePromoteCadenceState(JSON.stringify({ lastFiredAt: "2026-09-24T06:30:00.000Z", lastPid: 42 }))).toEqual({ lastFiredAt: "2026-09-24T06:30:00.000Z", lastPid: 42 });
  });
});

describe("isPromoteCadenceDue", () => {
  const daily = parsePromoteCadence("daily@06:30");

  it("is never due when off", () => {
    expect(isPromoteCadenceDue(parsePromoteCadence("off"), null, at(9, 30))).toEqual({ due: false, scheduledAtMs: null });
  });

  it("is due once today's minute has passed and nothing fired since it; not before the minute", () => {
    expect(isPromoteCadenceDue(daily, null, at(6, 29)).due).toBe(false);
    expect(isPromoteCadenceDue(daily, null, at(6, 30)).due).toBe(true);
    expect(isPromoteCadenceDue(daily, new Date(at(6, 31, 23)).toISOString(), at(9, 30)).due).toBe(true);
  });

  it("fires late rather than never: a server that was down at HH:MM fires on its first tick after", () => {
    expect(isPromoteCadenceDue(daily, new Date(at(6, 31, 23)).toISOString(), at(21, 0)).due).toBe(true);
  });

  it("does not fire twice in a day", () => {
    expect(isPromoteCadenceDue(daily, new Date(at(6, 30)).toISOString(), at(6, 31)).due).toBe(false);
    expect(isPromoteCadenceDue(daily, new Date(at(6, 30)).toISOString(), at(23, 59)).due).toBe(false);
  });
});

function makeDeps(over: Partial<PromoteCadenceDeps> & { cadence?: string | null; state?: string | null; repoPath?: string } = {}) {
  const { cadence, state, repoPath: repo, ...depOverrides } = over;
  const repoPath = repo ?? "C:/repos/agentic-kanban";
  const setStatePref = vi.fn(async () => undefined);
  const fire = vi.fn(async () => ({ pid: 4242 }));
  const deps: PromoteCadenceDeps = {
    listProjects: async () => [{ projectId: PROJECT, repoPath }],
    // `"cadence" in over` so an explicit null (= the pref is unset) is honoured, not defaulted.
    getCadencePref: async () => ("cadence" in over ? cadence ?? null : "daily@06:30"),
    getStatePref: async () => state ?? null,
    setStatePref,
    fire,
    nowMs: at(9, 30),
    ...depOverrides,
  };
  return { deps, setStatePref, fire };
}

describe("runDuePromoteCadences — one scheduler tick", () => {
  it("fires a due project through the injected fire and records lastFiredAt + pid", async () => {
    const { deps, setStatePref, fire } = makeDeps();
    const results = await runDuePromoteCadences(deps);
    expect(results).toEqual([{ projectId: PROJECT, fired: true, pid: 4242, rcBranch: null, rcState: null }]);
    expect(fire).toHaveBeenCalledWith({ projectId: PROJECT, repoPath: "C:/repos/agentic-kanban" });
    expect(setStatePref).toHaveBeenCalledWith(PROJECT, JSON.stringify({ lastFiredAt: new Date(at(9, 30)).toISOString(), lastPid: 4242 }));
  });

  it("skips off, invalid and not-yet-due projects without firing", async () => {
    expect((await runDuePromoteCadences(makeDeps({ cadence: null }).deps))[0]).toMatchObject({ fired: false, skipped: "off" });
    expect((await runDuePromoteCadences(makeDeps({ cadence: "weekly" }).deps))[0]).toMatchObject({ fired: false, skipped: "invalid" });
    const fired = JSON.stringify({ lastFiredAt: new Date(at(6, 30)).toISOString(), lastPid: 1 });
    const { deps, fire } = makeDeps({ state: fired });
    expect((await runDuePromoteCadences(deps))[0]).toMatchObject({ fired: false, skipped: "not_due" });
    expect(fire).not.toHaveBeenCalled();
  });

  it("never stacks a second run on one still alive from the last tick", async () => {
    const yesterday = JSON.stringify({ lastFiredAt: new Date(at(6, 30, 23)).toISOString(), lastPid: 777 });
    const { deps, fire } = makeDeps({ state: yesterday, isRunAlive: (pid) => pid === 777 });
    expect((await runDuePromoteCadences(deps))[0]).toMatchObject({ fired: false, skipped: "run_in_flight", pid: 777 });
    expect(fire).not.toHaveBeenCalled();
  });

  it("reports a failed fire as its own result row and keeps going", async () => {
    const { deps, setStatePref } = makeDeps({ fire: async () => { throw new Error("no promote.mjs"); } });
    expect((await runDuePromoteCadences(deps))[0]).toMatchObject({ fired: false, skipped: "fire_failed", error: "no promote.mjs" });
    expect(setStatePref).not.toHaveBeenCalled();
  });

  it("names the rc the fired run will find, read off the stable checkout beside the project", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ak-cadence-"));
    tempDirs.push(parent);
    const repoPath = join(parent, "agentic-kanban");
    const stable = join(parent, "agentic-kanban-stable");
    mkdirSync(join(stable, ".kanban"), { recursive: true });
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(stable, ".kanban", "rc-state.json"), JSON.stringify({
      version: 1,
      candidates: [{ branch: "rc/20260923", sha: "bbb", state: "red", updatedAt: new Date(at(6, 45, 23)).toISOString(), failedSuites: ["x.test.ts"] }],
    }), "utf8");
    const { deps } = makeDeps({ repoPath });
    expect((await runDuePromoteCadences(deps))[0]).toMatchObject({ fired: true, rcBranch: "rc/20260923", rcState: "red" });
  });
});

describe("the abandon rule the fired run applies (#1238 item 4)", () => {
  it("a red rc older than one cadence is abandoned and a fresh one cut; a younger one is reused", () => {
    const state = parseRcState(JSON.stringify({
      version: 1,
      candidates: [{ branch: "rc/20260923", sha: "bbb", state: "red", updatedAt: new Date(at(6, 45, 23)).toISOString(), failedSuites: ["x.test.ts"] }],
    }));
    const stale = planRcCandidate({ dateStamp: "20260924", state, existingBranches: ["rc/20260923"], nowMs: at(9, 30) });
    expect(stale).toMatchObject({ action: "cut", branch: "rc/20260924", abandon: "rc/20260923" });
    const fresh = planRcCandidate({ dateStamp: "20260924", state, existingBranches: ["rc/20260923"], nowMs: at(8, 0, 23) });
    expect(fresh).toMatchObject({ action: "reuse", branch: "rc/20260923", abandon: null });
  });
});
