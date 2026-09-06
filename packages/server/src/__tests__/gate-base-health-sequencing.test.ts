/**
 * #1009 — the merge gate SEQUENCES the base-health run against its own verify.
 *
 * Observed on #999: a stale base verdict made a fresh base-health probe of master run in a
 * temp clone WHILE the branch's verify_script ran — two full server suites on a host already
 * swapping, both to their timeouts. The gate now (1) joins a probe already in flight, (2) runs a
 * due probe FIRST, then the branch, (3) defers a due probe with a visible message when the host
 * is below the Tier-0 floor, and says which of the three happened in its message. Every path is
 * exercised here through the injection seams, with no probe, database or clock involved.
 */
import { describe, it, expect, vi } from "vitest";
import { sequenceBaseHealthBeforeVerify, type BaseHealthSequenceDeps } from "../services/gate-base-health-sequencing.js";
import type { Database } from "../db/index.js";
import { verifyChainGateWaiting } from "../services/verify-chain-semaphore.js";

const db = {} as Database;

function deps(overrides: Partial<BaseHealthSequenceDeps> = {}): Partial<BaseHealthSequenceDeps> {
  return {
    inFlight: () => null,
    sweepIntervalMs: async () => 30 * 60 * 1000,
    resolveDue: async () => ({ due: false, reason: "recent_result" }),
    runProbe: async () => ({ outcome: "green", sha: "abc", branch: "master", durationMs: 10 }),
    notePhase: () => {},
    ...overrides,
  };
}

describe("sequenceBaseHealthBeforeVerify (#1009)", () => {
  it("JOINS a probe already in flight and waits for its result before returning", async () => {
    let settle!: (r: { outcome: "red"; sha: string; branch: string; durationMs: number }) => void;
    const running = new Promise<{ outcome: "red"; sha: string; branch: string; durationMs: number }>((r) => { settle = r; });
    const runProbe = vi.fn();
    const notePhase = vi.fn();
    const pending = sequenceBaseHealthBeforeVerify({
      projectId: "p", database: db, workspaceId: "ws",
      deps: deps({ inFlight: () => running, runProbe, notePhase }),
    });
    let resolved = false;
    void pending.then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 20));
    // Still waiting on the in-flight run — the branch verify has not been allowed to start.
    expect(resolved).toBe(false);
    expect(verifyChainGateWaiting()).toBe(true);
    settle({ outcome: "red", sha: "abc", branch: "master", durationMs: 1 });
    const out = await pending;
    expect(verifyChainGateWaiting()).toBe(false);
    expect(out.action).toBe("joined");
    expect(out.note).toContain("joined an in-flight run");
    expect(out.note).toContain("base red");
    expect(out.waitedMs).toBeGreaterThanOrEqual(0);
    // It reused, never started a second one.
    expect(runProbe).not.toHaveBeenCalled();
    expect(notePhase).toHaveBeenCalledWith("ws", expect.stringContaining("in flight"));
  });

  it("runs a DUE probe first and reports reason, wait and verdict", async () => {
    const runProbe = vi.fn(async () => ({ outcome: "green" as const, sha: "abc", branch: "master", durationMs: 1 }));
    const out = await sequenceBaseHealthBeforeVerify({
      projectId: "p", database: db, workspaceId: "ws",
      deps: deps({ resolveDue: async () => ({ due: true, reason: "interval_elapsed" }), runProbe }),
    });
    expect(out.action).toBe("ran_first");
    expect(runProbe).toHaveBeenCalledTimes(1);
    expect(out.note).toContain("ran FIRST (interval_elapsed");
    expect(out.note).toContain("base green");
    expect(out.note).toContain("before the branch verify");
  });

  it("DEFERS with a visible note when the host is below the Tier-0 floor — launches nothing", async () => {
    const runProbe = vi.fn();
    const out = await sequenceBaseHealthBeforeVerify({
      projectId: "p", database: db, workspaceId: "ws",
      deps: deps({ resolveDue: async () => ({ due: false, reason: "host_saturated" }), runProbe }),
    });
    expect(out.action).toBe("deferred");
    expect(runProbe).not.toHaveBeenCalled();
    expect(out.note).toContain("DEFERRED");
    expect(out.note).toContain("not re-measured");
  });

  it("is silent when the project never opted into a base sweep (no cadence)", async () => {
    const resolveDue = vi.fn();
    const runProbe = vi.fn();
    const out = await sequenceBaseHealthBeforeVerify({
      projectId: "p", database: db, workspaceId: "ws",
      deps: deps({ sweepIntervalMs: async () => null, resolveDue, runProbe }),
    });
    expect(out).toEqual({ action: "not_due", note: null, waitedMs: 0 });
    // No cadence, no due check, no probe — the gate must not invent base runs nobody asked for.
    expect(resolveDue).not.toHaveBeenCalled();
    expect(runProbe).not.toHaveBeenCalled();
  });

  it.each([
    ["recent_result"], ["sha_unchanged"], ["gate_running"], ["probe_in_flight"],
  ] as const)("is silent for a not-due verdict (%s)", async (reason) => {
    const runProbe = vi.fn();
    const out = await sequenceBaseHealthBeforeVerify({
      projectId: "p", database: db, workspaceId: "ws",
      deps: deps({ resolveDue: async () => ({ due: false, reason }), runProbe }),
    });
    expect(out.action).toBe("not_due");
    expect(out.note).toBeNull();
    expect(runProbe).not.toHaveBeenCalled();
  });

  it("a probe that REJECTS still yields a note — the gate proceeds, never throws", async () => {
    const out = await sequenceBaseHealthBeforeVerify({
      projectId: "p", database: db, workspaceId: "ws",
      deps: deps({
        resolveDue: async () => ({ due: true, reason: "no_history" }),
        runProbe: async () => { throw new Error("clone failed"); },
      }),
    });
    expect(out.action).toBe("ran_first");
    expect(out.note).toContain("no verdict recorded");
  });

  it("an error in the sequencing itself is non-fatal and silent", async () => {
    const out = await sequenceBaseHealthBeforeVerify({
      projectId: "p", database: db, workspaceId: "ws",
      deps: deps({ sweepIntervalMs: async () => { throw new Error("prefs unreadable"); } }),
    });
    expect(out).toEqual({ action: "error", note: null, waitedMs: 0 });
  });
});
