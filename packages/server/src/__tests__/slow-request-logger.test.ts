import { Hono } from "hono";
import { describe, expect, it, vi, afterEach } from "vitest";
import { slowRequestLogger } from "../middleware/slow-request-logger.js";

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

    // A fast handler should not trigger the default 200ms threshold
    const app = createTestApp(0);
    await app.request("/api/test");

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
