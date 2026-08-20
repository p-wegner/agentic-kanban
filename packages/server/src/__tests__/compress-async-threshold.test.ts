/**
 * #400: large JSON responses must be gzipped via the ASYNC `zlib.gzip`
 * (threadpool), never `gzipSync` on the main thread; small-but-compressible
 * responses stay on the cheap sync path.
 *
 * node:zlib is mocked with pass-through spies so the middleware's real
 * behaviour (compression, headers, round-trip) is exercised while the sync vs
 * async dispatch is observable.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { gunzipSync } from "node:zlib";

const spies = vi.hoisted(() => ({
  gzipSync: vi.fn<(...args: unknown[]) => unknown>(),
  gzip: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  spies.gzipSync.mockImplementation((...args) =>
    (actual.gzipSync as (...a: unknown[]) => unknown)(...args),
  );
  spies.gzip.mockImplementation((...args) =>
    (actual.gzip as unknown as (...a: unknown[]) => unknown)(...args),
  );
  return { ...actual, gzipSync: spies.gzipSync, gzip: spies.gzip };
});

import {
  ASYNC_COMPRESS_MIN_BYTES,
  COMPRESS_MIN_BYTES,
  gzipBody,
  jsonGzip,
} from "../middleware/compress.js";

const GZIP_HEADER = { "accept-encoding": "gzip, deflate, br" };

// ~200KB serialized — comfortably above the async threshold, like the board payload.
const largePayload = {
  items: Array.from({ length: 2000 }, (_, i) => ({ id: i, text: `row-${i}-` + "x".repeat(90) })),
};
const largeBody = JSON.stringify(largePayload);

// Between the compression floor and the async threshold (~8KB).
const mediumPayload = { items: Array.from({ length: 150 }, (_, i) => ({ id: i, text: "y".repeat(40) })) };
const mediumBody = JSON.stringify(mediumPayload);

function buildApp() {
  const app = new Hono();
  app.use("/api/*", jsonGzip);
  app.get("/api/large", (c) => c.json(largePayload));
  app.get("/api/medium", (c) => c.json(mediumPayload));
  return app;
}

beforeEach(() => {
  spies.gzipSync.mockClear();
  spies.gzip.mockClear();
});

describe("async gzip threshold (#400)", () => {
  it("sanity: fixtures straddle the thresholds", () => {
    expect(Buffer.byteLength(largeBody)).toBeGreaterThanOrEqual(ASYNC_COMPRESS_MIN_BYTES);
    expect(Buffer.byteLength(mediumBody)).toBeGreaterThanOrEqual(COMPRESS_MIN_BYTES);
    expect(Buffer.byteLength(mediumBody)).toBeLessThan(ASYNC_COMPRESS_MIN_BYTES);
  });

  it("compresses a >=64KB payload via async zlib.gzip, never gzipSync", async () => {
    const app = buildApp();
    const res = await app.request("/api/large", { headers: GZIP_HEADER });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const decompressed = gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8");
    expect(decompressed).toBe(largeBody);

    expect(spies.gzip).toHaveBeenCalledTimes(1);
    expect(spies.gzipSync).not.toHaveBeenCalled();
  });

  it("compresses a small-but-compressible payload via gzipSync (no threadpool round-trip)", async () => {
    const app = buildApp();
    const res = await app.request("/api/medium", { headers: GZIP_HEADER });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const decompressed = gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8");
    expect(decompressed).toBe(mediumBody);

    expect(spies.gzipSync).toHaveBeenCalledTimes(1);
    expect(spies.gzip).not.toHaveBeenCalled();
  });

  it("gzipSync is never handed a buffer at or above the async threshold on the request path", async () => {
    const app = buildApp();
    await app.request("/api/large", { headers: GZIP_HEADER });
    await app.request("/api/medium", { headers: GZIP_HEADER });

    for (const call of spies.gzipSync.mock.calls) {
      const buf = call[0] as Buffer;
      expect(buf.byteLength).toBeLessThan(ASYNC_COMPRESS_MIN_BYTES);
    }
  });

  it("gzipBody dispatches by threshold: Buffer below, Promise at/above", async () => {
    const below = gzipBody(Buffer.alloc(ASYNC_COMPRESS_MIN_BYTES - 1));
    expect(Buffer.isBuffer(below)).toBe(true);

    const at = gzipBody(Buffer.alloc(ASYNC_COMPRESS_MIN_BYTES));
    expect(at).toBeInstanceOf(Promise);
    expect(Buffer.isBuffer(await at)).toBe(true);
  });
});
