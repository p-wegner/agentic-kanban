import { Hono } from "hono";
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  slowRequestLogger,
  createSlowRequestLogger,
  getSlowRequests,
  clearSlowRequests,
  type RequestLagSampler,
} from "../middleware/slow-request-logger.js";

function createTestApp(handlerDelayMs = 0) {
  const app = new Hono();
  app.use("*", slowRequestLogger);
  app.get("/api/test", async (c) => {
    if (handlerDelayMs > 0) {
      await new Promise((r) => setTimeout(r, handlerDelayMs));
    }
    return c.json({ ok: true });
  });
  return app;
}

describe("slowRequestLogger middleware", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SLOW_REQUEST_THRESHOLD_MS;
    clearSlowRequests();
  });

  it("logs at debug level for every request", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const app = createTestApp(0);
    await app.request("/api/test");

    expect(debugSpy).toHaveBeenCalledOnce();
    expect(debugSpy.mock.calls[0][0]).toMatch(/^\[request\] GET \/api\/test \d+ms$/);
  });

  it("does not warn when request is below the threshold", async () => {
    process.env.SLOW_REQUEST_THRESHOLD_MS = "500";
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const app = createTestApp(0);
    await app.request("/api/test");

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns when request exceeds threshold", async () => {
    process.env.SLOW_REQUEST_THRESHOLD_MS = "10";
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const app = createTestApp(50);
    await app.request("/api/test");

    expect(warnSpy).toHaveBeenCalledOnce();
    // No trailing anchor: on a loaded machine the request may legitimately pick up a
    // loop-lag starvation suffix (#405).
    expect(warnSpy.mock.calls[0][0]).toMatch(/^\[slow-request\] GET \/api\/test took \d+ms/);
  });

  it("uses 200ms default threshold when env var is not set", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const app = createTestApp(0);
    await app.request("/api/test");

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("records a slow request in the ring buffer", async () => {
    process.env.SLOW_REQUEST_THRESHOLD_MS = "10";
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const app = createTestApp(50);
    await app.request("/api/test");

    const entries = getSlowRequests();
    expect(entries).toHaveLength(1);
    expect(entries[0].method).toBe("GET");
    expect(entries[0].path).toBe("/api/test");
    expect(entries[0].durationMs).toBeGreaterThanOrEqual(10);
    expect(entries[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("does not record a fast request in the ring buffer", async () => {
    process.env.SLOW_REQUEST_THRESHOLD_MS = "500";
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const app = createTestApp(0);
    await app.request("/api/test");

    expect(getSlowRequests()).toHaveLength(0);
  });

  it("returns entries most-recent first", async () => {
    process.env.SLOW_REQUEST_THRESHOLD_MS = "10";
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const app = new Hono();
    app.use("*", slowRequestLogger);
    let callCount = 0;
    app.get("/api/first", async (c) => {
      await new Promise((r) => setTimeout(r, 50));
      callCount++;
      return c.json({ n: callCount });
    });
    app.get("/api/second", async (c) => {
      await new Promise((r) => setTimeout(r, 50));
      callCount++;
      return c.json({ n: callCount });
    });

    await app.request("/api/first");
    await app.request("/api/second");

    const entries = getSlowRequests();
    expect(entries).toHaveLength(2);
    expect(entries[0].path).toBe("/api/second");
    expect(entries[1].path).toBe("/api/first");
  });
});

describe("slowRequestLogger loop-lag attribution (#405)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SLOW_REQUEST_THRESHOLD_MS;
    clearSlowRequests();
  });

  it("attributes the majority of the duration to lag when the loop is blocked synchronously", async () => {
    process.env.SLOW_REQUEST_THRESHOLD_MS = "10";
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const app = new Hono();
    app.use("*", slowRequestLogger);
    app.get("/api/blocking", (c) => {
      // Block the event loop synchronously — the handler "work" is trivial; ALL of the
      // wall time is starvation. This is the /api/health mis-blame scenario.
      const until = Date.now() + 400;
      while (Date.now() < until) { /* spin */ }
      return c.json({ ok: true });
    });

    await app.request("/api/blocking");

    const entries = getSlowRequests();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.durationMs).toBeGreaterThanOrEqual(400);
    // Acceptance: the entry attributes the majority (>90%) of the duration to lag.
    expect(entry.loopLagMaxMs).toBeDefined();
    expect(entry.loopLagMaxMs!).toBeGreaterThanOrEqual(0.9 * entry.durationMs);
    expect(entry.starved).toBe(true);

    expect(warnSpy).toHaveBeenCalledOnce();
    const message = warnSpy.mock.calls[0][0] as string;
    expect(message).toMatch(/^\[slow-request\] GET \/api\/blocking took \d+ms \(loop lag max [\d.]+ms p50 [\d.]+ms — starved, not handler\)$/);
  });

  it("does not blame lag for a genuinely slow async handler (injected sampler)", async () => {
    process.env.SLOW_REQUEST_THRESHOLD_MS = "10";
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Deterministic sampler: the loop was healthy while the handler awaited real work.
    const sampler: RequestLagSampler = { stop: () => ({ maxMs: 11, p50Ms: 10 }) };
    const app = new Hono();
    app.use("*", createSlowRequestLogger({ startSampler: () => sampler }));
    app.get("/api/slow-handler", async (c) => {
      await new Promise((r) => setTimeout(r, 60));
      return c.json({ ok: true });
    });

    await app.request("/api/slow-handler");

    const entries = getSlowRequests();
    expect(entries).toHaveLength(1);
    expect(entries[0].starved).toBe(false);
    expect(entries[0].loopLagMaxMs).toBe(11);
    expect(entries[0].loopLagP50Ms).toBe(10);

    expect(warnSpy).toHaveBeenCalledOnce();
    const message = warnSpy.mock.calls[0][0] as string;
    expect(message).toMatch(/^\[slow-request\] GET \/api\/slow-handler took \d+ms$/);
    expect(message).not.toContain("starved");
  });

  it("marks starvation deterministically when the sampler reports dominant lag (injected sampler)", async () => {
    process.env.SLOW_REQUEST_THRESHOLD_MS = "10";
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const sampler: RequestLagSampler = { stop: () => ({ maxMs: 9800, p50Ms: 9800 }) };
    const app = new Hono();
    app.use("*", createSlowRequestLogger({ startSampler: () => sampler }));
    app.get("/api/starved", async (c) => {
      await new Promise((r) => setTimeout(r, 60));
      return c.json({ ok: true });
    });

    await app.request("/api/starved");

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("(loop lag max 9800ms p50 9800ms — starved, not handler)");
    expect(getSlowRequests()[0].starved).toBe(true);
  });
});
