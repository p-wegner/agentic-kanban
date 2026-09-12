import { describe, expect, it } from "vitest";
import type { MachineCapacitySnapshot } from "@agentic-kanban/shared/lib/machine-capacity";
import { clampWipToHeadroom, decideStartSlots, type StartSlotInput } from "./start-slot-decision.js";

const roomy = { tier: "0", hold: false, reason: "test fixture", freeGb: 99 } as MachineCapacitySnapshot;
const saturated = { tier: "0", hold: true, reason: "test fixture: below floor", freeGb: 0.5 } as MachineCapacitySnapshot;
const tier1 = (headroomProcesses: number, hold = false) =>
  ({ tier: "1", hold, canStartAnother: !hold, headroomProcesses, thrashing: "none", reason: "test fixture" }) as MachineCapacitySnapshot;

function input(overrides: Partial<StartSlotInput> = {}): StartSlotInput {
  return { wipLimit: 4, active: 1, machineCapacity: roomy, maxNewStartsPerCycle: 2, startedThisCycle: 0, fleetOverflow: false, ...overrides };
}

describe("decideStartSlots (#1102) — the one slot arithmetic both monitor loops and /autopilot use", () => {
  it("slots = min(free WIP, starts left this cycle)", () => {
    expect(decideStartSlots(input())).toMatchObject({ slots: 2, wipSlots: 3, startsRemaining: 2, effectiveLimit: 4, holdReason: null });
    expect(decideStartSlots(input({ maxNewStartsPerCycle: 10 }))).toMatchObject({ slots: 3, wipSlots: 3 });
  });

  it("WIP full: holds with wip_full and no slots", () => {
    expect(decideStartSlots(input({ active: 4 }))).toMatchObject({ slots: 0, wipSlots: 0, holdReason: "wip_full" });
    expect(decideStartSlots(input({ active: 6 })).holdReason).toBe("wip_full");
  });

  it("machine clamp: a Tier-1 headroom of 1 lowers the effective limit to active + 1", () => {
    const d = decideStartSlots(input({ wipLimit: 5, active: 2, machineCapacity: tier1(1), maxNewStartsPerCycle: 3 }));
    expect(d).toMatchObject({ slots: 1, wipSlots: 1, effectiveLimit: 3, holdReason: null });
    expect(d.clamp).toEqual({ configured: 5, effective: 3, clamped: true });
  });

  it("machine clamp to zero headroom holds as machine_full", () => {
    expect(decideStartSlots(input({ wipLimit: 5, active: 2, machineCapacity: tier1(0) }))).toMatchObject({
      slots: 0, wipSlots: 0, effectiveLimit: 2, holdReason: "machine_full",
    });
  });

  it("a saturated host holds unless the fleet can absorb the overflow (#908)", () => {
    expect(decideStartSlots(input({ machineCapacity: saturated })).holdReason).toBe("machine_full");
    expect(decideStartSlots(input({ machineCapacity: saturated })).hostFull).toBe(true);
    const routed = decideStartSlots(input({ machineCapacity: saturated, fleetOverflow: true }));
    expect(routed).toMatchObject({ hostFull: false, holdReason: null, slots: 2 });
  });

  it("start cap: no slots, but the free WIP slots are still reported so the pull loop records the cap per ticket", () => {
    expect(decideStartSlots(input({ startedThisCycle: 2 }))).toMatchObject({ slots: 0, wipSlots: 3, startsRemaining: 0, holdReason: "start_cap" });
  });

  it("manual mode holds before anything else", () => {
    expect(decideStartSlots(input({ autoStart: false, active: 9, machineCapacity: saturated }))).toMatchObject({ slots: 0, wipSlots: 0, holdReason: "manual_mode" });
  });

  it("WIP full outranks a machine hold — the operator's own limit is the more specific answer", () => {
    expect(decideStartSlots(input({ active: 4, machineCapacity: saturated })).holdReason).toBe("wip_full");
  });

  it("is pure: the same input gives the same verdict", () => {
    const i = input({ machineCapacity: tier1(2) });
    expect(decideStartSlots(i)).toEqual(decideStartSlots(i));
  });
});

describe("clampWipToHeadroom (moved from monitor-start-holds by #1102)", () => {
  it("never raises the configured limit and leaves Tier 0 unclamped", () => {
    expect(clampWipToHeadroom({ wipLimit: 3, currentWip: 1, capacity: tier1(10) })).toEqual({ configured: 3, effective: 3, clamped: false });
    expect(clampWipToHeadroom({ wipLimit: 3, currentWip: 1, capacity: roomy })).toEqual({ configured: 3, effective: 3, clamped: false });
  });
});
