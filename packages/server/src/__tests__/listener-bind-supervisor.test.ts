import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  superviseBind, getListenerState, resetListenerStates, bindRetryDelayMs,
} from "../services/listener-bind-supervisor.service.js";
import { resolveBindHost, resolveTailscaleIp4 } from "../lib/tailscale-host.js";
import { listenerStateCheck } from "../cli/commands/worker-doctor.js";

describe("listener bind supervisor (#1325)", () => {
  beforeEach(() => {
    resetListenerStates();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("a bind failure schedules a retry and a later success is reported", async () => {
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const eaddr = Object.assign(new Error("listen EADDRNOTAVAIL: address not available 100.64.0.1:3003"), { code: "EADDRNOTAVAIL" });
    const start = vi.fn<() => Promise<{ host: string; port: number }>>()
      .mockRejectedValueOnce(eaddr)
      .mockResolvedValueOnce({ host: "100.64.0.1", port: 3003 });

    await superviseBind({
      name: "fleet-listener",
      configuredHost: "100.64.0.1",
      configuredPort: 3003,
      start,
      describe: (h) => h,
      schedule: (fn, ms) => { scheduled.push({ fn, ms }); return () => {}; },
    });

    expect(getListenerState("fleet-listener")).toMatchObject({
      status: "retrying", host: "100.64.0.1", port: 3003, attempts: 1,
    });
    expect(getListenerState("fleet-listener").error).toContain("EADDRNOTAVAIL");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].ms).toBe(bindRetryDelayMs(1));

    scheduled[0].fn();
    await vi.waitFor(() => expect(getListenerState("fleet-listener").status).toBe("bound"));
    expect(getListenerState("fleet-listener")).toMatchObject({ host: "100.64.0.1", port: 3003, error: null });
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("backs off exponentially up to a cap", () => {
    expect(bindRetryDelayMs(1)).toBe(2_000);
    expect(bindRetryDelayMs(2)).toBe(4_000);
    expect(bindRetryDelayMs(20)).toBe(60_000);
  });

  it("stop() cancels a pending retry and a non-retryable error is not rescheduled", async () => {
    const cancel = vi.fn();
    const sup = await superviseBind({
      name: "fleet-listener", start: () => Promise.reject(new Error("nope")), describe: () => ({ host: "x", port: 1 }),
      schedule: () => cancel,
    });
    sup.stop();
    expect(cancel).toHaveBeenCalled();

    const schedule = vi.fn(() => () => {});
    await superviseBind({
      name: "git-http", start: () => Promise.reject(new Error("misconfigured")), describe: () => ({ host: "x", port: 1 }),
      isRetryable: () => false, schedule,
    });
    expect(schedule).not.toHaveBeenCalled();
  });
});

describe("KANBAN_FLEET_HOST=tailscale (#1325)", () => {
  it("resolves the first IPv4 from `tailscale ip -4`", () => {
    expect(resolveTailscaleIp4(() => "100.101.102.103\n")).toBe("100.101.102.103");
    expect(resolveBindHost("tailscale", () => "100.64.0.9\r\n")).toBe("100.64.0.9");
  });

  it("refuses (throws) rather than widening when unresolvable", () => {
    expect(() => resolveTailscaleIp4(() => { throw new Error("ENOENT"); })).toThrow(/refusing/);
    expect(() => resolveTailscaleIp4(() => "")).toThrow(/refusing/);
  });

  it("passes literal hosts through untouched", () => {
    expect(resolveBindHost("127.0.0.1")).toBe("127.0.0.1");
  });
});

describe("doctor-board listener checks (#1325)", () => {
  it("reports bound, retrying, and skips disabled", () => {
    expect(listenerStateCheck("fleet listener", { status: "bound", host: "100.64.0.1", port: 3003 })?.status).toBe("pass");
    const retry = listenerStateCheck("fleet listener", { status: "retrying", host: "100.64.0.1", port: 3003, attempts: 2, error: "EADDRNOTAVAIL" });
    expect(retry?.status).toBe("fail");
    expect(retry?.detail).toContain("EADDRNOTAVAIL");
    expect(listenerStateCheck("fleet listener", { status: "disabled" })).toBeNull();
    expect(listenerStateCheck("fleet listener", undefined)).toBeNull();
  });
});
