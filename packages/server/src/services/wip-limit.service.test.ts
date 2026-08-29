import { describe, it, expect } from "vitest";
import { strategyPrefKey } from "@agentic-kanban/shared/lib/strategy-policy";
import { resolveWipLimit, wipLimitPrefKey } from "./wip-limit.service.js";

const PID = "11111111-2222-3333-4444-555555555555";

function prefs(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

function bullseye(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

// @covers preferences-config.resolve.wip-limit [config,monitor]
describe("resolveWipLimit (#919 — the one WIP resolver)", () => {
  it("reports NOTHING configured when nothing is set, while still yielding an actionable limit", () => {
    const r = resolveWipLimit(prefs({}), PID);
    // The distinction drive-preflight needs, and the reason it used to bypass the tunables
    // resolver entirely: `configured` stays null so it does not warn about a default it
    // invented, while `limit` is still a number the other two surfaces can act on.
    expect(r.configured).toBeNull();
    expect(r.source).toBe("default");
    expect(r.limit).toBeGreaterThanOrEqual(1);
  });

  it("an explicit override beats every pref", () => {
    const r = resolveWipLimit(
      prefs({ [wipLimitPrefKey(PID)]: "2", [strategyPrefKey(PID)]: bullseye({ activeAgentsTarget: 9 }) }),
      PID,
      { override: 7 },
    );
    expect(r).toEqual({ limit: 7, configured: 7, source: "override" });
  });

  it("the per-project wip_limit_<id> pref beats the Bullseye — the #654 disagreement", () => {
    // Before this resolver the dependency-wave panel read `wip_limit_<id>` and the monitor read
    // the Bullseye, so this exact prefMap made the two surfaces offer 2 and 5.
    const p = prefs({
      [wipLimitPrefKey(PID)]: "2",
      [strategyPrefKey(PID)]: bullseye({ activeAgentsTarget: 5 }),
    });
    expect(resolveWipLimit(p, PID)).toEqual({ limit: 2, configured: 2, source: "wip_limit_pref" });
  });

  it("falls through to the Bullseye's activeAgentsTarget when no per-project pref is set", () => {
    const r = resolveWipLimit(prefs({ [strategyPrefKey(PID)]: bullseye({ activeAgentsTarget: 6 }) }), PID);
    expect(r.source).toBe("strategy");
    expect(r.limit).toBe(6);
    expect(r.configured).toBe(6);
  });

  it("a Bullseye that names no target is NOT a configured WIP limit", () => {
    // A Bullseye can exist for its segments/provider policy alone. Treating its substituted
    // default as 'configured' would make drive-preflight warn about a number nobody chose.
    const r = resolveWipLimit(prefs({ [strategyPrefKey(PID)]: bullseye({ segments: [] }) }), PID);
    expect(r.configured).toBeNull();
    expect(r.limit).toBeGreaterThanOrEqual(1);
  });

  it("honours the legacy global nudge_wip_limit when nothing project-scoped exists", () => {
    const r = resolveWipLimit(prefs({ nudge_wip_limit: "3" }), PID);
    expect(r.source).toBe("legacy_pref");
    expect(r.limit).toBe(3);
    expect(r.configured).toBe(3);
  });

  it("ignores junk and non-positive values rather than yielding a limit of 0", () => {
    for (const bad of ["0", "-4", "", "many"]) {
      const r = resolveWipLimit(prefs({ [wipLimitPrefKey(PID)]: bad }), PID);
      expect(r.source).not.toBe("wip_limit_pref");
      expect(r.limit).toBeGreaterThanOrEqual(1);
    }
  });

  it("is pure — resolving twice over the same map gives the same answer and mutates nothing", () => {
    const p = prefs({ [wipLimitPrefKey(PID)]: "4" });
    const before = new Map(p);
    expect(resolveWipLimit(p, PID)).toEqual(resolveWipLimit(p, PID));
    expect([...p.entries()]).toEqual([...before.entries()]);
  });

  it("is per-project — one project's pref does not leak into another's", () => {
    const other = "99999999-8888-7777-6666-555555555555";
    const p = prefs({ [wipLimitPrefKey(PID)]: "2" });
    expect(resolveWipLimit(p, PID).configured).toBe(2);
    expect(resolveWipLimit(p, other).configured).toBeNull();
  });
});
