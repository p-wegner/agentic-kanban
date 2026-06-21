import { describe, it, expect } from "vitest";
import { buildMonitorTitle, countActiveMonitors } from "./monitorToolbarStatus.js";

describe("buildMonitorTitle", () => {
  it("returns the configure prompt when nothing is active", () => {
    expect(buildMonitorTitle(false, false, false)).toBe("Board monitor - click to configure");
    expect(buildMonitorTitle(false, false, undefined)).toBe("Board monitor - click to configure");
  });
  it("lists active mechanisms in order: orchestrator, butler, auto-monitor", () => {
    expect(buildMonitorTitle(true, true, true)).toBe("Active: Orchestrator loop, Monitor Butler, Auto-monitor — click for details");
    expect(buildMonitorTitle(true, false, false)).toBe("Active: Auto-monitor — click for details");
    expect(buildMonitorTitle(false, true, true)).toBe("Active: Orchestrator loop, Monitor Butler — click for details");
  });
});

describe("countActiveMonitors", () => {
  it("counts the truthy mechanisms", () => {
    expect(countActiveMonitors(false, false, false)).toBe(0);
    expect(countActiveMonitors(true, false, undefined)).toBe(1);
    expect(countActiveMonitors(true, true, true)).toBe(3);
  });
});
