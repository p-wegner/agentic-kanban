import { describe, expect, it, vi } from "vitest";
import { createRoutes } from "../routes/index.js";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import type { BoardEvents } from "../services/board-events.js";

function createMockBoardEvents(): BoardEvents & { broadcasts: Array<{ projectId: string; reason: string }> } {
  const broadcasts: Array<{ projectId: string; reason: string }> = [];
  return {
    broadcasts,
    broadcast: vi.fn((projectId: string, reason: string) => {
      broadcasts.push({ projectId, reason });
    }),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  } as unknown as BoardEvents & { broadcasts: Array<{ projectId: string; reason: string }> };
}

function createTestAppWith(boardEvents?: BoardEvents) {
  return _createTestApp((app, db) => {
    app.route("/api", createRoutes(db, () => createMockSessionManager(), { boardEvents }));
  });
}

describe("POST /api/internal/board-notify", () => {
  it("returns ok:true with note when no boardEvents configured", async () => {
    const { app } = createTestAppWith(undefined);

    const res = await app.request("/api/internal/board-notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "some-project-id", reason: "test" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; note?: string };
    expect(body.ok).toBe(true);
    expect(body.note).toBe("no boardEvents");
  });

  it("broadcasts to the given projectId and returns ok:true", async () => {
    const boardEvents = createMockBoardEvents();
    const { app } = createTestAppWith(boardEvents);

    const res = await app.request("/api/internal/board-notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "proj-abc", reason: "issue_updated" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(boardEvents.broadcasts).toHaveLength(1);
    expect(boardEvents.broadcasts[0]).toEqual({ projectId: "proj-abc", reason: "issue_updated" });
  });

  it("defaults reason to internal_notify when reason is omitted", async () => {
    const boardEvents = createMockBoardEvents();
    const { app } = createTestAppWith(boardEvents);

    const res = await app.request("/api/internal/board-notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "proj-xyz" }),
    });

    expect(res.status).toBe(200);
    expect(boardEvents.broadcasts[0]).toEqual({ projectId: "proj-xyz", reason: "internal_notify" });
  });

  it("does not broadcast when projectId is absent", async () => {
    const boardEvents = createMockBoardEvents();
    const { app } = createTestAppWith(boardEvents);

    const res = await app.request("/api/internal/board-notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "board_changed" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(boardEvents.broadcasts).toHaveLength(0);
  });

  it("does not crash with an empty body", async () => {
    const boardEvents = createMockBoardEvents();
    const { app } = createTestAppWith(boardEvents);

    const res = await app.request("/api/internal/board-notify", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(boardEvents.broadcasts).toHaveLength(0);
  });

  it("does not crash when boardEvents has no connected WebSocket clients", async () => {
    const boardEvents = createMockBoardEvents();
    const { app } = createTestAppWith(boardEvents);

    const res = await app.request("/api/internal/board-notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "proj-no-ws-clients" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
