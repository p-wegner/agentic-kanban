import { Hono } from "hono";
import { describe, expect, it, vi, afterEach } from "vitest";
import { slowRequestLogger, getSlowRequests, clearSlowRequests } from "../middleware/slow-request-logger.js";

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
    expect(warnSpy.mock.calls[0][0]).toMatch(/^\[slow-request\] GET \/api\/test took \d+ms$/);
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
