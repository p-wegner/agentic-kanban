/**
 * #751 — placement races in the git-transport dispatch path.
 *
 * The board decides WHERE a session runs and then reality diverges from that
 * decision with nobody noticing. Three concrete shapes, all pinned here:
 *
 *  1. **Double assignment.** Fleet load was counted from the moment the `assign`
 *     went on the wire. For a true-remote (git-transport) placement that send is
 *     deferred behind async prerequisites, so two concurrent placements both read
 *     the worker as free and both land on it; the loser comes back as
 *     `assign_failed: capacity` -> a failed session, not a host fallback.
 *  2. **A deferred failure bypassed the host-fallback / strict contract**, because
 *     that contract was written against a THROWN `launch` and the git-transport path
 *     never throws.
 *  3. **`kill` dropped the routing entry** before the worker's exit arrived, so
 *     lifecycle queries were answered by the host implementation ("gone") while the
 *     remote service still held the session.
 *
 * The first one is a race, so it is driven CONCURRENTLY: a sequential test would
 * pass against the broken code.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { preferences, projects as projectsTable } from "@agentic-kanban/shared/schema";
import type { WSContext } from "hono/ws";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import {
  getWorkerFleet,
  resolveWorkerPlacement,
  selectAndReserveWorkerForLaunch,
  workerDispatchPrefKey,
  workerStrictPrefKey,
  type WorkerFleet,
} from "../services/worker-fleet.service.js";
import {
  __resetWorkerSlotReservations,
  __reservationCount,
  releaseWorkerSlot,
} from "../services/worker-slot-reservation.service.js";
import {
  createAgentDispatch,
  DISPATCH_LAUNCH_FAILURE_PREFIX,
  type AgentExecutionService,
  type AgentLaunchRequest,
  type Placement,
} from "../services/agent-dispatch.service.js";
import type { AgentOutputCallback, AgentOutputEvent } from "../services/agent.service.js";
import { classifyAssignFailure } from "../services/worker-connection.service.js";

const PROJECT_ID = "cccc1111-2222-3333-4444-555566667777";

/**
 * The fleet grew a protocol handshake while this suite was being written, so
 * `registerWorker` now refuses a worker that reports no version. Declared through an
 * intersection rather than by importing the new constant: this suite is about
 * placement, and it should not go red either way over a field it does not test.
 */
type RegisterWorkerInput = Parameters<WorkerFleet["registry"]["registerWorker"]>[0] & {
  protocolVersion?: number;
};
const SPEAKS_CURRENT_PROTOCOL: Pick<RegisterWorkerInput, "protocolVersion"> = { protocolVersion: 1 };


function fakeWs(): WSContext {
  return { send: () => {}, close: () => {} } as unknown as WSContext;
}

function mockExecutionService(pid: number): AgentExecutionService {
  return {
    launch: vi.fn(() => ({ pid })),
    kill: vi.fn(() => true),
    sendInput: vi.fn(() => true),
    closeStdin: vi.fn(() => true),
    isStdinOpen: vi.fn(() => true),
    getProcess: vi.fn(() => ({ pid })),
    getPid: vi.fn(() => pid),
    isPidAlive: vi.fn(() => true),
  };
}

describe("#751 double assignment — placement claims the capacity slot", () => {
  let db: Database;
  let fleet: WorkerFleet;

  beforeEach(() => {
    // The reservation ledger is process-wide (the dispatch proxy has no db handle),
    // so suites must not inherit each other's slots.
    __resetWorkerSlotReservations();
    db = createTestDb().db as unknown as Database;
    fleet = getWorkerFleet(db);
  });

  async function optIn(strict = false) {
    await db.insert(preferences).values({ key: workerDispatchPrefKey(PROJECT_ID), value: "true" });
    if (strict) await db.insert(preferences).values({ key: workerStrictPrefKey(PROJECT_ID), value: "true" });
    await db.insert(projectsTable).values({
      id: PROJECT_ID,
      name: "race-fixture",
      repoPath: "C:/some/repo",
      defaultBranch: "master",
    } as typeof projectsTable.$inferInsert);
  }

  async function connectWorker(maxConcurrency: number) {
    const { pairingToken } = fleet.registry.mintPairingToken();
    const result = await fleet.registry.registerWorker({
      pairingToken, name: "w", maxConcurrency, ...SPEAKS_CURRENT_PROTOCOL,
    });
    if (!result.ok) throw new Error(result.error);
    fleet.connections.handleOpen(result.workerId, fakeWs());
    return result.workerId;
  }

  const placeOnce = () =>
    resolveWorkerPlacement({
      database: db,
      projectId: PROJECT_ID,
      providerName: "claude",
      branch: "feature/751",
      baseBranch: "master",
    });

  it("gives the single free slot to exactly ONE of two concurrent placements", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await optIn();
    await connectWorker(1);

    // CONCURRENT on purpose. Both calls read the worker's load, and before the fix
    // both read 0 — the losing one only discovered the collision on the worker, as
    // `assign_failed: capacity`.
    const placements = await Promise.all([placeOnce(), placeOnce()]);

    const remote = placements.filter((p) => p.kind === "remote");
    expect(remote).toHaveLength(1);
    expect(placements.filter((p) => p.kind === "host")).toHaveLength(1);
    // The winner carries the slot it claimed, so the launch can bind it to a session.
    expect(remote[0]!.kind === "remote" && remote[0].reservationId).toBeTruthy();
    warn.mockRestore();
  });

  it("hands out at most `maxConcurrency` slots however many placements race", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await optIn();
    await connectWorker(2);

    const placements = await Promise.all([placeOnce(), placeOnce(), placeOnce(), placeOnce(), placeOnce()]);
    expect(placements.filter((p) => p.kind === "remote")).toHaveLength(2);
    warn.mockRestore();
  });

  it("refuses (never over-assigns) when the loser's project forbids the host fallback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await optIn(true);
    await connectWorker(1);

    const results = await Promise.allSettled([placeOnce(), placeOnce()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // Strict mode's whole purpose: the loser fails loudly rather than quietly
    // running on the board host or piling onto the full worker.
    const reason = (rejected[0] as PromiseRejectedResult).reason as Error & { code?: string };
    expect(reason.code).toBe("NO_AVAILABLE_WORKER");
    warn.mockRestore();
  });

  it("gives the slot back when the placement ends up on the host anyway", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await optIn();
    const workerId = await connectWorker(1);

    // No branch => a true-remote worker has nothing to push back => host fallback.
    // The reservation taken during selection must not outlive that decision, or the
    // worker silently loses a slot until the TTL expires.
    const placement = await resolveWorkerPlacement({
      database: db,
      projectId: PROJECT_ID,
      providerName: "claude",
    });
    expect(placement).toEqual({ kind: "host" });
    expect(__reservationCount(workerId)).toBe(0);

    // ...and the worker is therefore still placeable.
    const next = await placeOnce();
    expect(next.kind).toBe("remote");
    warn.mockRestore();
  });

  it("frees the slot again once an unclaimed reservation is released", async () => {
    await optIn();
    const workerId = await connectWorker(1);
    const first = await selectAndReserveWorkerForLaunch(fleet, "claude");
    expect(first?.workerId).toBe(workerId);
    expect(await selectAndReserveWorkerForLaunch(fleet, "claude")).toBeNull();
    releaseWorkerSlot(first!.reservationId);
    expect((await selectAndReserveWorkerForLaunch(fleet, "claude"))?.workerId).toBe(workerId);
  });

  it("stops double-counting once the reserved slot is claimed by its session", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await optIn();
    const workerId = await connectWorker(2);
    const placement = await placeOnce();
    expect(placement.kind).toBe("remote");

    const host = mockExecutionService(101);
    const remote = mockExecutionService(202);
    const dispatch = createAgentDispatch({ host, remote });
    dispatch.launch({
      worktreePath: "/wt", sessionId: "s-claimed", prompt: "go",
      agentArgs: undefined, onOutput: () => {}, placement,
    });
    // The worker then reports the session running. Reservation + assigned set must
    // resolve to ONE occupied slot, not two — otherwise a maxConcurrency-2 worker
    // looks full with a single session on it.
    fleet.connections.handleMessage(
      workerId,
      JSON.stringify({ type: "event", event: { type: "stdout", sessionId: "s-claimed", data: "x" } }),
    );
    const second = await placeOnce();
    expect(second.kind).toBe("remote");
    warn.mockRestore();
  });
});

describe("#751 deferred launch failures honour the host-fallback / strict contract", () => {
  let host: AgentExecutionService;
  let remote: AgentExecutionService;

  beforeEach(() => {
    __resetWorkerSlotReservations();
    host = mockExecutionService(101);
    remote = mockExecutionService(202);
  });

  /** A remote impl whose launch returns fine and fails LATER, as git transport does. */
  function failsLate(kind: "dispatch" | "capacity" | "provisioning" | "worker-lost", reason: string) {
    let fire: (() => void) | undefined;
    (remote.launch as ReturnType<typeof vi.fn>).mockImplementation((request: AgentLaunchRequest) => {
      fire = () => request.onDeferredLaunchFailure?.({ kind, reason });
      return {};
    });
    return () => {
      if (!fire) throw new Error("the proxy did not install a deferred-failure hook");
      fire();
    };
  }

  const remotePlacement = (strict?: boolean): Placement => ({
    kind: "remote", workerId: "w1", strict, reservationId: "res-1",
  });

  it("relaunches on the host when a NON-strict remote launch fails after launch returned", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fireFailure = failsLate("dispatch", "fleet worker w1 is not connected");
    const dispatch = createAgentDispatch({ host, remote });
    const seen: AgentOutputEvent[] = [];
    dispatch.launch({
      worktreePath: "/wt", sessionId: "s1", prompt: "go",
      agentArgs: undefined, onOutput: (e) => seen.push(e), placement: remotePlacement(),
    });
    expect(host.launch).not.toHaveBeenCalled();

    fireFailure();

    // The contract #245 established for a thrown launch, now honoured for the async
    // path too: a non-strict project gets a host RUN, not a failed session.
    expect(host.launch).toHaveBeenCalledOnce();
    expect(seen.some((e) => e.type === "exit")).toBe(false);
    // Follow-ups must now reach the host implementation.
    dispatch.sendInput("s1", "hi");
    expect(host.sendInput).toHaveBeenCalledWith("s1", "hi");
    warn.mockRestore();
  });

  it("fails the session with a DISPATCH-labelled reason under strict, and never touches the host", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fireFailure = failsLate("provisioning", "clone failed: cannot lock ref");
    const dispatch = createAgentDispatch({ host, remote });
    const seen: AgentOutputEvent[] = [];
    dispatch.launch({
      worktreePath: "/wt", sessionId: "s1", prompt: "go",
      agentArgs: undefined, onOutput: (e) => seen.push(e), placement: remotePlacement(true),
    });

    fireFailure();

    expect(host.launch).not.toHaveBeenCalled();
    const stderr = seen.find((e) => e.type === "stderr");
    // #751's observability half: the session must SAY it died in dispatch. Without
    // this an operator cannot tell "no worker took it" from "a worker took it and
    // the launch died", because both arrive as exit 1.
    expect(stderr && "data" in stderr ? stderr.data : "").toContain(DISPATCH_LAUNCH_FAILURE_PREFIX);
    expect(stderr && "data" in stderr ? stderr.data : "").toContain("NO_AVAILABLE_WORKER");
    expect(stderr && "data" in stderr ? stderr.data : "").toContain("provisioning");
    expect(seen.filter((e) => e.type === "exit")).toHaveLength(1);
    warn.mockRestore();
  });

  it("handles the failure once, whichever path sees it first", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let hook: ((f: { kind: "capacity"; reason: string }) => void) | undefined;
    (remote.launch as ReturnType<typeof vi.fn>).mockImplementation((request: AgentLaunchRequest) => {
      hook = request.onDeferredLaunchFailure as typeof hook;
      return {};
    });
    const dispatch = createAgentDispatch({ host, remote });
    dispatch.launch({
      worktreePath: "/wt", sessionId: "s1", prompt: "go",
      agentArgs: undefined, onOutput: () => {}, placement: remotePlacement(),
    });
    hook!({ kind: "capacity", reason: "at capacity" });
    hook!({ kind: "capacity", reason: "at capacity" });
    expect(host.launch).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("does not hand a fallback host launch a hook that would loop back into itself", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fireFailure = failsLate("worker-lost", "worker did not reconnect");
    const dispatch = createAgentDispatch({ host, remote });
    dispatch.launch({
      worktreePath: "/wt", sessionId: "s1", prompt: "go",
      agentArgs: undefined, onOutput: () => {}, placement: remotePlacement(),
    });
    fireFailure();
    const relayedToHost = (host.launch as ReturnType<typeof vi.fn>).mock.calls[0][0] as AgentLaunchRequest;
    expect(relayedToHost.placement).toEqual({ kind: "host" });
    expect(relayedToHost.onDeferredLaunchFailure).toBeUndefined();
    warn.mockRestore();
  });
});

describe("#751 kill leaves the session routed at the implementation that owns it", () => {
  it("keeps answering session-keyed queries from the remote impl until the exit arrives", () => {
    const host = mockExecutionService(101);
    const remote = mockExecutionService(202);
    const dispatch = createAgentDispatch({ host, remote });
    let wrapped: AgentOutputCallback | undefined;
    (remote.launch as ReturnType<typeof vi.fn>).mockImplementation((request: AgentLaunchRequest) => {
      wrapped = request.onOutput;
      return {};
    });
    dispatch.launch({
      worktreePath: "/wt", sessionId: "s1", prompt: "go",
      agentArgs: undefined, onOutput: () => {}, placement: { kind: "remote", workerId: "w1" },
    });

    dispatch.kill("s1");
    expect(remote.kill).toHaveBeenCalledWith("s1");

    // A kill only ASKS the agent to stop. Until the worker's exit event lands the
    // remote service still owns the session and is still streaming its output —
    // routing these to the host made it answer "gone" for live work.
    dispatch.isPidAlive("s1");
    dispatch.getProcess("s1");
    expect(remote.isPidAlive).toHaveBeenCalledWith("s1");
    expect(remote.getProcess).toHaveBeenCalledWith("s1");
    expect(host.isPidAlive).not.toHaveBeenCalled();

    wrapped!({ type: "exit", sessionId: "s1", exitCode: 143 });
    dispatch.isPidAlive("s1");
    expect(host.isPidAlive).toHaveBeenCalledWith("s1");
  });
});

describe("#751 assign_failed is classified, not flattened into an agent exit", () => {
  it("separates a capacity refusal from a broken checkout from an undeliverable assign", () => {
    expect(classifyAssignFailure("worker is at capacity (maxConcurrency=1)")).toBe("capacity");
    expect(classifyAssignFailure("repo provisioning failed: cannot lock ref")).toBe("provisioning");
    expect(classifyAssignFailure("git clone failed")).toBe("provisioning");
    expect(classifyAssignFailure("something nobody anticipated")).toBe("dispatch");
  });
});
