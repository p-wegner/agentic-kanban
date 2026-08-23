import { Hono } from "hono";
import { describe, expect, it, vi, beforeEach } from "vitest";

// The /output route computes its ETag from cheap metadata (file size+mtime +
// max message id) BEFORE any transcript read: a matching If-None-Match must
// return 304 without getSessionOutput ever being called (zero file reads,
// zero message-row reads).
const getSessionOutput = vi.fn();
const getSessionOutputMeta = vi.fn();

vi.mock("../repositories/session/messages.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/session/messages.js")>();
  return {
    ...actual,
    getSessionOutput: (...args: unknown[]) => getSessionOutput(...args),
    getSessionOutputMeta: (...args: unknown[]) => getSessionOutputMeta(...args),
  };
});

const { createSessionsRoute } = await import("../routes/sessions.js");

function makeApp() {
  const app = new Hono();
  app.route("/api/sessions", createSessionsRoute({} as never));
  return app;
}

const META_V1 = { fileSize: 100, fileMtimeMs: 1700000000000, maxMessageId: 5 };
const META_V2 = { fileSize: 220, fileMtimeMs: 1700000005000, maxMessageId: 7 };

const MESSAGES_V1 = [{ type: "stdout", sessionId: "s", data: "hello" }];
const MESSAGES_V2 = [
  { type: "stdout", sessionId: "s", data: "hello" },
  { type: "stdout", sessionId: "s", data: "world" },
];

describe("GET /api/sessions/:id/output ETag / conditional-GET", () => {
  beforeEach(() => {
    getSessionOutput.mockReset();
    getSessionOutputMeta.mockReset();
  });

  it("returns 200 with ETag, then 304 on matching If-None-Match WITHOUT reading output", async () => {
    getSessionOutputMeta.mockResolvedValue(META_V1);
    getSessionOutput.mockResolvedValue({ messages: MESSAGES_V1 });
    const app = makeApp();

    const res1 = await app.request("/api/sessions/sess-1/output");
    expect(res1.status).toBe(200);
    const etag1 = res1.headers.get("ETag");
    expect(etag1).toBeTruthy();
    const body1 = await res1.json();
    expect(Array.isArray(body1)).toBe(true);
    expect(body1).toHaveLength(1);
    expect(getSessionOutput).toHaveBeenCalledTimes(1);

    const res2 = await app.request("/api/sessions/sess-1/output", {
      headers: { "If-None-Match": etag1! },
    });
    expect(res2.status).toBe(304);
    expect(await res2.text()).toBe("");
    expect(res2.headers.get("ETag")).toBe(etag1);
    // The 304 short-circuit must be metadata-only: no transcript read at all.
    expect(getSessionOutput).toHaveBeenCalledTimes(1);
  });

  it("returns 200 with new ETag when the output metadata changes (invalidation)", async () => {
    const app = makeApp();

    getSessionOutputMeta.mockResolvedValue(META_V1);
    getSessionOutput.mockResolvedValue({ messages: MESSAGES_V1 });
    const res1 = await app.request("/api/sessions/sess-2/output");
    expect(res1.status).toBe(200);
    const etag1 = res1.headers.get("ETag");
    expect(etag1).toBeTruthy();

    getSessionOutputMeta.mockResolvedValue(META_V2);
    getSessionOutput.mockResolvedValue({ messages: MESSAGES_V2 });

    const res2 = await app.request("/api/sessions/sess-2/output", {
      headers: { "If-None-Match": etag1! },
    });
    expect(res2.status).toBe(200);
    const etag2 = res2.headers.get("ETag");
    expect(etag2).toBeTruthy();
    expect(etag2).not.toBe(etag1);
    const body2 = await res2.json();
    expect(body2).toHaveLength(2);
  });

  it("passes ?tail= through as a bounded read and keys the ETag by tail size", async () => {
    getSessionOutputMeta.mockResolvedValue(META_V1);
    getSessionOutput.mockResolvedValue({ messages: MESSAGES_V1 });
    const app = makeApp();

    const resFull = await app.request("/api/sessions/sess-3/output");
    const resTail = await app.request("/api/sessions/sess-3/output?tail=1024");
    expect(resTail.status).toBe(200);

    // tail request reaches the repository as a bounded read
    const tailCall = getSessionOutput.mock.calls.at(-1);
    expect(tailCall?.[2]).toEqual({ tailBytes: 1024 });
    // full request has no bound
    expect(getSessionOutput.mock.calls[0][2]).toEqual({ tailBytes: undefined });

    // Same metadata, different representation → different ETag (a cached full
    // response must never 304-satisfy a tail request or vice versa).
    expect(resTail.headers.get("ETag")).not.toBe(resFull.headers.get("ETag"));
  });

  it("ignores an invalid tail param", async () => {
    getSessionOutputMeta.mockResolvedValue(META_V1);
    getSessionOutput.mockResolvedValue({ messages: MESSAGES_V1 });
    const app = makeApp();

    const res = await app.request("/api/sessions/sess-4/output?tail=bogus");
    expect(res.status).toBe(200);
    expect(getSessionOutput.mock.calls[0][2]).toEqual({ tailBytes: undefined });
  });

  it("returns 404 for a missing session without reading output", async () => {
    getSessionOutputMeta.mockResolvedValue(null);
    const app = makeApp();

    const res = await app.request("/api/sessions/nope/output");
    expect(res.status).toBe(404);
    expect(getSessionOutput).not.toHaveBeenCalled();
  });

  it("response body is a bare array (not wrapped)", async () => {
    getSessionOutputMeta.mockResolvedValue(META_V1);
    getSessionOutput.mockResolvedValue({ messages: MESSAGES_V1 });
    const app = makeApp();

    const res = await app.request("/api/sessions/sess-5/output");
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toHaveProperty("type");
  });
});
