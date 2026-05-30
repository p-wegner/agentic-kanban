import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The Session Replay viewer (packages/client/src/components/SessionReplay.tsx) drives
// itself entirely from `GET /api/sessions/:id/output`. It fetches that endpoint, expects
// a BARE ARRAY of AgentOutputMessage, and feeds it through parseMessagesIntoTurns() to
// build the navigable turn list. These tests pin down that server-side contract so the
// replay viewer keeps working:
//   1. /output returns a bare array (not `{ messages: [...] }`) — regression guard for the
//      shape mismatch that left the replay modal blank.
//   2. The array contains the stream-json stdout the parser needs (init + tool_use + result)
//      so a real session yields at least one replayable turn.
//   3. Edge cases: unknown session → 404; a session with no output → empty array, not a crash.

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = resolve(__dirname, "../../../server/src/scripts/mock-agent.ts");
const TSX_LOADER = resolve(__dirname, "../../../server/node_modules/tsx/dist/loader.mjs");
const TSX_URL = pathToFileURL(TSX_LOADER).href;
const MOCK_AGENT_COMMAND = `node --import ${TSX_URL} "${MOCK_AGENT_PATH}"`;

test.describe("Session Replay data contract", () => {
  let projectId: string;
  let statusId: string;
  const extraIssueIds: string[] = [];
  const extraWorkspaceIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const projects = await (await request.get(`${SERVER_URL}/api/projects`)).json();
    projectId = projects[0].id;
    const statuses = await (
      await request.get(`${SERVER_URL}/api/projects/${projectId}/statuses`)
    ).json();
    const todo = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todo ? todo.id : statuses[0].id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of extraWorkspaceIds) {
      await request.delete(`${SERVER_URL}/api/workspaces/${id}`);
    }
    for (const id of extraIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  async function createWorkspace(suffix: string, request: any) {
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `Session replay test ${suffix}`, statusId, projectId, skipAutoReview: true },
    });
    const issueId = (await issueRes.json()).id;
    extraIssueIds.push(issueId);

    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId, branch: `feature/session-replay-${suffix}`, requiresReview: false },
    });
    expect(wsRes.status()).toBe(201);
    const workspaceId = (await wsRes.json()).id;
    extraWorkspaceIds.push(workspaceId);

    let setupOk = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const setupRes = await request.post(
        `${SERVER_URL}/api/workspaces/${workspaceId}/setup`,
        { data: {} },
      );
      if (setupRes.status() === 200) {
        setupOk = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!setupOk) test.skip(true, "workspace setup failed after retries");
    return { issueId, workspaceId };
  }

  async function waitForExit(request: any, sessionId: string, timeoutMs = 10000) {
    const start = Date.now();
    let messages: any[] = [];
    while (Date.now() - start < timeoutMs) {
      const res = await request.get(`${SERVER_URL}/api/sessions/${sessionId}/output`);
      if (res.status() === 200) {
        messages = await res.json();
        if (Array.isArray(messages) && messages.some((m) => m.type === "exit")) return messages;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return messages;
  }

  test("GET /output returns a bare array (not a wrapped object) after a mock run", async ({
    request,
  }) => {
    const { workspaceId } = await createWorkspace(`shape-${Date.now().toString(36)}`, request);

    const launchRes = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/launch`,
      {
        data: {
          prompt: "produce replayable output",
          agentCommand: `${MOCK_AGENT_COMMAND} --delay-ms 50`,
          multiTurn: false,
        },
      },
    );
    expect(launchRes.status()).toBe(201);
    const { sessionId } = await launchRes.json();

    const messages = await waitForExit(request, sessionId);

    // Contract: the replay viewer does `apiFetch<AgentOutputMessage[]>(...)` and iterates
    // the result directly. A `{ messages: [...] }` wrapper here would make it iterate
    // `undefined` and render nothing. Pin the bare-array shape.
    expect(Array.isArray(messages)).toBe(true);
    expect(messages).not.toHaveProperty("messages");
    expect(messages.length).toBeGreaterThan(0);
    for (const msg of messages) {
      expect(msg).toHaveProperty("type");
      expect(msg).toHaveProperty("sessionId");
      expect(["stdout", "stderr", "exit"]).toContain(msg.type);
    }

    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/stop`, { data: {} });
  });

  test("output carries the stream-json events the replay parser needs for a turn", async ({
    request,
  }) => {
    const { workspaceId } = await createWorkspace(`turns-${Date.now().toString(36)}`, request);

    const launchRes = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/launch`,
      {
        data: {
          prompt: "produce a tool-using turn",
          agentCommand: `${MOCK_AGENT_COMMAND} --delay-ms 50`,
          multiTurn: false,
        },
      },
    );
    expect(launchRes.status()).toBe(201);
    const { sessionId } = await launchRes.json();

    const messages = await waitForExit(request, sessionId);
    expect(Array.isArray(messages)).toBe(true);

    // Reconstruct the JSON events exactly as parseMessagesIntoTurns would (stdout lines only).
    const events = messages
      .filter((m: any) => m.type === "stdout" && m.data)
      .flatMap((m: any) =>
        m.data
          .split("\n")
          .filter((l: string) => l.trim())
          .map((l: string) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          })
          .filter(Boolean),
      );

    // A replayable turn needs: a session init, at least one tool_use (so the two-pane
    // viewer has something to inspect), and a terminal result event (cost/token stats).
    const hasInit = events.some((e: any) => e.type === "system" && e.subtype === "init");
    const hasToolUse = events.some(
      (e: any) =>
        e.type === "assistant" &&
        e.message?.content?.some((c: any) => c.type === "tool_use"),
    );
    const hasResult = events.some((e: any) => e.type === "result");

    expect(hasInit).toBe(true);
    expect(hasToolUse).toBe(true);
    expect(hasResult).toBe(true);

    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/stop`, { data: {} });
  });

  test("GET /output returns 404 for an unknown session", async ({ request }) => {
    const res = await request.get(`${SERVER_URL}/api/sessions/does-not-exist/output`);
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Session not found");
  });

  test("a session with no persisted output yields an empty array, not an error (missing-data edge)", async ({
    request,
  }) => {
    const { workspaceId } = await createWorkspace(`empty-${Date.now().toString(36)}`, request);

    // The one-step workspace flow auto-launches an agent, so a session exists immediately.
    // Stop it right away so it never gets a chance to persist stdout — this reproduces the
    // "interrupted session / missing data" edge from the ticket. The replay viewer fetches
    // /output for such a session and must receive a bare (possibly empty) array, never a
    // crash, so parseMessagesIntoTurns() yields [] and the viewer shows "No turns found".
    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/stop`, { data: {} });

    const sessionsRes = await request.get(
      `${SERVER_URL}/api/workspaces/${workspaceId}/sessions`,
    );
    expect(sessionsRes.ok()).toBeTruthy();
    const sessions = await sessionsRes.json();
    expect(Array.isArray(sessions)).toBe(true);

    // For every session on the workspace, /output must be a bare array (never wrapped,
    // never an error for an existing session) — even when there is little or no output.
    for (const session of sessions) {
      const outputRes = await request.get(`${SERVER_URL}/api/sessions/${session.id}/output`);
      expect(outputRes.status()).toBe(200);
      const messages = await outputRes.json();
      expect(Array.isArray(messages)).toBe(true);
      expect(messages).not.toHaveProperty("messages");
    }
  });
});
