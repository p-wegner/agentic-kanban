import { describe, expect, it } from "vitest";
import type { AutopilotStatusResponse } from "@agentic-kanban/shared/types";
import { buildAutopilotChipView, clampStep } from "./autopilotChip.js";

function status(overrides: Partial<AutopilotStatusResponse> = {}): AutopilotStatusResponse {
  return {
    projectId: "p",
    startMode: "monitor",
    startModeSource: "start_mode",
    autoStart: true,
    running: 2,
    limit: 4,
    limitConfigured: true,
    effectiveLimit: 4,
    startsPerCycle: 2,
    backlogFloor: 3,
    slots: 2,
    eligibleCount: 5,
    eligibleCountCapped: false,
    willStartNextCycle: 2,
    holdReason: null,
    autoMerge: { enabled: true, source: "enabled" },
    nextCycleAt: null,
    ...overrides,
  };
}

describe("buildAutopilotChipView (#1102)", () => {
  it("autopilot with free slots", () => {
    const view = buildAutopilotChipView(status());
    expect(view.label).toBe("● Autopilot · 2/4 running · +2 next cycle · auto-merge ✓");
    expect(view.tone).toBe("active");
    expect(view.compactLabel).toBe("● 2/4");
  });

  it("manual shows running without a limit and no next-cycle segment", () => {
    const view = buildAutopilotChipView(status({
      startMode: "manual", autoStart: false, running: 1, willStartNextCycle: 0, holdReason: "manual_mode",
      autoMerge: { enabled: false, source: "project_disabled" },
    }));
    expect(view.label).toBe("○ Manual · 1 running · auto-merge ✗");
    expect(view.tone).toBe("idle");
    expect(view.title).toContain("switched off for this project");
  });

  it("autopilot held by the machine", () => {
    const view = buildAutopilotChipView(status({ running: 4, willStartNextCycle: 0, holdReason: "machine_full" }));
    expect(view.label).toBe("● Autopilot · 4/4 running · holding: machine full · auto-merge ✓");
    expect(view.tone).toBe("held");
    expect(view.title).toContain("no headroom");
  });

  it("conductor mode names the Conductor and predicts nothing for the in-process monitor", () => {
    const view = buildAutopilotChipView(status({ startMode: "conductor", autoStart: false, willStartNextCycle: 0, holdReason: "conductor_mode" }));
    expect(view.label).toBe("● Conductor · 2/4 running · auto-merge ✓");
    expect(view.tone).toBe("active");
  });

  it("nothing ready is not a hold", () => {
    const view = buildAutopilotChipView(status({ willStartNextCycle: 0, holdReason: "no_ready_tickets", eligibleCount: 0 }));
    expect(view.label).toBe("● Autopilot · 2/4 running · nothing ready · auto-merge ✓");
    expect(view.tone).toBe("active");
  });

  it("the tooltip says when machine headroom lowers the limit", () => {
    const view = buildAutopilotChipView(status({ effectiveLimit: 3, willStartNextCycle: 1 }));
    expect(view.title).toContain("machine headroom allows 3");
  });

  it("clampStep keeps steppers inside their bounds", () => {
    expect(clampStep(0, 1, 32)).toBe(1);
    expect(clampStep(40, 1, 32)).toBe(32);
    expect(clampStep(Number.NaN, 1, 32)).toBe(1);
    expect(clampStep(3.4, 1, 32)).toBe(3);
  });
});
