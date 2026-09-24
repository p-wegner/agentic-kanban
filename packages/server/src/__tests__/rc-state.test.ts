// @gate:always-run when:scripts/rc-state.mjs,scripts/rc-state.d.mts,scripts/promote.mjs,packages/server/src/services/rc-state.ts — imports scripts/rc-state.mjs, which no package-local diff links to (#687); holds its server mirror in lockstep (#1238).
/**
 * The release-candidate lifecycle module (#1238): rc naming, reuse vs increment, the abandon
 * rule, the file round trip — and the server mirror held to the same behaviour on one fixture,
 * the way `promote-evidence.test.ts` holds the miss-rate mirror.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// Typed by the hand-written `scripts/rc-state.d.mts`, per the `promote-plan.d.mts` convention.
import {
  DEFAULT_RC_CADENCE_MS,
  RC_STATE_RELPATH,
  RC_STATES,
  TERMINAL_RC_STATES,
  currentRcCandidate,
  formatRcCandidate,
  isTerminalRcState,
  nextRcBranch,
  parseRcBranch,
  parseRcState,
  planRcCandidate,
  readRcState,
  serializeRcState,
  sortRcBranches,
  upsertRcCandidate,
  writeRcState,
  type RcStateFile,
} from "../../../../scripts/rc-state.mjs";
import * as server from "../services/rc-state.js";

const NOW = Date.parse("2026-09-24T09:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

const fixture = (): RcStateFile => ({
  version: 1,
  candidates: [
    { branch: "rc/20260922", sha: "aaa", state: "promoted", cutAt: hoursAgo(50), updatedAt: hoursAgo(48), tag: "stable-20260922", failedSuites: [], note: null },
    { branch: "rc/20260923", sha: "bbb", state: "red", cutAt: hoursAgo(26), updatedAt: hoursAgo(25), tag: null, failedSuites: ["packages/server/src/__tests__/x.test.ts"], note: null },
  ],
});

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) {
    try { rmSync(tempDirs.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("rc branch naming (#1238 item 1)", () => {
  it("parses only rc/YYYYMMDD[-N]", () => {
    expect(parseRcBranch("rc/20260924")).toEqual({ branch: "rc/20260924", date: "20260924", ordinal: 1 });
    expect(parseRcBranch("rc/20260924-3")?.ordinal).toBe(3);
    expect(parseRcBranch("master")).toBeNull();
    expect(parseRcBranch("stable-20260924")).toBeNull();
    expect(parseRcBranch("rc/2026-09-24")).toBeNull();
  });

  it("takes the bare day name when free and increments -N past every taken name, never reusing one", () => {
    expect(nextRcBranch("20260924", [])).toBe("rc/20260924");
    expect(nextRcBranch("20260924", ["rc/20260924"])).toBe("rc/20260924-2");
    expect(nextRcBranch("20260924", ["rc/20260924", "rc/20260924-2", "rc/20260923"])).toBe("rc/20260924-3");
  });

  it("orders newest-first by date then ordinal", () => {
    expect(sortRcBranches(["rc/20260923", "rc/20260924-2", "rc/20260924", "junk"])).toEqual(["rc/20260924-2", "rc/20260924", "rc/20260923"]);
  });
});

describe("the lifecycle states", () => {
  it("has the seven states of decision 019 and exactly two terminal ones", () => {
    expect([...RC_STATES]).toEqual(["cut", "sweeping", "red", "healing", "green", "promoted", "abandoned"]);
    expect([...TERMINAL_RC_STATES]).toEqual(["promoted", "abandoned"]);
    expect(isTerminalRcState("promoted")).toBe(true);
    expect(isTerminalRcState("red")).toBe(false);
  });

  it("upsert returns a new state, keeps the cut time, and refuses an unknown state", () => {
    const before = fixture();
    const after = upsertRcCandidate(before, "rc/20260923", { state: "healing" }, hoursAgo(1));
    expect(before.candidates.find((c) => c.branch === "rc/20260923")?.state).toBe("red");
    const healed = after.candidates.find((c) => c.branch === "rc/20260923")!;
    expect(healed.state).toBe("healing");
    expect(healed.cutAt).toBe(hoursAgo(26));
    expect(healed.updatedAt).toBe(hoursAgo(1));
    expect(healed.failedSuites).toEqual(["packages/server/src/__tests__/x.test.ts"]);
    expect(() => upsertRcCandidate(before, "rc/20260923", { state: "shipped" as never })).toThrow(/unknown rc state/);
  });

  it("currentRcCandidate is the newest by name, and formats one readable line", () => {
    const current = currentRcCandidate(fixture());
    expect(current?.branch).toBe("rc/20260923");
    expect(formatRcCandidate(current)).toContain("rc/20260923 @ bbb is red");
    expect(formatRcCandidate(current)).toContain("x.test.ts");
    expect(formatRcCandidate(null)).toContain("no release candidate");
  });
});

describe("reuse vs cut vs abandon (#1238 items 1 and 4)", () => {
  const branches = ["rc/20260922", "rc/20260923"];

  it("reuses an in-flight candidate rather than cutting past a sweep or a heal", () => {
    const state = upsertRcCandidate(fixture(), "rc/20260923", { state: "sweeping" }, hoursAgo(30));
    const plan = planRcCandidate({ dateStamp: "20260924", state, existingBranches: branches, nowMs: NOW });
    expect(plan).toMatchObject({ action: "reuse", branch: "rc/20260923", abandon: null });
    expect(plan.reason).toContain("sweeping");
  });

  it("reuses a red candidate that is younger than one cadence", () => {
    const state = upsertRcCandidate(fixture(), "rc/20260923", { state: "red" }, hoursAgo(2));
    const plan = planRcCandidate({ dateStamp: "20260924", state, existingBranches: branches, nowMs: NOW });
    expect(plan.action).toBe("reuse");
    expect(plan.reason).toContain("red for 2.0h");
  });

  it("ABANDONS a red candidate older than one cadence and cuts a fresh name", () => {
    const plan = planRcCandidate({ dateStamp: "20260924", state: fixture(), existingBranches: branches, nowMs: NOW });
    expect(plan).toMatchObject({ action: "cut", branch: "rc/20260924", abandon: "rc/20260923" });
    expect(plan.reason).toContain("longer than one cadence");
    expect(DEFAULT_RC_CADENCE_MS).toBe(24 * 3600_000);
  });

  it("honours a shorter cadence for the abandon rule", () => {
    const state = upsertRcCandidate(fixture(), "rc/20260923", { state: "red" }, hoursAgo(2));
    const plan = planRcCandidate({ dateStamp: "20260924", state, existingBranches: branches, nowMs: NOW, cadenceMs: 3600_000 });
    expect(plan.abandon).toBe("rc/20260923");
  });

  it("cuts fresh when nothing is in flight, and -N increments only past a TERMINAL same-day name", () => {
    const promotedToday = upsertRcCandidate(fixture(), "rc/20260924", { state: "promoted", tag: "stable-20260924" }, hoursAgo(1));
    const done = upsertRcCandidate(promotedToday, "rc/20260923", { state: "abandoned" }, hoursAgo(1));
    const plan = planRcCandidate({ dateStamp: "20260924", state: done, existingBranches: [...branches, "rc/20260924"], nowMs: NOW });
    expect(plan).toMatchObject({ action: "cut", branch: "rc/20260924-2", abandon: null });
  });

  it("does not reuse a candidate whose branch no longer exists in git", () => {
    const state = upsertRcCandidate(fixture(), "rc/20260923", { state: "cut" }, hoursAgo(1));
    const plan = planRcCandidate({ dateStamp: "20260924", state, existingBranches: ["rc/20260922"], nowMs: NOW });
    expect(plan).toMatchObject({ action: "cut", branch: "rc/20260924" });
  });
});

describe("the file round trip (#1238 item 3)", () => {
  it("writes under <stable>/.kanban/rc-state.json and reads back what it wrote", () => {
    const stable = mkdtempSync(join(tmpdir(), "ak-rc-state-"));
    tempDirs.push(stable);
    expect(readRcState(stable)).toEqual({ version: 1, candidates: [] });
    const path = writeRcState(stable, fixture());
    expect(path.replace(/\\/g, "/")).toBe(join(stable, RC_STATE_RELPATH).replace(/\\/g, "/"));
    expect(RC_STATE_RELPATH.replace(/\\/g, "/")).toBe(".kanban/rc-state.json");
    expect(readRcState(stable)).toEqual(fixture());
    // The serialisation is stable JSON with a trailing newline — diffable, greppable by the Sentinel.
    expect(readFileSync(path, "utf8")).toBe(serializeRcState(fixture()));
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
  });

  it("reads an absent, empty, or half-written file as no candidates rather than throwing", () => {
    expect(parseRcState("")).toEqual({ version: 1, candidates: [] });
    expect(parseRcState("{\"version\":1,\"candid")).toEqual({ version: 1, candidates: [] });
    expect(parseRcState(JSON.stringify({ candidates: [{ branch: "master", state: "cut" }, { branch: "rc/20260924", state: "bogus" }] })).candidates)
      .toEqual([{ branch: "rc/20260924", sha: null, state: "cut", cutAt: null, updatedAt: null, tag: null, failedSuites: [], note: null }]);
  });
});

describe("the server mirror (services/rc-state.ts) agrees with the script on one fixture", () => {
  it("parses, plans, orders and names identically", () => {
    const text = serializeRcState(fixture());
    expect(server.parseRcState(text)).toEqual(parseRcState(text));
    expect(server.currentRcCandidate(server.parseRcState(text))).toEqual(currentRcCandidate(parseRcState(text)));
    const input = { dateStamp: "20260924", state: fixture(), existingBranches: ["rc/20260922", "rc/20260923"], nowMs: NOW };
    expect(server.planRcCandidate(input)).toEqual(planRcCandidate(input));
    const reuseInput = { ...input, state: upsertRcCandidate(fixture(), "rc/20260923", { state: "red" }, hoursAgo(2)) };
    expect(server.planRcCandidate(reuseInput)).toEqual(planRcCandidate(reuseInput));
    expect(server.nextRcBranch("20260924", ["rc/20260924"])).toBe(nextRcBranch("20260924", ["rc/20260924"]));
    expect(server.sortRcBranches(["rc/20260923", "rc/20260924-2", "rc/20260924"])).toEqual(sortRcBranches(["rc/20260923", "rc/20260924-2", "rc/20260924"]));
    expect([...server.RC_STATES]).toEqual([...RC_STATES]);
    expect(server.DEFAULT_RC_CADENCE_MS).toBe(DEFAULT_RC_CADENCE_MS);
    expect(server.RC_STATE_RELPATH).toBe(RC_STATE_RELPATH);
  });

  it("reads the file the script wrote, and resolves the stable checkout the way promote-plan does", () => {
    const stable = mkdtempSync(join(tmpdir(), "ak-rc-state-server-"));
    tempDirs.push(stable);
    writeRcState(stable, fixture());
    expect(server.readRcState(stable)).toEqual(fixture());
    // A corrupt file reads as empty, never as a throw out of the delivery view.
    mkdirSync(join(stable, ".kanban"), { recursive: true });
    writeFileSync(join(stable, ".kanban", "rc-state.json"), "{ nope", "utf8");
    expect(server.readRcState(stable)).toEqual({ version: 1, candidates: [] });
    expect(server.resolveStableCheckoutFor("C:/repos/agentic-kanban", {}).replace(/\\/g, "/")).toMatch(/\/repos\/agentic-kanban-stable$/);
    expect(server.resolveStableCheckoutFor("C:/repos/agentic-kanban", { KANBAN_STABLE_CHECKOUT: stable }).replace(/\\/g, "/")).toBe(stable.replace(/\\/g, "/"));
    expect(server.toRcCandidateSummary(server.currentRcCandidate(fixture()))).toEqual({
      branch: "rc/20260923", sha: "bbb", state: "red", updatedAt: hoursAgo(25), tag: null, failedSuites: ["packages/server/src/__tests__/x.test.ts"],
    });
    expect(server.toRcCandidateSummary(null)).toBeNull();
  });
});
