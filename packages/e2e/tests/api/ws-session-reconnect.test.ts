import { test, expect } from "@playwright/test";
import { SERVER_URL, SERVER_PORT } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// /ws/sessions/:sessionId — session-manager ws-handler (ws-handler.ts wsRoute()).
//
// REAL behavior found in source (ws-handler.ts):
//   - onOpen:  subscribe(sessionId, ws) — adds the socket to that session's subscriber map
//              AND REPLAYS the buffered messages (state.messageBuffer) so a late/reconnecting
//              client never misses output. Each buffered AgentOutputMessage is sent as JSON.
//   - onClose: unsubscribe(sessionId, ws) — removes the socket; drops the buffer iff the last
//              buffered message was an `exit`.
//   - There is NO handshake frame and NO validation of sessionId. An UNKNOWN session id is NOT
//     rejected: the socket opens normally, the (empty) buffer replays nothing, and the connection
//     stays OPEN with zero messages. The server sends no error frame and does not close it.
//
// Wire format of replayed/live messages = AgentOutputMessage: { type: "stdout"|"stderr"|"exit",
// sessionId, data?, exitCode? } (broadcast.ts / session messages).
//
// So the two sub-cases are:
//   1. VALID session: connect, expect to receive at least one AgentOutputMessage for that sessionId.
//   2. BOGUS session id: connect, expect it to OPEN and stay open with no message/close (lenient).
//      NOTE: this asserts the documented lenient behavior — there is no "error/close on unknown id"
//      path to assert, so we verify the socket opens and emits nothing within a short window.

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = resolve(__dirname, "../../../server/src/scripts/mock-agent.ts");
const TSX_LOADER = resolve(__dirname, "../../../server/node_modules/tsx/dist/loader.mjs");
const TSX_URL = pathToFileURL(TSX_LOADER).href;
const MOCK_AGENT_COMMAND = `node --import ${TSX_URL} "${MOCK_AGENT_PATH}"`;

const WS_OPEN_TIMEOUT_MS = 5_000;
const WS_MESSAGE_TIMEOUT_MS = 8_000;
const WS_QUIET_WINDOW_MS = 1_500;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms waiting for ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function sessionWsUrl(sessionId: string): string {
  // RULE: derive ws URL from the configured host/port, never hardcode.
  return `ws://127.0.0.1:${SERVER_PORT}/ws/sessions/${sessionId}`;
}

test.describe("/ws/sessions/:sessionId reconnect + unknown-id behavior", () => {
  let projectId: string;
  let statusId: string;
  let suffix: string;
  const createdIssueIds: string[] = [];
  const createdWorkspaceIds: string[] = [];

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
    const statuses = await withRetry(async () => {
      const res = await request.get(`${SERVER_URL}/api/projects/${projectId}/statuses`);
      if (!res.ok()) throw new Error(`statuses ${res.status()}`);
      return res.json();
    }, "fetch statuses");
    const todo = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todo ? todo.id : statuses[0].id;
    suffix = Date.now().toString(36);
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdWorkspaceIds) {
      await request.delete(`${SERVER_URL}/api/workspaces/${id}`);
    }
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  // Create an issue + non-review workspace + launch the mock agent. Returns the live sessionId.
  async function launchMockSession(label: string, request: any): Promise<string> {
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `WS reconnect ${label} ${suffix}`, statusId, projectId, skipAutoReview: true },
    });
    expect(issueRes.status()).toBe(201);
    const issueId = (await issueRes.json()).id;
    createdIssueIds.push(issueId);

    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId, branch: `feature/ws-reconnect-${label}-${suffix}`, requiresReview: false },
    });
    expect(wsRes.status()).toBe(201);
    const workspaceId = (await wsRes.json()).id;
    createdWorkspaceIds.push(workspaceId);

    // Setup the worktree (retry on transient failure — never test.skip()).
    await withRetry(async () => {
      const setupRes = await request.post(
        `${SERVER_URL}/api/workspaces/${workspaceId}/setup`,
        { data: {} },
      );
      if (setupRes.status() !== 200) throw new Error(`setup ${setupRes.status()}`);
    }, `workspace setup ${label}`);

    const launchRes = await withRetry(async () => {
      const res = await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/launch`, {
        data: {
          prompt: "produce ws-replayable output",
          agentCommand: `${MOCK_AGENT_COMMAND} --delay-ms 50`,
          multiTurn: false,
        },
      });
      if (res.status() !== 201) throw new Error(`launch ${res.status()}`);
      return res;
    }, `workspace launch ${label}`);
    const { sessionId } = await launchRes.json();
    if (!sessionId) throw new Error("launch did not return a sessionId");
    return sessionId;
  }

  test("connecting to a valid session's ws receives AgentOutputMessage frames (reconnect/replay)", async ({
    request,
  }) => {
    // Worktree creation + per-worktree install + mock-agent launch can exceed the 30s default.
    test.setTimeout(120_000);
    const sessionId = await launchMockSession("valid", request);

    const ws = new WebSocket(sessionWsUrl(sessionId));
    try {
      await withTimeout(
        new Promise<void>((resolveOpen, rejectOpen) => {
          ws.addEventListener("open", () => resolveOpen());
          ws.addEventListener("error", () =>
            rejectOpen(new Error("ws error before open on valid session")),
          );
        }),
        WS_OPEN_TIMEOUT_MS,
        "ws OPEN on valid session",
      );

      // The buffer replays on subscribe and the live mock agent keeps emitting — assert we get
      // at least one well-formed AgentOutputMessage scoped to this sessionId.
      const firstMessage = await withTimeout(
        new Promise<any>((resolveMessage, rejectMessage) => {
          ws.addEventListener("message", (event) => {
            try {
              resolveMessage(JSON.parse(String(event.data)));
            } catch (err) {
              rejectMessage(new Error(`non-JSON ws frame: ${String(err)}`));
            }
          });
          ws.addEventListener("close", () =>
            rejectMessage(new Error("ws closed before any message on valid session")),
          );
        }),
        WS_MESSAGE_TIMEOUT_MS,
        "first AgentOutputMessage on valid session",
      );

      expect(firstMessage).toHaveProperty("type");
      expect(["stdout", "stderr", "exit"]).toContain(firstMessage.type);
      expect(firstMessage.sessionId).toBe(sessionId);
    } finally {
      ws.close();
    }

    // Stop the agent so it doesn't keep running after the test.
    const wsId = createdWorkspaceIds[createdWorkspaceIds.length - 1];
    await request.post(`${SERVER_URL}/api/workspaces/${wsId}/stop`, { data: {} });
  });

  test("connecting with a bogus session id opens and stays quiet (no error/close) — documented lenient behavior", async () => {
    // NOTE: ws-handler does NOT validate the session id. An unknown id is accepted: the socket
    // opens, the empty buffer replays nothing, and the server emits no error/close frame. We assert
    // that documented lenient contract: OPEN succeeds and no message arrives within a quiet window,
    // and the socket is NOT server-closed during that window.
    const bogusId = `bogus-session-${suffix}`;
    const ws = new WebSocket(sessionWsUrl(bogusId));

    let sawMessage = false;
    let serverClosed = false;
    ws.addEventListener("message", () => {
      sawMessage = true;
    });
    ws.addEventListener("close", () => {
      serverClosed = true;
    });

    try {
      await withTimeout(
        new Promise<void>((resolveOpen, rejectOpen) => {
          ws.addEventListener("open", () => resolveOpen());
          ws.addEventListener("error", () =>
            rejectOpen(new Error("ws error before open on bogus session")),
          );
        }),
        WS_OPEN_TIMEOUT_MS,
        "ws OPEN on bogus session",
      );

      // Wait a quiet window; the lenient handler must neither push a message nor close.
      await new Promise((r) => setTimeout(r, WS_QUIET_WINDOW_MS));
      expect(sawMessage).toBe(false);
      expect(serverClosed).toBe(false);
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      ws.close();
    }
  });
});
