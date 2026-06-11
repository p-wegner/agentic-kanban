import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { gunzipSync } from "node:zlib";
import { COMPRESS_MIN_BYTES, jsonGzip } from "../middleware/compress.js";

const GZIP_HEADER = { "accept-encoding": "gzip, deflate, br" };

// Comfortably above the compression threshold (~30KB serialized).
const bigPayload = {
  items: Array.from({ length: 500 }, (_, i) => ({ id: i, text: "x".repeat(40) })),
};
const bigBody = JSON.stringify(bigPayload);
const ETAG = '"abc123def4567890"';

function buildApp() {
  const app = new Hono();
  app.use("/api/*", jsonGzip);

  app.get("/api/big", (c) => c.json(bigPayload));
  app.get("/api/small", (c) => c.json({ ok: true }));
  app.post("/api/big-post", (c) => c.json(bigPayload));

  // Mirrors the board route's conditional-GET shape (routes/projects.ts):
  // ETag computed from the uncompressed body, 304 with a null body on match.
  app.get("/api/etagged", (c) => {
    if (c.req.header("if-none-match") === ETAG) {
      return new Response(null, { status: 304, headers: { ETag: ETAG } });
    }
    return new Response(bigBody, {
      headers: { "Content-Type": "application/json", ETag: ETAG },
    });
  });

  return app;
}

describe("jsonGzip middleware", () => {
  it("sanity: the large fixture is above the compression threshold", () => {
    expect(Buffer.byteLength(bigBody)).toBeGreaterThan(COMPRESS_MIN_BYTES);
  });

  it("compresses a large JSON response and decompresses to the identical body", async () => {
    const app = buildApp();
    const res = await app.request("/api/big", { headers: GZIP_HEADER });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")).toBe("Accept-Encoding");

    const compressed = Buffer.from(await res.arrayBuffer());
    // Content-Length must describe the COMPRESSED body.
    expect(res.headers.get("content-length")).toBe(String(compressed.byteLength));
    expect(compressed.byteLength).toBeLessThan(Buffer.byteLength(bigBody));

    const decompressed = gunzipSync(compressed).toString("utf8");
    expect(decompressed).toBe(bigBody);
  });

  it("does NOT compress a small JSON response (body stays intact)", async () => {
    const app = buildApp();
    const res = await app.request("/api/small", { headers: GZIP_HEADER });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    // The middleware buffers to measure size — the restored body must parse.
    expect(await res.json()).toEqual({ ok: true });
  });

  it("does NOT compress when the client did not send Accept-Encoding: gzip", async () => {
    const app = buildApp();
    const res = await app.request("/api/big");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.json()).toEqual(bigPayload);
  });

  it("does NOT compress when gzip is refused via q=0", async () => {
    const app = buildApp();
    const res = await app.request("/api/big", {
      headers: { "accept-encoding": "gzip;q=0, identity" },
    });

    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.json()).toEqual(bigPayload);
  });

  it("does NOT compress non-GET responses", async () => {
    const app = buildApp();
    const res = await app.request("/api/big-post", { method: "POST", headers: GZIP_HEADER });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.json()).toEqual(bigPayload);
  });

  it("leaves an event-stream response uncompressed and still streaming incrementally", async () => {
    const app = new Hono();
    app.use("/api/*", jsonGzip);

    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    app.get("/api/sse", (c) =>
      streamSSE(c, async (stream) => {
        await stream.writeSSE({ data: "first" });
        await secondGate;
        await stream.writeSSE({ data: "second" });
      }),
    );

    const res = await app.request("/api/sse", { headers: GZIP_HEADER });
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");

    // The first chunk must arrive while the producer is still blocked on the
    // gate — if the middleware had buffered the stream, this read would hang
    // (and the test would time out).
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(decoder.decode(first.value)).toContain("first");

    releaseSecond();
    let rest = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rest += decoder.decode(chunk.value);
      if (rest.includes("second")) break;
    }
    expect(rest).toContain("second");
    await reader.cancel();
  });

  it("leaves a 304 If-None-Match response untouched and keeps the ETag byte-identical", async () => {
    const app = buildApp();

    // Compressed 200 keeps the ETag computed from the UNCOMPRESSED body.
    const gzipRes = await app.request("/api/etagged", { headers: GZIP_HEADER });
    expect(gzipRes.status).toBe(200);
    expect(gzipRes.headers.get("content-encoding")).toBe("gzip");
    expect(gzipRes.headers.get("etag")).toBe(ETAG);
    expect(gunzipSync(Buffer.from(await gzipRes.arrayBuffer())).toString("utf8")).toBe(bigBody);

    // Identity 200 carries the same opaque ETag.
    const plainRes = await app.request("/api/etagged");
    expect(plainRes.headers.get("etag")).toBe(ETAG);

    // Conditional GET with the ETag obtained from a compressed response
    // still produces a bodyless, uncompressed 304.
    const notModified = await app.request("/api/etagged", {
      headers: { ...GZIP_HEADER, "if-none-match": gzipRes.headers.get("etag")! },
    });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("content-encoding")).toBeNull();
    expect(notModified.headers.get("etag")).toBe(ETAG);
    expect(notModified.body).toBeNull();
  });

  it("appends Accept-Encoding to an existing Vary header without duplicating", async () => {
    const app = new Hono();
    app.use("/api/*", jsonGzip);
    app.get("/api/varied", () => {
      return new Response(bigBody, {
        headers: { "Content-Type": "application/json", Vary: "Origin" },
      });
    });
    app.get("/api/varied-already", () => {
      return new Response(bigBody, {
        headers: { "Content-Type": "application/json", Vary: "Accept-Encoding" },
      });
    });

    const res = await app.request("/api/varied", { headers: GZIP_HEADER });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")).toBe("Origin, Accept-Encoding");

    const res2 = await app.request("/api/varied-already", { headers: GZIP_HEADER });
    expect(res2.headers.get("vary")).toBe("Accept-Encoding");
  });
});
