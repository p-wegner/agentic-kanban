// @covers butler.reject.busy [error,api,concurrency]
//
// Behaviour: a turn is rejected while the butler is busy — a single in-flight
// turn per session, no concurrent streams into one context. The existing
// coverage (butler-provider.test.ts:336) only asserts the SERVICE boolean
// (sendButlerTurn returns false). This test pins the HTTP CONTRACT: while a
// turn is in flight, POST /butler/message returns 409 and does NOT enqueue a
// second concurrent turn, while a non-busy session accepts the message (200).
//
// The Claude Agent SDK is mocked so the in-flight turn never completes — the
// mocked iterator yields its init event then awaits the abort signal, so the
// session stays `busy` deterministically (no real SDK session, no timing race).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { projects } from "@agentic-kanban/shared/schema";

const sdkMock = vi.hoisted(() => ({
  calls: [] as Array<{ options: Record<string, unknown>; sessionId: string }>,
  nextSessionNumber: 1,
}));

// Mocked SDK query: emits one `system/init` event (so the session adopts an id
// and goes active) then blocks forever on the abort signal. It NEVER yields a
// `result`, so `sendButlerTurn`'s busy flag is never cleared — the session is
// pinned in the in-flight state for the whole test.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(({ options }: { options: Record<string, unknown> }) => {
    const call = { options, sessionId: `sdk-session-${sdkMock.nextSessionNumber++}` };
    sdkMock.calls.push(call);
    let yieldedInit = false;
    const abortSignal = (options.abortController as AbortController | undefined)?.signal;
    return {
      setModel: vi.fn(async () => {}),
      supportedCommands: vi.fn(async () => []),
      getContextUsage: vi.fn(async () => ({ totalTokens: 0, maxTokens: 200000 })),
      [Symbol.asyncIterator]() {
        return this;
      },
      async next(): Promise<IteratorResult<Record<string, unknown>>> {
        if (!yieldedInit) {
          yieldedInit = true;
          return new Promise((resolve) =>
            queueMicrotask(() =>
              resolve({
                done: false,
                value: {
                  type: "system",
                  subtype: "init",
                  session_id: call.sessionId,
                  model: "sdk-default-model",
                  mcp_servers: [{ name: "agentic-kanban", status: "connected" }],
                },
              }),
            ),
          );
        }
        if (abortSignal?.aborted) {
          return { done: true, value: undefined as unknown as Record<string, unknown> };
        }
        // Block until the session is torn down (abort) — never produce a result.
        return new Promise((resolve) => {
          abortSignal?.addEventListener(
            "abort",
            () => resolve({ done: true, value: undefined as unknown as Record<string, unknown> }),
            { once: true },
          );
        });
      },
    };
  }),
}));

import { createButlerRoute } from "../routes/butler.js";
import { getButlerSession, getButlerTranscript, stopButlerSession } from "../services/butler-sdk.service.js";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import type { TestDb } from "./helpers/test-db.js";

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api/projects", createButlerRoute(db, () => createMockSessionManager()));
  });
}

async function createProject(db: TestDb): Promise<string> {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(projects).values({
    id,
    name: "Butler Busy Test",
    repoPath: process.cwd(),
    repoName: "agentic-kanban",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

function postMessage(app: ReturnType<typeof createTestApp>["app"], projectId: string, content: string) {
  return app.request(`/api/projects/${projectId}/butler/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

describe("Butler /message rejects a concurrent turn with HTTP 409", () => {
  const sessionsToStop: string[] = [];

  beforeEach(() => {
    sdkMock.calls.length = 0;
    sdkMock.nextSessionNumber = 1;
  });

  afterEach(() => {
    while (sessionsToStop.length > 0) {
      stopButlerSession(sessionsToStop.pop() as string);
    }
  });

  it("accepts the first message (200) but rejects an overlapping one with 409 — no second turn enqueued", async () => {
    const { app, db } = createTestApp();
    const projectId = await createProject(db);
    sessionsToStop.push(projectId);

    // A non-busy session accepts the message: the first /message starts the
    // warm Claude session and pushes the turn → 200 {ok:true}.
    const first = await postMessage(app, projectId, "what is on the board?");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true });

    // The mocked SDK never produces a result, so the turn is still in flight.
    expect(getButlerSession(projectId).busy).toBe(true);
    expect(getButlerTranscript(projectId).filter((m) => m.role === "user")).toHaveLength(1);

    // Second message while busy → HTTP 409 (the contract this test pins).
    const second = await postMessage(app, projectId, "and what about the backlog?");
    expect(second.status).toBe(409);
    // Tolerant match on the error (status 409 is the load-bearing contract; copy may reword).
    expect((await second.json()).error).toMatch(/already processing/i);

    // The 409 turn was NOT enqueued: no second concurrent SDK query was started
    // (no context fork) and the rejected prompt did not land in the transcript.
    expect(sdkMock.calls).toHaveLength(1);
    const userTurns = getButlerTranscript(projectId).filter((m) => m.role === "user");
    expect(userTurns).toHaveLength(1);
    expect(userTurns.map((m) => m.text)).not.toContain("and what about the backlog?");
  });
});
