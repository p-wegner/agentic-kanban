import { test, expect } from "@playwright/test";
import { SERVER_URL, SERVER_PORT } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

// POST /api/internal/board-notify — packages/server/src/routes/index.ts (~101).
// Internal endpoint MCP/CLI tools hit to trigger an immediate board refresh.
//   body: { projectId?: string; reason?: string } (parsed via parseOptionalJsonBody, so body is optional)
//   - if boardEvents not configured (never the case on the real server): { ok: true, note: "no boardEvents" }
//   - if body.projectId present: boardEvents.broadcast(projectId, reason ?? "internal_notify"); returns { ok: true }
//   - if body.projectId absent: NO broadcast; still returns { ok: true }
// Side effect is observable: a connected /ws/board/:projectId client receives a board_changed event
// with type=board_changed, projectId, and reason equal to whatever we posted.

const WS_OPEN_TIMEOUT_MS = 5_000;
const WS_EVENT_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms waiting for ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// Open a /ws/board/:projectId socket and resolve with the first board_changed message
// whose reason matches `reason`. Mirrors board-events.test.ts.
async function listenForBoardNotify(
  projectId: string,
  reason: string,
): Promise<{ messagePromise: Promise<any>; close: () => void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/ws/board/${projectId}`);

  await withTimeout(
    new Promise<void>((resolveOpen, rejectOpen) => {
      ws.addEventListener("open", () => resolveOpen());
      ws.addEventListener("error", () =>
        rejectOpen(new Error("WebSocket error before /ws/board open")),
      );
    }),
    WS_OPEN_TIMEOUT_MS,
    "WebSocket OPEN on /ws/board",
  );

  let settled = false;
  const messagePromise = new Promise<any>((resolveMessage, rejectMessage) => {
    ws.addEventListener("message", (event) => {
      let data: { type?: string; reason?: string };
      try {
        data = JSON.parse(String(event.data));
      } catch {
        settled = true;
        rejectMessage(new Error("Received non-JSON board WebSocket message"));
        return;
      }
      if (data.type === "board_changed" && data.reason === reason) {
        settled = true;
        resolveMessage(data);
      }
    });
    ws.addEventListener("close", () => {
      if (!settled) {
        settled = true;
        rejectMessage(new Error(`WS closed before board_changed reason "${reason}"`));
      }
    });
  });

  return {
    messagePromise: withTimeout(
      messagePromise,
      WS_EVENT_TIMEOUT_MS,
      `board_changed event with reason "${reason}"`,
    ),
    close: () => ws.close(),
  };
}

test.describe("POST /api/internal/board-notify", () => {
  let projectId: string;

  async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    throw new Error(`[${label}] failed after 3 attempts: ${String(lastErr)}`);
  }

  test.beforeAll(async ({ request }) => {
    projectId = await withRetry(() => getE2EProjectId(request), "getE2EProjectId");
  });

  test("a valid notify returns { ok: true } and broadcasts to /ws/board subscribers", async ({
    request,
  }) => {
    const reason = `notify_test_${Date.now().toString(36)}`;
    const listener = await listenForBoardNotify(projectId, reason);

    let received: any;
    try {
      const res = await request.post(`${SERVER_URL}/api/internal/board-notify`, {
        data: { projectId, reason },
      });
      expect(res.status()).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      received = await listener.messagePromise;
    } finally {
      listener.close();
    }

    expect(received.type).toBe("board_changed");
    expect(received.projectId).toBe(projectId);
    expect(received.reason).toBe(reason);
  });

  test("notify without a projectId is a no-op that still returns { ok: true }", async ({
    request,
  }) => {
    // Handler only broadcasts when body.projectId is present; otherwise it's a documented no-op.
    const res = await request.post(`${SERVER_URL}/api/internal/board-notify`, {
      data: { reason: "no_project" },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("notify with an empty body does not crash and returns { ok: true }", async ({
    request,
  }) => {
    // parseOptionalJsonBody tolerates an absent/empty body.
    const res = await request.post(`${SERVER_URL}/api/internal/board-notify`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
