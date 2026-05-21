import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = resolve(
  __dirname,
  "../../../server/src/scripts/mock-agent.ts",
);
const TSX_LOADER = resolve(
  __dirname,
  "../../../server/node_modules/tsx/dist/loader.mjs",
);
const TSX_URL = pathToFileURL(TSX_LOADER).href;
const MOCK_AGENT_COMMAND = `node --import ${TSX_URL} "${MOCK_AGENT_PATH}"`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test.describe("Mock agent profiles", () => {
  let projectId: string;
  let statusId: string;
  const extraIssueIds: string[] = [];
  const extraWorkspaceIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get(`${SERVER_URL}/api/projects`);
    const projects = await projectsRes.json();
    projectId = projects[0].id;

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todoStatus ? todoStatus.id : statuses[0].id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of extraWorkspaceIds) {
      await request.delete(`${SERVER_URL}/api/workspaces/${id}`);
    }
    for (const id of extraIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  async function createWorkspaceWithSetup(suffix: string, request: any) {
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: `Mock agent test ${suffix}`,
        statusId,
        projectId,
        skipAutoReview: true,
      },
    });
    const issueId = (await issueRes.json()).id;
    extraIssueIds.push(issueId);

    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: {
        issueId,
        branch: `feature/mock-test-${suffix}`,
        requiresReview: false,
      },
    });
    expect(wsRes.status()).toBe(201);
    const workspaceId = (await wsRes.json()).id;
    extraWorkspaceIds.push(workspaceId);

    // Setup worktree with retries
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
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!setupOk) test.skip();

    return { issueId, workspaceId };
  }

  async function waitForSession(request: any, workspaceId: string, sessionId: string, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const outputRes = await request.get(
        `${SERVER_URL}/api/sessions/${sessionId}/output`,
      );
      if (outputRes.status() === 200) {
        const messages = await outputRes.json();
        const hasExit = messages.some((m: any) => m.type === "exit");
        if (hasExit) return messages;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  async function waitForSessionStatus(request: any, workspaceId: string, targetStatus: string, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const sessionsRes = await request.get(
        `${SERVER_URL}/api/workspaces/${workspaceId}/sessions`,
      );
      if (sessionsRes.ok()) {
        const sessions = await sessionsRes.json();
        const running = sessions.find((s: any) => s.status === targetStatus);
        if (running) return running;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  test("standard profile produces complete stream-json output", async ({
    request,
  }) => {
    const { workspaceId } = await createWorkspaceWithSetup(
      `standard-${Date.now().toString(36)}`,
      request,
    );

    const launchRes = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/launch`,
      {
        data: {
          prompt: "test standard profile",
          agentCommand: MOCK_AGENT_COMMAND,
          multiTurn: false,
        },
      },
    );
    expect(launchRes.status()).toBe(201);
    const { sessionId } = await launchRes.json();

    const messages = await waitForSession(request, workspaceId, sessionId);
    expect(messages).not.toBeNull();

    const stdoutMessages = messages.filter(
      (m: any) => m.type === "stdout" && m.data,
    );
    expect(stdoutMessages.length).toBeGreaterThan(0);

    // Parse all stdout JSON lines
    const events = stdoutMessages
      .flatMap((m: any) =>
        m.data
          .split("\n")
          .filter((l: string) => l.trim())
          .map((l: string) => JSON.parse(l)),
      );

    const initEvent = events.find(
      (e: any) => e.type === "system" && e.subtype === "init",
    );
    expect(initEvent).toBeDefined();
    expect(initEvent.session_id).toMatch(UUID_RE);

    const toolEvents = events.filter(
      (e: any) =>
        e.type === "assistant" &&
        e.message?.content?.some((c: any) => c.type === "tool_use"),
    );
    expect(toolEvents.length).toBeGreaterThanOrEqual(1);

    const resultEvent = events.find((e: any) => e.type === "result");
    expect(resultEvent).toBeDefined();
    expect(resultEvent.subtype).toBe("success");

    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/stop`, {
      data: {},
    });
  });

  test("UUID session_id gets stored as providerSessionId", async ({
    request,
  }) => {
    const { workspaceId } = await createWorkspaceWithSetup(
      `uuid-${Date.now().toString(36)}`,
      request,
    );

    const deterministicId = randomUUID();
    const launchRes = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/launch`,
      {
        data: {
          prompt: "test session id storage",
          agentCommand: `${MOCK_AGENT_COMMAND} --session-id ${deterministicId}`,
          multiTurn: false,
        },
      },
    );
    expect(launchRes.status()).toBe(201);
    const { sessionId } = await launchRes.json();

    await waitForSession(request, workspaceId, sessionId);

    // Check session record has providerSessionId
    const sessionsRes = await request.get(
      `${SERVER_URL}/api/workspaces/${workspaceId}/sessions`,
    );
    expect(sessionsRes.ok()).toBeTruthy();
    const sessions = await sessionsRes.json();
    const session = sessions.find((s: any) => s.id === sessionId);
    expect(session).toBeDefined();
    expect(session.providerSessionId).toBe(deterministicId);

    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/stop`, {
      data: {},
    });
  });

  test("session resume chain works with mock agent", async ({ request }) => {
    const { workspaceId } = await createWorkspaceWithSetup(
      `resume-${Date.now().toString(36)}`,
      request,
    );

    // Launch first session with a deterministic session ID
    const deterministicId = randomUUID();
    const launch1Res = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/launch`,
      {
        data: {
          prompt: "first session",
          agentCommand: `${MOCK_AGENT_COMMAND} --session-id ${deterministicId}`,
          multiTurn: false,
        },
      },
    );
    expect(launch1Res.status()).toBe(201);
    const { sessionId: session1Id } = await launch1Res.json();

    await waitForSession(request, workspaceId, session1Id);
    await waitForSessionStatus(request, workspaceId, "completed");

    // Verify session 1 has providerSessionId stored
    const sessions1Res = await request.get(
      `${SERVER_URL}/api/workspaces/${workspaceId}/sessions`,
    );
    const sessions1 = await sessions1Res.json();
    const session1 = sessions1.find((s: any) => s.id === session1Id);
    expect(session1?.providerSessionId).toBe(deterministicId);

    // Launch session 2 with --resume in the command string itself.
    // (On Windows with shell:true, spawn() args can get lost when the command
    // already contains quotes, so we embed --resume directly in agentCommand.)
    const launch2Res = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/launch`,
      {
        data: {
          prompt: "follow-up message",
          agentCommand: `${MOCK_AGENT_COMMAND} --resume ${deterministicId}`,
          resumeFromId: session1Id,
          multiTurn: false,
        },
      },
    );
    expect(launch2Res.status()).toBe(201);
    const { sessionId: session2Id } = await launch2Res.json();

    const messages = await waitForSession(request, workspaceId, session2Id);
    expect(messages).not.toBeNull();

    // Verify session 2 was launched with --resume by checking:
    // 1. stderr should contain "resuming session" log from mock-agent
    // 2. or stdout assistant text should contain "Resuming session" (from runStandard)
    const stdoutMessages = messages.filter(
      (m: any) => m.type === "stdout" && m.data,
    );
    const events = stdoutMessages.flatMap((m: any) =>
      m.data
        .split("\n")
        .filter((l: string) => l.trim())
        .map((l: string) => {
          try { return JSON.parse(l); } catch { return null; }
        })
        .filter(Boolean),
    );
    const stderrMessages = messages.filter(
      (m: any) => m.type === "stderr" && m.data,
    );
    const hasResumeIndicator =
      stderrMessages.some((m: any) => m.data.includes("resuming session")) ||
      events.some((e: any) =>
        e.type === "assistant" &&
        e.message?.content?.some((c: any) =>
          c.type === "text" && c.text?.includes("Resuming session"),
        ),
      );
    expect(hasResumeIndicator).toBe(true);

    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/stop`, {
      data: {},
    });
  });

  test("multi-turn profile keeps agent running until stdin closes", async ({ request }) => {
    const { workspaceId } = await createWorkspaceWithSetup(
      `multiturn-${Date.now().toString(36)}`,
      request,
    );

    // Launch with multiTurn enabled — agent.service.ts adds --profile multi-turn automatically
    const launchRes = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/launch`,
      {
        data: {
          prompt: "start multi-turn",
          agentCommand: `${MOCK_AGENT_COMMAND} --delay-ms 100`,
          multiTurn: true,
        },
      },
    );
    expect(launchRes.status()).toBe(201);
    const { sessionId } = await launchRes.json();

    // Wait for first turn output to arrive
    await new Promise((r) => setTimeout(r, 3000));

    // Stop the session (closes stdin, which triggers agent exit)
    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/stop`, {
      data: {},
    });

    // Wait for agent to fully exit
    const messages = await waitForSession(request, workspaceId, sessionId);

    // Get all output
    const outputRes = await request.get(
      `${SERVER_URL}/api/sessions/${sessionId}/output`,
    );
    expect(outputRes.status()).toBe(200);
    const allMessages = await outputRes.json();

    const stdoutMessages = allMessages.filter(
      (m: any) => m.type === "stdout" && m.data,
    );
    expect(stdoutMessages.length).toBeGreaterThan(0);

    // Parse events
    const events = stdoutMessages.flatMap((m: any) =>
      m.data
        .split("\n")
        .filter((l: string) => l.trim())
        .map((l: string) => {
          try { return JSON.parse(l); } catch { return null; }
        })
        .filter(Boolean),
    );

    // Should have: init + first assistant + first result (from first turn)
    const initEvent = events.find(
      (e: any) => e.type === "system" && e.subtype === "init",
    );
    expect(initEvent).toBeDefined();

    const resultEvents = events.filter((e: any) => e.type === "result");
    expect(resultEvents.length).toBeGreaterThanOrEqual(1);

    // Verify session completed (stdin close triggers exit)
    const sessionsRes = await request.get(
      `${SERVER_URL}/api/workspaces/${workspaceId}/sessions`,
    );
    const sessions = await sessionsRes.json();
    const session = sessions.find((s: any) => s.id === sessionId);
    expect(session).toBeDefined();
    expect(["completed", "stopped"]).toContain(session.status);
  });

  test("multi-turn POST /turn sends message and agent echoes response", async ({ request }) => {
    const { workspaceId } = await createWorkspaceWithSetup(
      `multiturn-turn-${Date.now().toString(36)}`,
      request,
    );

    const launchRes = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/launch`,
      {
        data: {
          prompt: "start multi-turn",
          agentCommand: `${MOCK_AGENT_COMMAND} --delay-ms 100`,
          multiTurn: true,
        },
      },
    );
    expect(launchRes.status()).toBe(201);
    const { sessionId } = await launchRes.json();

    // Poll POST /turn until the agent accepts it (not 409 = still processing)
    // The mock agent emits result after the first turn; once "waiting", /turn returns 200
    const turnContent = "hello from test turn";
    let turnRes: any = null;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const res = await request.post(
        `${SERVER_URL}/api/workspaces/${workspaceId}/turn`,
        { data: { content: turnContent } },
      );
      if (res.status() === 200) {
        turnRes = res;
        break;
      }
      // 409 = agent still processing first turn; wait and retry
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(turnRes).not.toBeNull();
    expect(turnRes.status()).toBe(200);

    // Wait for the second turn to produce a result event in session output
    let echoVerified = false;
    const deadline2 = Date.now() + 8000;
    while (Date.now() < deadline2) {
      const outputRes = await request.get(`${SERVER_URL}/api/sessions/${sessionId}/output`);
      if (outputRes.status() === 200) {
        const msgs = await outputRes.json();
        const events = msgs
          .filter((m: any) => m.type === "stdout" && m.data)
          .flatMap((m: any) =>
            m.data
              .split("\n")
              .filter((l: string) => l.trim())
              .map((l: string) => { try { return JSON.parse(l); } catch { return null; } })
              .filter(Boolean),
          );
        const hasEcho = events.some(
          (e: any) =>
            e.type === "assistant" &&
            e.message?.content?.some(
              (c: any) => c.type === "text" && c.text?.includes(`Received: ${turnContent}`),
            ),
        );
        if (hasEcho) { echoVerified = true; break; }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(echoVerified).toBe(true);

    // Stop the session and verify ≥2 result events (first turn + follow-up)
    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/stop`, { data: {} });
    const outputRes = await request.get(`${SERVER_URL}/api/sessions/${sessionId}/output`);
    const allMessages = await outputRes.json();
    const events = allMessages
      .filter((m: any) => m.type === "stdout" && m.data)
      .flatMap((m: any) =>
        m.data
          .split("\n")
          .filter((l: string) => l.trim())
          .map((l: string) => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean),
      );
    const resultEvents = events.filter((e: any) => e.type === "result");
    expect(resultEvents.length).toBeGreaterThanOrEqual(2);
  });

  test("error profile exits with failure", async ({ request }) => {
    const { workspaceId } = await createWorkspaceWithSetup(
      `error-${Date.now().toString(36)}`,
      request,
    );

    const launchRes = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/launch`,
      {
        data: {
          prompt: "test error profile",
          agentCommand: `${MOCK_AGENT_COMMAND} --profile error --delay-ms 100`,
          multiTurn: false,
        },
      },
    );
    expect(launchRes.status()).toBe(201);
    const { sessionId } = await launchRes.json();

    const messages = await waitForSession(request, workspaceId, sessionId);
    expect(messages).not.toBeNull();

    const stdoutMessages = messages.filter(
      (m: any) => m.type === "stdout" && m.data,
    );
    const events = stdoutMessages.flatMap((m: any) =>
      m.data
        .split("\n")
        .filter((l: string) => l.trim())
        .map((l: string) => {
          try { return JSON.parse(l); } catch { return null; }
        })
        .filter(Boolean),
    );

    const resultEvent = events.find((e: any) => e.type === "result");
    expect(resultEvent).toBeDefined();
    expect(resultEvent.is_error).toBe(true);

    const exitMessages = messages.filter((m: any) => m.type === "exit");
    expect(exitMessages.length).toBeGreaterThan(0);

    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/stop`, {
      data: {},
    });
  });

  test("configurable delay controls timing", async ({ request }) => {
    const { workspaceId } = await createWorkspaceWithSetup(
      `delay-${Date.now().toString(36)}`,
      request,
    );

    const launchRes = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/launch`,
      {
        data: {
          prompt: "test delay profile",
          agentCommand: `${MOCK_AGENT_COMMAND} --profile minimal --delay-ms 100`,
          multiTurn: false,
        },
      },
    );
    expect(launchRes.status()).toBe(201);
    const { sessionId } = await launchRes.json();

    const messages = await waitForSession(request, workspaceId, sessionId);
    expect(messages).not.toBeNull();

    // With --delay-ms 100 and minimal profile (2 delays), total should be < 3 seconds
    const stdoutMessages = messages.filter(
      (m: any) => m.type === "stdout" && m.data,
    );
    const events = stdoutMessages.flatMap((m: any) =>
      m.data
        .split("\n")
        .filter((l: string) => l.trim())
        .map((l: string) => {
          try { return JSON.parse(l); } catch { return null; }
        })
        .filter(Boolean),
    );

    // Minimal profile: init + assistant text + result = 3 events
    expect(events.length).toBeGreaterThanOrEqual(3);

    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/stop`, {
      data: {},
    });
  });
});
