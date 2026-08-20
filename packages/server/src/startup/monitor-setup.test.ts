import { describe, it, expect } from "vitest";
import { monitorShouldRun, monitorDrivenProjectIds, autoDriveProjectIds } from "./monitor-setup.js";
import { startModePrefKey } from "../services/start-policy.service.js";

const PID = "11111111-2222-3333-4444-555555555555";
const OTHER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function prefs(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

// Regression lock for review §3.4 (2026-07-07): monitor SCHEDULING must route through the
// resolved Start Mode (`resolveStartPolicy`), NOT the legacy `auto_monitor || board_autodrive`
// OR. Two failure modes are covered: (a) a `monitor` project with autodrive unset and
// auto_monitor off still schedules; (b) a `manual` project with a stale autodrive flag does NOT.
describe("monitor scheduling routes through Start Mode (§3.4)", () => {
  describe("monitorShouldRun", () => {
    it("(a) start_mode=monitor with autodrive UNSET and auto_monitor OFF ⇒ monitor IS scheduled", () => {
      // Pre-fix this returned false (auto_monitor off + no board_autodrive key) and the
      // "supported hands-off driver" silently never ran.
      const map = prefs({ [startModePrefKey(PID)]: "monitor" });
      expect(map.has("auto_monitor")).toBe(false); // auto_monitor is force-disabled every boot
      expect(monitorShouldRun(map)).toBe(true);
    });

    it("(b) start_mode=manual with a STALE board_autodrive=true ⇒ monitor is NOT scheduled for it", () => {
      // Pre-fix the legacy regex saw board_autodrive=true and scheduled cycles anyway, so
      // "manual" only killed new starts, not relaunch/nudge/auto-merge.
      const map = prefs({ [startModePrefKey(PID)]: "manual", [`board_autodrive_${PID}`]: "true" });
      expect(monitorShouldRun(map)).toBe(false);
    });

    it("legacy board_autodrive=true with NO explicit start_mode still schedules (back-compat)", () => {
      const map = prefs({ [`board_autodrive_${PID}`]: "true" });
      expect(monitorShouldRun(map)).toBe(true);
    });

    it("global auto_monitor=true still schedules regardless of per-project mode", () => {
      expect(monitorShouldRun(prefs({ auto_monitor: "true" }))).toBe(true);
    });

    it("conductor mode does NOT by itself schedule the in-process monitor (external loop drives)", () => {
      const map = prefs({ [startModePrefKey(PID)]: "conductor" });
      expect(monitorShouldRun(map)).toBe(false);
    });

    it("nothing set ⇒ not scheduled", () => {
      expect(monitorShouldRun(prefs({}))).toBe(false);
    });
  });

  describe("monitorDrivenProjectIds", () => {
    it("includes explicit-monitor and derived-monitor projects, excludes manual/conductor", () => {
      const map = prefs({
        [startModePrefKey(PID)]: "monitor", // explicit monitor
        [`board_autodrive_${OTHER}`]: "true", // derived monitor (no explicit mode)
        [startModePrefKey("cccccccc-cccc-cccc-cccc-cccccccccccc")]: "manual",
        [startModePrefKey("dddddddd-dddd-dddd-dddd-dddddddddddd")]: "conductor",
      });
      const ids = monitorDrivenProjectIds(map);
      expect(ids.has(PID)).toBe(true);
      expect(ids.has(OTHER)).toBe(true);
      expect(ids.has("cccccccc-cccc-cccc-cccc-cccccccccccc")).toBe(false);
      expect(ids.has("dddddddd-dddd-dddd-dddd-dddddddddddd")).toBe(false);
    });

    it("a stale board_autodrive=true is NOT driven when start_mode=manual overrides it", () => {
      const map = prefs({ [startModePrefKey(PID)]: "manual", [`board_autodrive_${PID}`]: "true" });
      expect(monitorDrivenProjectIds(map).has(PID)).toBe(false);
      // ...even though the raw legacy flag set still reports it (proving the routing matters).
      expect(autoDriveProjectIds(map).has(PID)).toBe(true);
    });
  });
});
