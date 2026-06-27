import { test, expect } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

// @covers agent-sessions.read.rest [api, boundary]
//
// The session READ endpoints expose a finished agent run over REST. ETag/304 on
// /output and LIKE transcript /search are already covered elsewhere; the still-
// unasserted HTTP contracts are:
//   1. GET /api/sessions/:id/stats  — structured stats JSON OBJECT (only the pure
//      repository parser is tested; the endpoint shape was never observed).
//   2. GET /api/sessions/:id/summary — the server-parsed SessionSummary body shape
//      (keys/types), again only the pure parser was tested.
//   3. The DOCUMENTED SEARCH BOUNDARY: search is LIKE over `session_messages`, but a
//      detached agent's stdout is persisted to the on-disk `.out` file and NOT to
//      `session_messages`. So a token that appears ONLY in stdout is readable via
//      /output yet is NOT findable via /search. This characterizes the known
//      unreliable-historical-search limitation so a future change is forced to notice.
//   4. Documented not-found status: /stats and /summary for an unknown id → 404.

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = resolve(__dirname, "../../../server/src/scripts/mock-agent.ts");
const TSX_LOADER = resolve(__dirname, "../../../server/node_modules/tsx/dist/loader.mjs");
const TSX_URL = pathToFileURL(TSX_LOADER).href;
const MOCK_AGENT_COMMAND = `node --import ${TSX_URL} "${MOCK_AGENT_PATH}"`;

test.describe("Session stats & summary REST contract", () => {
  let projectId: string;
  let statusId: string;
  const extraIssueIds: string[] = [];
  const extraWorkspaceIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    projectId = await getE2EProjectId(request);
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

  async function createWorkspace(suffix: string, request: APIRequestContext) {
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `Session stats/summary test ${suffix}`, statusId, projectId, skipAutoReview: true },
    });
    const issueId = (await issueRes.json()).id;
    extraIssueIds.push(issueId);

    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId, branch: `feature/session-stats-summary-${suffix}`, requiresReview: false },
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

  async function waitForExit(
    request: APIRequestContext,
    sessionId: string,
    timeoutMs = 15000,
  ): Promise<any[]> {
    let messages: any[] = [];
    await expect
      .poll(
        async () => {
          const res = await request.get(`${SERVER_URL}/api/sessions/${sessionId}/output`);
          if (res.status() !== 200) return false;
          messages = await res.json();
          return Array.isArray(messages) && messages.some((m) => m.type === "exit");
        },
        { timeout: timeoutMs, intervals: [250, 500, 500, 1000] },
      )
      .toBe(true);
    return messages;
  }

  test("GET /api/sessions/:id/stats returns the structured stats object after a mock run", async ({
    request,
  }) => {
    const { workspaceId } = await createWorkspace(`stats-${Date.now().toString(36)}`, request);

    const launchRes = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/launch`,
      {
        data: {
          prompt: "produce stats",
          agentCommand: `${MOCK_AGENT_COMMAND} --delay-ms 50`,
          multiTurn: false,
        },
      },
    );
    expect(launchRes.status()).toBe(201);
    const { sessionId } = await launchRes.json();

    // Stats are only FINALIZED on session exit (before that, /stats returns just the
    // launch metadata). Wait for the run to finish, then poll until the finalized
    // stats — carrying the run verdict the monitor consumes — are persisted.
    await waitForExit(request, sessionId);

    let stats: any;
    await expect
      .poll(
        async () => {
          const res = await request.get(`${SERVER_URL}/api/sessions/${sessionId}/stats`);
          if (res.status() !== 200) return false;
          stats = await res.json();
          return stats && typeof stats === "object" && "success" in stats;
        },
        { timeout: 15000, intervals: [250, 500, 500, 1000] },
      )
      .toBe(true);

    // Contract: stats is a JSON OBJECT (not an array, not a primitive). A regression
    // returning the raw string, an array, or 404 here makes this fail.
    expect(typeof stats).toBe("object");
    expect(Array.isArray(stats)).toBe(false);
    // The mock run emits a terminal result, so the finalized stats carry the
    // success verdict and cost/token accounting. Pin presence + types.
    expect(typeof stats.success).toBe("boolean");
    expect(typeof stats.durationMs).toBe("number");

    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/stop`, { data: {} });
  });

  test("GET /api/sessions/:id/summary returns the parsed SessionSummary body shape", async ({
    request,
  }) => {
    const { workspaceId } = await createWorkspace(`summary-${Date.now().toString(36)}`, request);

    const launchRes = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/launch`,
      {
        data: {
          prompt: "produce a summarizable run",
          agentCommand: `${MOCK_AGENT_COMMAND} --delay-ms 50`,
          multiTurn: false,
        },
      },
    );
    expect(launchRes.status()).toBe(201);
    const { sessionId } = await launchRes.json();

    // Let the run finish so the summary is parsed over a real transcript.
    await waitForExit(request, sessionId);

    const res = await request.get(`${SERVER_URL}/api/sessions/${sessionId}/summary`);
    expect(res.status()).toBe(200);
    const body = await res.json();

    // Contract: the server-parsed summary body. Assert KEYS + TYPES, not volatile
    // values (model id / counts vary). This is the endpoint shape the UI binds to.
    expect(body.sessionId).toBe(sessionId);
    expect(typeof body.overview).toBe("string");
    expect(typeof body.model).toBe("string");
    expect(Array.isArray(body.actions)).toBe(true);
    expect(Array.isArray(body.keyExcerpts)).toBe(true);
    expect(Array.isArray(body.errors)).toBe(true);
    expect(Array.isArray(body.filesRead)).toBe(true);
    expect(Array.isArray(body.filesEdited)).toBe(true);
    expect(Array.isArray(body.filesWritten)).toBe(true);
    expect(Array.isArray(body.commandsRun)).toBe(true);
    expect(Array.isArray(body.toolUsePatterns)).toBe(true);
    expect(Array.isArray(body.rateLimits)).toBe(true);
    // Lifecycle envelope fields the endpoint adds on top of the pure parser output.
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("duration");
    expect(body).toHaveProperty("startedAt");
    expect(body).toHaveProperty("stats");

    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/stop`, { data: {} });
  });

  test("BOUNDARY: a stdout-only token is readable via /output but NOT findable via /search", async ({
    request,
  }) => {
    const { workspaceId } = await createWorkspace(`search-${Date.now().toString(36)}`, request);

    // One mock run that emits BOTH kinds of content:
    //  - a unique token on STDERR (`--resume <token>` → "[mock-agent] resuming
    //    session: <token>"). stderr is a non-stdout event, so it IS persisted to
    //    `session_messages` (the table /search runs its LIKE over) → the POSITIVE
    //    CONTROL proving search, its joins, and projectId scoping actually work.
    //  - a fixed phrase on STDOUT (the streamed transcript). Detached-agent stdout
    //    is persisted only to the on-disk `.out` file, never to `session_messages`
    //    → the NEGATIVE case: in the transcript of record but outside the search
    //    index. The contrast (same session: stderr found, stdout not) is what makes
    //    the 0 meaningful rather than a tautology.
    const stderrToken = `SEARCHCTRL${Date.now().toString(36)}zzz`;
    const stdoutPhrase = "Mock agent completed the task successfully.";
    const launchRes = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/launch`,
      {
        data: {
          prompt: "emit a stdout transcript + stderr token",
          agentCommand: `${MOCK_AGENT_COMMAND} --delay-ms 50 --resume ${stderrToken}`,
          multiTurn: false,
        },
      },
    );
    expect(launchRes.status()).toBe(201);
    const { sessionId } = await launchRes.json();

    // Both the stderr token AND the stdout phrase are present in the transcript
    // exposed by /output (which reads the full .out file + DB rows).
    let outputHasBoth = false;
    await expect
      .poll(
        async () => {
          const res = await request.get(`${SERVER_URL}/api/sessions/${sessionId}/output`);
          if (res.status() !== 200) return false;
          const messages: any[] = await res.json();
          const hasStderr = messages.some(
            (m) => typeof m.data === "string" && m.data.includes(stderrToken),
          );
          const hasStdout = messages.some(
            (m) => typeof m.data === "string" && m.data.includes(stdoutPhrase),
          );
          outputHasBoth = hasStderr && hasStdout;
          return outputHasBoth;
        },
        { timeout: 15000, intervals: [250, 500, 500, 1000] },
      )
      .toBe(true);
    expect(outputHasBoth).toBe(true);

    // POSITIVE CONTROL: the stderr token IS findable via /search, and the hit maps
    // back to this session. A globally broken search (broken join / projectId scope /
    // always-[]) would fail HERE, so the negative assertion below cannot be a false pass.
    let posBody: any;
    await expect
      .poll(
        async () => {
          const res = await request.get(
            `${SERVER_URL}/api/sessions/search?q=${encodeURIComponent(stderrToken)}&projectId=${projectId}`,
          );
          if (res.status() !== 200) return false;
          posBody = await res.json();
          return posBody.totalMatches >= 1;
        },
        { timeout: 15000, intervals: [250, 500, 500, 1000] },
      )
      .toBe(true);
    expect(posBody.results.some((r: any) => r.sessionId === sessionId)).toBe(true);

    // NEGATIVE: the stdout phrase is NOT findable, because stdout never landed in
    // session_messages. If a future change started indexing stdout into that table,
    // this flips and forces the boundary to be re-evaluated.
    const negRes = await request.get(
      `${SERVER_URL}/api/sessions/search?q=${encodeURIComponent(stdoutPhrase)}&projectId=${projectId}`,
    );
    expect(negRes.status()).toBe(200);
    const negBody = await negRes.json();
    expect(Array.isArray(negBody.results)).toBe(true);
    expect(negBody.totalMatches).toBe(0);
    expect(negBody.results.length).toBe(0);

    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/stop`, { data: {} });
  });

  test("BOUNDARY: /stats and /summary return the documented 404 for an unknown session", async ({
    request,
  }) => {
    const statsRes = await request.get(`${SERVER_URL}/api/sessions/does-not-exist/stats`);
    expect(statsRes.status()).toBe(404);
    expect((await statsRes.json()).error).toBe("Session not found");

    const summaryRes = await request.get(`${SERVER_URL}/api/sessions/does-not-exist/summary`);
    expect(summaryRes.status()).toBe(404);
    expect((await summaryRes.json()).error).toBe("Session not found");
  });
});
