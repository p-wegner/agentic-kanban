import { describe, it, expect } from "vitest";
import { strategyPrefKey } from "@agentic-kanban/shared/lib/strategy-policy";
import { resolveWipLimit } from "./wip-limit.service.js";

const PID = "11111111-2222-3333-4444-555555555555";

function prefs(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

function bullseye(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

// @covers preferences-config.resolve.wip-limit [config,monitor]
describe("resolveWipLimit (#919, collapsed to override -> Bullseye -> default by #1102)", () => {
  it("reports NOTHING configured when nothing is set, while still yielding an actionable limit", () => {
    const r = resolveWipLimit(prefs({}), PID);
    expect(r.configured).toBeNull();
    expect(r.source).toBe("default");
    expect(r.limit).toBeGreaterThanOrEqual(1);
  });

  it("an explicit override beats the Bullseye", () => {
    const r = resolveWipLimit(prefs({ [strategyPrefKey(PID)]: bullseye({ activeAgentsTarget: 9 }) }), PID, { override: 7 });
    expect(r).toEqual({ limit: 7, configured: 7, source: "override" });
  });

  it("reads the Bullseye's activeAgentsTarget as the configured limit", () => {
    const r = resolveWipLimit(prefs({ [strategyPrefKey(PID)]: bullseye({ activeAgentsTarget: 6 }) }), PID);
    expect(r).toEqual({ limit: 6, configured: 6, source: "strategy" });
  });

  it("IGNORES a leftover wip_limit_<id> row — the Bullseye is the only home of WIP now", () => {
    // The startup migration moves this value into the Bullseye and deletes it; a row that
    // survived (e.g. written straight into the DB) must not quietly override the Bullseye again.
    const p = prefs({ [`wip_limit_${PID}`]: "2", [strategyPrefKey(PID)]: bullseye({ activeAgentsTarget: 5 }) });
    expect(resolveWipLimit(p, PID)).toEqual({ limit: 5, configured: 5, source: "strategy" });
  });

  it("a Bullseye that names no target is NOT a configured WIP limit", () => {
    const r = resolveWipLimit(prefs({ [strategyPrefKey(PID)]: bullseye({ segments: [] }) }), PID);
    expect(r.configured).toBeNull();
    expect(r.source).toBe("default");
    expect(r.limit).toBeGreaterThanOrEqual(1);
  });

  it("a stored legacy nudge_wip_limit still feeds the no-Bullseye DEFAULT path, reported as default", () => {
    // Retired from the registry (writes 422), but a row already on disk keeps the default path
    // it always drove — it is not a configured value any more, so `configured` stays null.
    const r = resolveWipLimit(prefs({ nudge_wip_limit: "3" }), PID);
    expect(r).toEqual({ limit: 3, configured: null, source: "default" });
  });

  it("ignores a junk override rather than yielding a limit of 0", () => {
    for (const bad of [0, -4, Number.NaN]) {
      const r = resolveWipLimit(prefs({}), PID, { override: bad });
      expect(r.source).not.toBe("override");
      expect(r.limit).toBeGreaterThanOrEqual(1);
    }
  });

  it("is pure — resolving twice over the same map gives the same answer and mutates nothing", () => {
    const p = prefs({ [strategyPrefKey(PID)]: bullseye({ activeAgentsTarget: 4 }) });
    const before = new Map(p);
    expect(resolveWipLimit(p, PID)).toEqual(resolveWipLimit(p, PID));
    expect([...p.entries()]).toEqual([...before.entries()]);
  });

  it("is per-project — one project's Bullseye does not leak into another's", () => {
    const other = "99999999-8888-7777-6666-555555555555";
    const p = prefs({ [strategyPrefKey(PID)]: bullseye({ activeAgentsTarget: 2 }) });
    expect(resolveWipLimit(p, PID).configured).toBe(2);
    expect(resolveWipLimit(p, other).configured).toBeNull();
  });
});
