/**
 * The queue flush's lifecycle module (#1246): parse/read round trip and the heal state
 * machine's legal transitions, including the master-target no-op (decision 020 part 4).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FLUSH_STATE_RELPATH,
  applyFlushTransition,
  canTransitionFlushState,
  emptyFlushState,
  isTerminalFlushState,
  latestFlush,
  parseFlushState,
  readFlushState,
  sortFlushes,
  type FlushRecord,
} from "../services/flush-state.js";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) {
    try { rmSync(tempDirs.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function fixtureRecord(overrides: Partial<FlushRecord> = {}): FlushRecord {
  return {
    id: "flush/20260926-1",
    at: "2026-09-26T10:00:00.000Z",
    triggeredBy: "auto",
    memberIssueNumbers: [1200, 1201],
    memberBranches: ["feature/ak-1200-x", "feature/ak-1201-y"],
    landingSha: "abc123",
    tag: "flush/20260926-1",
    sweepTarget: "rc/20260926",
    state: "flushed",
    openHealTickets: [],
    updatedAt: "2026-09-26T10:00:00.000Z",
    ...overrides,
  };
}

describe("readFlushState / parseFlushState", () => {
  it("reads an absent file as empty, never throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-flush-state-"));
    tempDirs.push(dir);
    expect(readFlushState(dir)).toEqual(emptyFlushState());
  });

  it("round-trips a written file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-flush-state-"));
    tempDirs.push(dir);
    const kanbanDir = join(dir, ".kanban");
    mkdirSync(kanbanDir, { recursive: true });
    const file = { version: 1, flushes: [fixtureRecord()] };
    writeFileSync(join(dir, FLUSH_STATE_RELPATH), JSON.stringify(file), "utf8");
    const read = readFlushState(dir);
    expect(read.flushes).toHaveLength(1);
    expect(read.flushes[0]).toEqual(fixtureRecord());
  });

  it("reads unparseable JSON as empty rather than throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-flush-state-"));
    tempDirs.push(dir);
    mkdirSync(join(dir, ".kanban"), { recursive: true });
    writeFileSync(join(dir, FLUSH_STATE_RELPATH), "{not json", "utf8");
    expect(readFlushState(dir)).toEqual(emptyFlushState());
  });

  it("drops a row with no id/at and defaults a missing/invalid state to flushed", () => {
    const parsed = parseFlushState(JSON.stringify({
      flushes: [
        { at: "2026-09-26T10:00:00.000Z" }, // no id — dropped
        { id: "flush/20260926-1", at: "2026-09-26T10:00:00.000Z", state: "not-a-real-state" },
      ],
    }));
    expect(parsed.flushes).toHaveLength(1);
    expect(parsed.flushes[0]?.state).toBe("flushed");
  });
});

describe("sortFlushes / latestFlush", () => {
  it("orders newest-first by `at`", () => {
    const older = fixtureRecord({ id: "flush/20260925-1", at: "2026-09-25T10:00:00.000Z" });
    const newer = fixtureRecord({ id: "flush/20260926-1", at: "2026-09-26T10:00:00.000Z" });
    expect(sortFlushes([older, newer]).map((f) => f.id)).toEqual(["flush/20260926-1", "flush/20260925-1"]);
    expect(latestFlush({ version: 1, flushes: [older, newer] })?.id).toBe("flush/20260926-1");
  });

  it("reads an empty state's latest as null", () => {
    expect(latestFlush(emptyFlushState())).toBeNull();
  });
});

describe("isTerminalFlushState", () => {
  it("is true only for merged-back and abandoned", () => {
    expect(isTerminalFlushState("merged-back")).toBe(true);
    expect(isTerminalFlushState("abandoned")).toBe(true);
    expect(isTerminalFlushState("healed")).toBe(false);
    expect(isTerminalFlushState(null)).toBe(false);
  });
});

describe("canTransitionFlushState — the heal state machine (decision 020 part 4)", () => {
  it("allows the happy path: flushed -> sweeping -> red -> healing -> healed -> merged-back", () => {
    expect(canTransitionFlushState("flushed", "sweeping")).toEqual({ ok: true });
    expect(canTransitionFlushState("sweeping", "red")).toEqual({ ok: true });
    expect(canTransitionFlushState("red", "healing")).toEqual({ ok: true });
    expect(canTransitionFlushState("healing", "healed")).toEqual({ ok: true });
    expect(canTransitionFlushState("healed", "merged-back")).toEqual({ ok: true });
  });

  it("allows a clean sweep to skip straight from sweeping to healed", () => {
    expect(canTransitionFlushState("sweeping", "healed")).toEqual({ ok: true });
  });

  it("allows abandoning from any non-terminal state", () => {
    for (const from of ["flushed", "sweeping", "red", "healing"] as const) {
      expect(canTransitionFlushState(from, "abandoned")).toEqual({ ok: true });
    }
  });

  it("refuses a terminal state's own transitions", () => {
    expect(canTransitionFlushState("merged-back", "healed").ok).toBe(false);
    expect(canTransitionFlushState("abandoned", "sweeping").ok).toBe(false);
  });

  it("refuses skipping the heal step (red straight to healed)", () => {
    const result = canTransitionFlushState("red", "healed");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not a legal transition/);
  });

  it("refuses a same-state transition", () => {
    const result = canTransitionFlushState("healed", "healed");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("already healed");
  });
});

describe("applyFlushTransition", () => {
  it("stamps updatedAt and advances state on a legal transition", () => {
    const record = fixtureRecord({ state: "flushed" });
    const { record: next, result } = applyFlushTransition(record, "sweeping", { now: "2026-09-26T11:00:00.000Z" });
    expect(result.ok).toBe(true);
    expect(next.state).toBe("sweeping");
    expect(next.updatedAt).toBe("2026-09-26T11:00:00.000Z");
  });

  it("leaves the record unchanged and reports the refusal on an illegal transition", () => {
    const record = fixtureRecord({ state: "flushed" });
    const { record: next, result } = applyFlushTransition(record, "healed", { now: "2026-09-26T11:00:00.000Z" });
    expect(result.ok).toBe(false);
    expect(next).toEqual(record);
  });

  it("collapses healed straight to merged-back when the heal target IS master (the no-op transition)", () => {
    const record = fixtureRecord({ state: "healing", sweepTarget: "master" });
    const { record: next, result } = applyFlushTransition(record, "healed", { now: "2026-09-26T12:00:00.000Z" });
    expect(result.ok).toBe(true);
    expect(next.state).toBe("merged-back");
    expect(next.updatedAt).toBe("2026-09-26T12:00:00.000Z");
  });

  it("does NOT collapse when the heal target is an rc branch — healed stays healed", () => {
    const record = fixtureRecord({ state: "healing", sweepTarget: "rc/20260926" });
    const { record: next } = applyFlushTransition(record, "healed", { now: "2026-09-26T12:00:00.000Z" });
    expect(next.state).toBe("healed");
  });
});
