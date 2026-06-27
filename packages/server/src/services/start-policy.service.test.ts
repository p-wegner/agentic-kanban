import { describe, it, expect } from "vitest";
import { resolveStartPolicy, startModePrefKey } from "./start-policy.service.js";
import { resolveMonitorTunables } from "./strategy-objective.service.js";

const PID = "11111111-2222-3333-4444-555555555555";

function prefs(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

// @covers preferences-config.resolve.start-policy [config,state-transition,risk]
describe("resolveStartPolicy", () => {
  describe("explicit start_mode wins", () => {
    it("manual ⇒ NOTHING auto-starts even with the legacy opt-in flags ON (incident regression-lock)", () => {
      const p = resolveStartPolicy(
        prefs({
          [startModePrefKey(PID)]: "manual",
          dependency_auto_chain: "true",
          backlog_empty_strategy: "generate_tickets",
          board_autodrive_11111111_2222_3333_4444_555555555555: "true", // even an autodrive flag must not override manual
          auto_monitor: "true",
          nudge_auto_start: "true",
        }),
        PID,
      );
      expect(p.mode).toBe("manual");
      expect(p.source).toBe("start_mode");
      expect(p.autoStartUnblocked).toBe(false);
      expect(p.postMergeCascade).toBe(false);
      expect(p.backlogRefill).toBe(false);
      expect(p.scheduledRuns).toBe(false);
    });

    it("monitor ⇒ auto-start on; cascade/refill follow their own prefs", () => {
      const on = resolveStartPolicy(
        prefs({ [startModePrefKey(PID)]: "monitor", dependency_auto_chain: "true", backlog_empty_strategy: "generate_tickets" }),
        PID,
      );
      expect(on.mode).toBe("monitor");
      expect(on.autoStartUnblocked).toBe(true);
      expect(on.postMergeCascade).toBe(true);
      expect(on.backlogRefill).toBe(true);
      expect(on.scheduledRuns).toBe(true);

      const off = resolveStartPolicy(prefs({ [startModePrefKey(PID)]: "monitor" }), PID);
      expect(off.autoStartUnblocked).toBe(true); // auto-start is the point of monitor mode
      expect(off.postMergeCascade).toBe(false); // opt-in pref absent
      expect(off.backlogRefill).toBe(false);
    });

    it("conductor ⇒ in-process auto-start OFF (external loop drives) but scheduled crons honored", () => {
      const p = resolveStartPolicy(
        prefs({ [startModePrefKey(PID)]: "conductor", dependency_auto_chain: "true", backlog_empty_strategy: "generate_tickets" }),
        PID,
      );
      expect(p.mode).toBe("conductor");
      expect(p.autoStartUnblocked).toBe(false);
      expect(p.postMergeCascade).toBe(false);
      expect(p.backlogRefill).toBe(false);
      expect(p.scheduledRuns).toBe(true);
    });
  });

  describe("derivation (no explicit start_mode) — back-compat", () => {
    it("board_autodrive=true ⇒ monitor (derived)", () => {
      const p = resolveStartPolicy(prefs({ [`board_autodrive_${PID}`]: "true" }), PID);
      expect(p.mode).toBe("monitor");
      expect(p.source).toBe("derived");
      expect(p.autoStartUnblocked).toBe(true);
    });

    it("global auto_monitor + nudge_auto_start ⇒ monitor (derived)", () => {
      const p = resolveStartPolicy(prefs({ auto_monitor: "true", nudge_auto_start: "true" }), PID);
      expect(p.mode).toBe("monitor");
      expect(p.source).toBe("derived");
    });

    it("auto_monitor alone (no nudge_auto_start) ⇒ manual", () => {
      const p = resolveStartPolicy(prefs({ auto_monitor: "true" }), PID);
      expect(p.mode).toBe("manual");
    });

    it("nothing set ⇒ manual (derived)", () => {
      const p = resolveStartPolicy(prefs({}), PID);
      expect(p.mode).toBe("manual");
      expect(p.source).toBe("derived");
    });

    it("never derives conductor", () => {
      // No combination of legacy flags should yield conductor — it is explicit-only.
      const p = resolveStartPolicy(prefs({ [`board_autodrive_${PID}`]: "true", auto_monitor: "true", nudge_auto_start: "true" }), PID);
      expect(p.mode).toBe("monitor");
    });
  });

  it("an unknown start_mode value falls back to derivation", () => {
    const p = resolveStartPolicy(prefs({ [startModePrefKey(PID)]: "bogus", [`board_autodrive_${PID}`]: "true" }), PID);
    expect(p.mode).toBe("monitor");
    expect(p.source).toBe("derived");
  });

  it("wip mirrors resolveMonitorTunables", () => {
    const map = prefs({ [startModePrefKey(PID)]: "monitor", nudge_wip_limit: "7" });
    const p = resolveStartPolicy(map, PID);
    expect(p.wip).toEqual(resolveMonitorTunables(map, PID).tunables);
    expect(p.wip.activeAgentsTarget).toBe(7);
  });
});
