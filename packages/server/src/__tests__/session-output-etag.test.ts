import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createSessionsRoute } from "../routes/sessions.js";
import { createSessionReadService } from "../services/session-read.service.js";

const getOutput = vi.fn();

vi.mock("../services/session-read.service.js", () => ({
  createSessionReadService: vi.fn(() => ({ getOutput, getStats: vi.fn(), getSummary: vi.fn() })),
}));

function makeApp() {
  const app = new Hono();
  app.route("/api/sessions", createSessionsRoute({} as never));
  return app;
}

const MESSAGES_V1 = [
  { id: 1, type: "stdout", data: "hello", createdAt: "2024-01-01T00:00:00Z" },
];
const MESSAGES_V2 = [
  { id: 1, type: "stdout", data: "hello", createdAt: "2024-01-01T00:00:00Z" },
  { id: 2, type: "stdout", data: "world", createdAt: "2024-01-01T00:00:01Z" },
];

describe("GET /api/sessions/:id/output ETag / conditional-GET", () => {
  it("returns 200 with ETag, then 304 on matching If-None-Match", async () => {
    getOutput.mockResolvedValue(MESSAGES_V1);
    const app = makeApp();

    const res1 = await app.request("/api/sessions/sess-1/output");
    expect(res1.status).toBe(200);
    const etag1 = res1.headers.get("ETag");
    expect(etag1).toBeTruthy();
    const body1 = await res1.json();
    expect(Array.isArray(body1)).toBe(true);
    expect(body1).toHaveLength(1);

    const res2 = await app.request("/api/sessions/sess-1/output", {
      headers: { "If-None-Match": etag1! },
    });
    expect(res2.status).toBe(304);
    expect(await res2.text()).toBe("");
    expect(res2.headers.get("ETag")).toBe(etag1);
  });

  it("returns 200 with new ETag when output changes (invalidation)", async () => {
    const app = makeApp();

    getOutput.mockResolvedValue(MESSAGES_V1);
    const res1 = await app.request("/api/sessions/sess-2/output");
    expect(res1.status).toBe(200);
    const etag1 = res1.headers.get("ETag");
    expect(etag1).toBeTruthy();

    getOutput.mockResolvedValue(MESSAGES_V2);

    const res2 = await app.request("/api/sessions/sess-2/output", {
      headers: { "If-None-Match": etag1! },
    });
    expect(res2.status).toBe(200);
    const etag2 = res2.headers.get("ETag");
    expect(etag2).toBeTruthy();
    expect(etag2).not.toBe(etag1);
    const body2 = await res2.json();
    expect(Array.isArray(body2)).toBe(true);
    expect(body2).toHaveLength(2);
  });

  it("response body is a bare array (not wrapped)", async () => {
    getOutput.mockResolvedValue(MESSAGES_V1);
    const app = makeApp();

    const res = await app.request("/api/sessions/sess-3/output");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toHaveProperty("id");
  });
});
