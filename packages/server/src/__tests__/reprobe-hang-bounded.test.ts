// #1717: a reprobe decision / placement read that never settles must not hang the caller, and a
// pending worker wait must end when its socket is replaced or closed.
import { describe, it, expect, vi, afterEach } from "vitest";
import type { WSContext } from "hono/ws";
import { withTimeout, TimeoutError } from "../lib/with-timeout.js";
import { createWorkerConnectionManager } from "../services/worker-connection.service.js";
import type { WorkerRegistry } from "../services/worker-registry.service.js";
import { planVerifyPlacement } from "../services/verify-job-placement.js";

afterEach(() => vi.restoreAllMocks());

function fakeRegistry(): WorkerRegistry {
  return { onRevoke: () => {}, touchHeartbeat: async () => {}, noteAttestedProfiles: () => {}, notePackageManagers: () => {}, noteToolchains: () => {}, noteProviderNotice: () => {}, noteDoctor: () => {}, noteCapabilities: async () => {} } as unknown as WorkerRegistry;
}
const ws = () => ({ send: () => {}, close: () => {}, raw: {} }) as unknown as WSContext;

describe("withTimeout (#1717)", () => {
  it("rejects with TimeoutError when the promise never settles", async () => {
    await expect(withTimeout(new Promise(() => {}), 20, "x")).rejects.toBeInstanceOf(TimeoutError);
  });
  it("passes a settled value through", async () => {
    await expect(withTimeout(Promise.resolve(3), 1000, "x")).resolves.toBe(3);
  });
});

describe("worker connection waits (#1717)", () => {
  it("a socket closing notifies disconnect listeners", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const mgr = createWorkerConnectionManager(fakeRegistry());
    const seen: string[] = [];
    mgr.onDisconnect((id) => seen.push(id));
    const s = ws();
    mgr.handleOpen("w1", s);
    mgr.handleClose("w1", s);
    expect(seen).toEqual(["w1"]);
  });
  it("a worker re-registering under the same id notifies disconnect listeners at once", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const mgr = createWorkerConnectionManager(fakeRegistry());
    const seen: string[] = [];
    mgr.onDisconnect((id) => seen.push(id));
    mgr.handleOpen("w1", ws());
    mgr.handleOpen("w1", ws());
    expect(seen).toEqual(["w1"]);
    expect(mgr.isConnected("w1")).toBe(true);
  });
});

describe("placement read against a hung worker list (#1717)", () => {
  it("settles within the bound instead of hanging", async () => {
    vi.useFakeTimers();
    try {
      const hung = { listWorkers: () => new Promise<never>(() => {}), run: async () => { throw new Error("unused"); } };
      const database = { select: () => { throw new Error("no db"); } } as never;
      const p = planVerifyPlacement({ kind: "base-probe", projectId: "p", database, workerRunner: hung as never });
      await vi.advanceTimersByTimeAsync(6_000);
      await expect(p).resolves.toMatchObject({ target: expect.stringMatching(/host|hold/) });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("reprobe decision with a hung read (#1717)", () => {
  it("answers placement_unreadable instead of hanging", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { requestBaseBranchReprobe } = await import("../services/base-branch-health-reprobe.service.js");
    const hungDb = new Proxy({}, { get: () => () => new Promise(() => {}) }) as never;
    const verdict = await requestBaseBranchReprobe("p", hungDb, undefined, undefined, { ignoreRecency: true, decisionTimeoutMs: 50 });
    expect(verdict).toEqual({ due: false, reason: "placement_unreadable" });
  });
});
