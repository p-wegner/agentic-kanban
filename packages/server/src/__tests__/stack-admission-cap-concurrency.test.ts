import { describe, it, expect } from "vitest";
import {
  provisionServicesForLaunch,
  inFlightStackProvisionCount,
  type StackAdmissionDeps,
} from "../services/workspace-create-stack.service.js";
import type { Database } from "../db/index.js";
import type { ServiceStackState } from "@agentic-kanban/shared";

// The admission cap must hold under CONCURRENCY, not just sequentially (#107). Before the
// fix, `countLiveStacks` counted only stacks already persisted 'up' (written ~15-30s after
// the gate), so N parallel creates all read live<cap and ALL provisioned. These tests drive
// the real gate with a provision that BLOCKS until released, so all N are in flight at once.

const db = {} as Database;
const servicesConfigRaw = JSON.stringify({ enabled: true, composeFile: "docker-compose.yml" });

function upState(id: string): ServiceStackState {
  return { composeProjectName: `ak-test-${id}`, ports: {}, envFilePath: "", status: "up", updatedAt: new Date().toISOString() };
}

/** A provision that resolves only when its gate is released — so callers stay "in flight". */
function makeBlockingProvision() {
  const releases: Array<() => void> = [];
  const started: string[] = [];
  const provision: NonNullable<StackAdmissionDeps["provisionWorkspaceServices"]> = async (args) => {
    started.push(args.workspaceId);
    await new Promise<void>((resolve) => releases.push(resolve));
    return upState(args.workspaceId);
  };
  return { provision, releaseAll: () => releases.forEach((r) => r()), started };
}

function launch(id: string, deps: StackAdmissionDeps) {
  return provisionServicesForLaunch(
    db,
    { servicesConfigRaw, workspaceId: id, workspaceCreatedAt: new Date().toISOString(), branch: `feature/${id}`, leadingWorktreePath: `C:/wt/${id}`, siblings: [] },
    deps,
  );
}

describe("stack admission cap under concurrency (#107)", () => {
  it("with cap=2 and 4 SIMULTANEOUS provisions, exactly 2 proceed and 2 defer", async () => {
    const { provision, releaseAll, started } = makeBlockingProvision();
    const deps: StackAdmissionDeps = {
      getMaxConcurrentStacks: async () => 2,
      countLiveStacks: async () => 0, // nothing persisted 'up' yet — the pre-fix bypass condition
      provisionWorkspaceServices: provision,
    };

    // Fire all four "at once": each runs its gate synchronously before the blocking provision.
    const inflight = [launch("w1", deps), launch("w2", deps), launch("w3", deps), launch("w4", deps)];
    // Let the microtask queue drain so every gate has decided.
    await new Promise((r) => setTimeout(r, 20));

    // Exactly 2 got past the gate into the (blocked) provision; 2 deferred without provisioning.
    expect(started.sort()).toEqual(["w1", "w2"]);
    expect(inFlightStackProvisionCount()).toBe(2);

    releaseAll();
    const results = await Promise.all(inflight);
    const deferred = results.filter((r) => r?.state.deferred).length;
    const up = results.filter((r) => r?.state.status === "up").length;
    expect(up).toBe(2);
    expect(deferred).toBe(2);
    // Reservations released after completion.
    expect(inFlightStackProvisionCount()).toBe(0);
  });

  it("releases the reservation on provision throw (no permanent leak that would wedge the cap)", async () => {
    const deps: StackAdmissionDeps = {
      getMaxConcurrentStacks: async () => 1,
      countLiveStacks: async () => 0,
      provisionWorkspaceServices: async () => {
        throw new Error("compose boom");
      },
    };
    const res = await launch("boom1", deps);
    expect(res?.state.status).toBe("error");
    expect(res?.state.deferred).toBeFalsy();
    expect(inFlightStackProvisionCount()).toBe(0); // finally ran despite the throw
  });

  it("cap=0 (unlimited) never reserves or defers", async () => {
    const { provision, releaseAll } = makeBlockingProvision();
    const deps: StackAdmissionDeps = {
      getMaxConcurrentStacks: async () => 0,
      countLiveStacks: async () => 999,
      provisionWorkspaceServices: provision,
    };
    const p = launch("unl1", deps);
    await new Promise((r) => setTimeout(r, 10));
    expect(inFlightStackProvisionCount()).toBe(0); // cap 0 → no reservation taken
    releaseAll();
    const res = await p;
    expect(res?.state.status).toBe("up");
  });
});
