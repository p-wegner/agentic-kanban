// @gate:always-run when:scripts/promote-startup-retry.mjs — imports a scripts/ module no package-local diff links to (#687).
import { describe, expect, it, vi } from "vitest";
import { fetchWhileStarting } from "../../../../scripts/promote-startup-retry.mjs"; // #1651

const notReady = () => new Response(JSON.stringify({ code: "STARTUP_NOT_READY" }), { status: 503 });

describe("fetchWhileStarting (#1651)", () => {
  it("retries on 503 STARTUP_NOT_READY and returns the ready answer", async () => {
    const doFetch = vi.fn()
      .mockResolvedValueOnce(notReady())
      .mockResolvedValueOnce(notReady())
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const sleep = vi.fn(async () => {});
    const res = await fetchWhileStarting(doFetch, { sleep });
    expect(res.ok).toBe(true);
    expect(doFetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("gives up after the bound, returning the 503", async () => {
    let t = 0;
    const doFetch = vi.fn(async () => notReady());
    const res = await fetchWhileStarting(doFetch, {
      timeoutMs: 30, intervalMs: 10, nowMs: () => t, sleep: async (ms: number) => { t += ms; },
    });
    expect(res.status).toBe(503);
    expect(doFetch.mock.calls.length).toBeGreaterThan(1);
    expect(doFetch.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("does not retry a non-startup error", async () => {
    const doFetch = vi.fn(async () => new Response(JSON.stringify({ code: "OTHER" }), { status: 503 }));
    const sleep = vi.fn(async () => {});
    const res = await fetchWhileStarting(doFetch, { sleep });
    expect(res.status).toBe(503);
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
