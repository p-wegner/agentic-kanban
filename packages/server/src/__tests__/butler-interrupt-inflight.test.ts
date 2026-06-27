// @covers butler.interrupt.inflight [state-transition, concurrency, api]
//
// Behaviour: interrupting a butler turn that is ACTIVELY STREAMING. The existing
// coverage is partial — butler-provider.test.ts interrupts nothing (it asserts the
// codex-busy boolean) and the MCP test only checks request shape. The real,
// load-bearing behaviour is the mid-flight interrupt: a streaming turn is cut off,
// the in-flight stream STOPS, yet the warm session SURVIVES and accepts the next turn.
//
// This test pins all three observable outcomes through the HTTP routes:
//   (1) state-transition + concurrency: POST /butler/interrupt while a turn is
//       streaming stops the stream (no further assistant text deltas, busy → idle,
//       a result is emitted so the UI leaves its "thinking" state).
//   (2) state-transition: GET butler stays active:true — interrupt clears the
//       in-flight turn (busy→idle) WITHOUT tearing the session down (warm, not cold).
//   (3) api + concurrency: the subsequent POST /butler/message is accepted (200) and
//       produces a reply on the SAME warm session (no respawn between turns).
//
// Determinism: the Claude Agent SDK is mocked with a GATED stream. Each turn emits
// exactly one text delta (provably "streaming"), then BLOCKS on a per-turn gate. The
// gate is released by the SDK control method `query.interrupt()` (the real interrupt
// path) → the turn stops with no further deltas; or by the test's `release()` → the
// turn completes normally. No fixed sleeps drive the race: the interrupt is fired
// only after the first delta has provably been broadcast, and the gate guarantees the
// turn is in-flight at that instant.
//
// Mutation check (why it goes RED if the behaviour breaks):
//  - If interrupt did NOT actually stop the in-flight turn (interruptButler became a
//    no-op that never resolved the SDK turn / gate): note interruptButler sets
//    busy=false and broadcasts {type:result} UNCONDITIONALLY after query.interrupt()
//    returns, so the busy→idle / result-emitted assertions alone would NOT catch this.
//    The REAL catch is the FOLLOW-UP turn: the gated mock is a single-consumer loop,
//    so an un-stopped turn 1 leaves it blocked forever → turn 2 never streams
//    (waitForCondition('follow-up streaming') times out) and/or POST /message 409s.
//    The follow-up assertions are what fail a no-op interrupt.
//  - If interrupt tore down the session (warm→cold, e.g. calling stopButlerSession),
//    GET butler.active would be false → assertion fails.
//  - If the stream kept flowing after interrupt, a second "Second chunk" text delta
//    would appear → the "only one delta" assertion fails.
//  - The busy-rejection branch is pinned directly: a second POST /message fired while
//    turn 1 is still in-flight returns 409 ("already processing") and enqueues nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { projects } from "@agentic-kanban/shared/schema";

const sdkMock = vi.hoisted(() => ({
  instances: [] as Array<{
    sessionId: string;
    interrupt: ReturnType<typeof vi.fn>;
    release: () => void;
  }>,
  nextSessionNumber: 1,
}));

// Mocked SDK query with a GATED stream. The runLoop consumes this object via
// `for await (const msg of q)`; turns are fed in through the `prompt` pushable.
// Per turn: emit one text delta → block on a deferred gate. `interrupt()` (the SDK
// control request the service calls) resolves the gate as INTERRUPTED → the turn
// stops with no result and no further deltas, but the iterator stays alive (the warm
// session survives). `release()` resolves it normally → the turn finishes with a
// result. The iterator never completes on its own, so the session never goes cold.
vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  const createDeferred = <T>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  const extractText = (m: unknown): string => {
    const content = (m as { message?: { content?: unknown } })?.message?.content;
    return typeof content === "string" ? content : "";
  };

  return {
    query: vi.fn(({ prompt }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
      const sessionId = `sdk-session-${sdkMock.nextSessionNumber++}`;

      // Out-channel feeding the runLoop's `for await`.
      const outQueue: Array<Record<string, unknown>> = [];
      let outWaiter: ((r: IteratorResult<Record<string, unknown>>) => void) | null = null;
      let outDone = false;
      const pushOut = (msg: Record<string, unknown>) => {
        if (outWaiter) {
          const w = outWaiter;
          outWaiter = null;
          w({ done: false, value: msg });
        } else {
          outQueue.push(msg);
        }
      };

      let currentGate: { promise: Promise<{ interrupted: boolean }>; resolve: (v: { interrupted: boolean }) => void } | null = null;

      const instance = {
        sessionId,
        // SDK control request used by interruptButler — stops the in-flight turn.
        interrupt: vi.fn(async () => {
          const g = currentGate;
          currentGate = null;
          if (g) g.resolve({ interrupted: true });
        }),
        // Test-only: let a gated turn finish normally (used for the follow-up turn).
        release: () => {
          const g = currentGate;
          currentGate = null;
          if (g) g.resolve({ interrupted: false });
        },
        setModel: vi.fn(async () => {}),
        supportedCommands: vi.fn(async () => []),
        getContextUsage: vi.fn(async () => ({ totalTokens: 10, maxTokens: 200000 })),
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<Record<string, unknown>>> {
              if (outQueue.length > 0) {
                return Promise.resolve({ done: false, value: outQueue.shift() as Record<string, unknown> });
              }
              if (outDone) {
                return Promise.resolve({ done: true, value: undefined as unknown as Record<string, unknown> });
              }
              return new Promise((resolve) => {
                outWaiter = resolve;
              });
            },
          };
        },
      };
      sdkMock.instances.push(instance);

      // Background driver: init event, then one gated turn per pushed user message.
      void (async () => {
        pushOut({
          type: "system",
          subtype: "init",
          session_id: sessionId,
          model: "sdk-default-model",
          mcp_servers: [{ name: "agentic-kanban", status: "connected" }],
        });
        for await (const userMsg of prompt) {
          const text = extractText(userMsg);
          const gate = createDeferred<{ interrupted: boolean }>();
          currentGate = gate; // armed BEFORE the first delta, so a delta implies a live gate
          // First streaming delta — the turn is now provably in-flight.
          pushOut({
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "First chunk " } },
          });
          const { interrupted } = await gate.promise;
          if (interrupted) {
            // Mid-flight interrupt: stop the stream — no more deltas, no result.
            continue;
          }
          // Normal completion.
          pushOut({
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "Second chunk" } },
          });
          pushOut({ type: "result", subtype: "success", result: `Full reply: ${text}` });
        }
        outDone = true;
        if (outWaiter) {
          const w = outWaiter;
          outWaiter = null;
          w({ done: true, value: undefined as unknown as Record<string, unknown> });
        }
      })();

      return instance;
    }),
  };
});

import { createButlerRoute } from "../routes/butler.js";
import {
  getButlerSession,
  getButlerTranscript,
  stopButlerSession,
  subscribeButler,
} from "../services/butler-sdk.service.js";
import type { ButlerEvent } from "../services/butler-sdk.service.js";
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
    name: "Butler Interrupt Test",
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

function textEvents(events: ButlerEvent[]): Array<{ type: "text"; text: string }> {
  return events.filter((e): e is { type: "text"; text: string } => e.type === "text");
}

function waitForCondition(description: string, condition: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() - started > 2000) {
        reject(new Error(`Timed out waiting for ${description}`));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

describe("Butler interrupt of an in-flight streaming turn", () => {
  const sessionsToStop: string[] = [];

  beforeEach(() => {
    sdkMock.instances.length = 0;
    sdkMock.nextSessionNumber = 1;
  });

  afterEach(() => {
    while (sessionsToStop.length > 0) {
      stopButlerSession(sessionsToStop.pop() as string);
    }
  });

  it("stops the in-flight stream, keeps the session warm, and accepts a follow-up turn", async () => {
    const { app, db } = createTestApp();
    const projectId = await createProject(db);
    sessionsToStop.push(projectId);

    const events: ButlerEvent[] = [];
    const unsubscribe = subscribeButler(projectId, (e) => events.push(e));

    // Warm the session (claude backend — fresh test DB has no provider/profile pref).
    const ensure = await app.request(`/api/projects/${projectId}/butler/ensure`, { method: "POST", body: "{}" });
    expect(ensure.status).toBe(201);
    await waitForCondition("SDK query instance", () => sdkMock.instances.length >= 1);
    const inst = sdkMock.instances[0];

    // ── turn 1: begin a streaming turn ──────────────────────────────────────────
    const msg1 = await postMessage(app, projectId, "explain the architecture");
    expect(msg1.status).toBe(200);
    expect(await msg1.json()).toMatchObject({ ok: true });

    // Provably streaming: the first delta has been broadcast and the turn is in-flight.
    await waitForCondition("first streamed delta", () => textEvents(events).length >= 1);
    expect(getButlerSession(projectId).busy).toBe(true);
    expect(textEvents(events).map((e) => e.text)).toEqual(["First chunk "]);

    // ── concurrency: a second turn fired WHILE turn 1 is in-flight is rejected ───
    // The busy guard (sendButlerTurn → route) returns 409 and enqueues nothing: no
    // second SDK query instance is spawned and no extra delta streams.
    const overlapping = await postMessage(app, projectId, "and the backlog?");
    expect(overlapping.status).toBe(409);
    expect((await overlapping.json()).error).toMatch(/already processing/i);
    expect(sdkMock.instances).toHaveLength(1);
    expect(textEvents(events).map((e) => e.text)).toEqual(["First chunk "]);

    // ── interrupt mid-flight (the api dimension: POST /butler/interrupt) ─────────
    const interruptRes = await app.request(`/api/projects/${projectId}/butler/interrupt`, { method: "POST" });
    expect(interruptRes.status).toBe(200);
    expect(await interruptRes.json()).toMatchObject({ ok: true });

    // (1) The stream STOPS: turn goes idle and a result is emitted...
    await waitForCondition("turn idle after interrupt", () => getButlerSession(projectId).busy === false);
    expect(events.some((e) => e.type === "result")).toBe(true);
    // ...and settles with NO further assistant deltas (no gated "Second chunk").
    await new Promise((r) => setTimeout(r, 25));
    expect(textEvents(events).map((e) => e.text)).toEqual(["First chunk "]);
    // The interrupted turn produced no assistant transcript entry (it never completed).
    expect(getButlerTranscript(projectId).filter((m) => m.role === "assistant")).toHaveLength(0);

    // (2) The session stays WARM (interrupt must not tear it down warm→cold).
    const stateRes = await app.request(`/api/projects/${projectId}/butler`);
    expect(stateRes.status).toBe(200);
    expect(await stateRes.json()).toMatchObject({ active: true });
    expect(getButlerSession(projectId).active).toBe(true);
    expect(getButlerSession(projectId).busy).toBe(false);

    // ── (3) the follow-up turn is accepted (200) and produces a reply ───────────
    events.length = 0;
    const msg2 = await postMessage(app, projectId, "now summarize");
    expect(msg2.status).toBe(200);
    expect(await msg2.json()).toMatchObject({ ok: true });

    await waitForCondition("follow-up streaming", () => textEvents(events).length >= 1);
    inst.release(); // let the follow-up complete normally
    await waitForCondition(
      "follow-up reply landed",
      () => getButlerTranscript(projectId).some((m) => m.role === "assistant"),
    );

    const assistant = getButlerTranscript(projectId).filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0].text).toContain("now summarize");

    // The SAME warm session served the follow-up — no cold respawn between turns.
    expect(sdkMock.instances).toHaveLength(1);

    unsubscribe();
  });
});
