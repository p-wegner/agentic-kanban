import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn(),
    // The end-of-cycle per-issue skip flush (#919) is a decoration on a decision already
    // taken; `monitor-auto-start-skip-reason.test.ts` is where that write is asserted.
    update: vi.fn(() => ({ set: () => ({ where: async () => undefined }) })),
  },
}));

import { db } from "../db/index.js";
import { runAutoStart, type AutoStartDeps } from "../startup/monitor-auto-start.js";
import { clampWipToHeadroom } from "../startup/monitor-start-holds.js";
import { openFileContentionGate } from "../startup/monitor-file-contention.js";

function makeSelectChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const fn of ["from", "where", "innerJoin", "leftJoin", "orderBy"]) {
    chain[fn] = () => chain;
  }
  chain.limit = () => Promise.resolve(result);
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  chain.catch = (fn: (e: unknown) => unknown) => Promise.resolve(result).catch(fn);
  return chain as unknown as ReturnType<typeof db.select>;
}

function makeDeps(overrides: Partial<AutoStartDeps> = {}): AutoStartDeps {
  return {
    serverPort: 3001,
    boardEvents: { broadcast: vi.fn() } as unknown as AutoStartDeps["boardEvents"],
    logMonitorAction: vi.fn(),
    allowProject: () => true,
    // Injected for the same ordered-mock-chain reason `monitor-auto-start.test.ts` documents:
    // each of these reads the DB, and letting a real one run consumes a `db.select` entry and
    // silently shifts every subsequent mock in the chain.
    buildContentionGate: async () => openFileContentionGate(),
    canDispatch: async () => ({ available: true }) as const,
    orderStartCandidates: async () => {},
    ...overrides,
  };
}

/** Tier 1, the tier that actually MEASURES process headroom (#1019). */
function tier1(headroomProcesses: number, canStartAnother: boolean, thrashing = "none") {
  return { tier: "1" as const, canStartAnother, hold: !canStartAnother, headroomProcesses, thrashing };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("fetch", vi.fn());
});

describe("clampWipToHeadroom (#1019 — the graded half of the capacity signal)", () => {
  const TIER0 = { tier: "0" as const, hold: false, reason: "9.0GB free", freeGb: 9 };

  it("leaves the configured target alone when the box has room for it", () => {
    expect(clampWipToHeadroom({ wipLimit: 5, currentWip: 1, capacity: tier1(8, true) }))
      .toEqual({ configured: 5, effective: 5, clamped: false });
  });

  it("clamps to what is already running plus the measured headroom", () => {
    // Headroom counts ADDITIONAL processes, so the two builders already running stay running
    // and exactly one more may start.
    expect(clampWipToHeadroom({ wipLimit: 5, currentWip: 2, capacity: tier1(1, true) }))
      .toEqual({ configured: 5, effective: 3, clamped: true });
  });

  it("clamps to zero when nothing is running and the box has no headroom", () => {
    expect(clampWipToHeadroom({ wipLimit: 3, currentWip: 0, capacity: tier1(0, false, "heavy") }))
      .toEqual({ configured: 3, effective: 0, clamped: true });
  });

  it("never RAISES the configured target, however much headroom there is", () => {
    expect(clampWipToHeadroom({ wipLimit: 2, currentWip: 0, capacity: tier1(64, true) }).effective).toBe(2);
  });

  it("treats a negative headroom reading as zero rather than as a negative limit", () => {
    expect(clampWipToHeadroom({ wipLimit: 4, currentWip: 1, capacity: tier1(-3, true) }))
      .toEqual({ configured: 4, effective: 1, clamped: true });
  });

  it("does NOT clamp on Tier 0 — it never measured headroom, and a fabricated clamp would read as a measurement", () => {
    expect(clampWipToHeadroom({ wipLimit: 5, currentWip: 0, capacity: TIER0 }))
      .toEqual({ configured: 5, effective: 5, clamped: false });
  });
});

describe("runAutoStart WIP clamp against measured headroom (#1019)", () => {
  it("starts nothing and REPORTS the clamped WIP when the snapshot is saturated", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }])) // inProgressStatuses
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }])) // loop1 activeWip
      .mockReturnValueOnce(makeSelectChain([])) // loop1 hold: todoStatus (none -> no attribution)
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }])) // loop2 capacity
      .mockReturnValueOnce(makeSelectChain([])); // loop2 hold: todoStatus (none)

    const skips = await runAutoStart(
      new Map([["nudge_auto_start", "true"], ["nudge_wip_limit", "5"]]),
      makeDeps({
        readMachineCapacity: async () => tier1(0, false, "heavy"),
        hostOverflowHasFleetCapacity: async () => false,
      }),
    );

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(skips.get("proj-1")?.reasonCounts.machine_saturated).toBe(2);
    // The point of the ticket: the tally carries WHAT the limit became, not only that a hold
    // happened — a bare `machine_saturated` token cannot distinguish 0 from 2.
    expect(skips.get("proj-1")?.machineSaturation).toMatchObject({
      tier: "1",
      headroomProcesses: 0,
      configuredWipLimit: 5,
      clampedWipLimit: 0,
    });
  });

  it("starts nothing when the box says it can take one more but that slot is already used", async () => {
    // The gap this closes: `canStartAnother` is TRUE (so #908's binary hold does not fire) while
    // headroom is 0 — a project configured at WIP 5 would previously have launched four more.
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }])) // inProgressStatuses
      .mockReturnValueOnce(makeSelectChain([{ count: 1 }])) // loop1 activeWip: one builder running
      .mockReturnValueOnce(makeSelectChain([])) // loop1 hold: todoStatus (none)
      .mockReturnValueOnce(makeSelectChain([{ count: 1 }])) // loop2 capacity
      .mockReturnValueOnce(makeSelectChain([])); // loop2 hold: todoStatus (none)

    const skips = await runAutoStart(
      new Map([["nudge_auto_start", "true"], ["nudge_wip_limit", "5"]]),
      makeDeps({
        readMachineCapacity: async () => tier1(0, true),
        // Never consulted: the host is not SATURATED, so the #908 overflow branch is not taken.
        hostOverflowHasFleetCapacity: async () => {
          throw new Error("fleet overflow must not be consulted for an unsaturated host");
        },
      }),
    );

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(skips.get("proj-1")?.reasonCounts.machine_saturated).toBe(2);
    expect(skips.get("proj-1")?.machineSaturation).toMatchObject({ configuredWipLimit: 5, clampedWipLimit: 1 });
  });

  it("is unchanged on an unsaturated box with room — the ticket still starts", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }])) // inProgressStatuses
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }])) // loop1 activeWip
      .mockReturnValueOnce(makeSelectChain([])) // loop1 inProgressIssues (none)
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }])) // loop2 capacity
      .mockReturnValueOnce(makeSelectChain([{ id: "todo-1" }])) // todoStatus
      .mockReturnValueOnce(makeSelectChain([{ id: "issue-1", title: "Roomy", projectId: "proj-1", issueNumber: 7 }])) // todoIssues
      .mockReturnValueOnce(makeSelectChain([{ id: "done-1" }])) // doneStatuses
      .mockReturnValueOnce(makeSelectChain([])) // existingWs (none)
      .mockReturnValueOnce(makeSelectChain([])) // no-auto-start tag (none)
      .mockReturnValueOnce(makeSelectChain([])); // deps (none)
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ id: "ws-new" }) } as Response);

    const skips = await runAutoStart(
      new Map([["nudge_auto_start", "true"], ["nudge_wip_limit", "5"]]),
      makeDeps({ readMachineCapacity: async () => tier1(8, true) }),
    );

    expect(vi.mocked(fetch)).toHaveBeenCalledWith("http://127.0.0.1:3001/api/workspaces?async=1&autoStart=1", expect.any(Object));
    expect(skips.get("proj-1")?.reasonCounts.machine_saturated).toBeUndefined();
  });
});
