import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

/**
 * Arch-review §2.4 / ticket #14: the butler's Codex path used to call the
 * UNOBSERVED `provider.parseStreamEvent`, re-opening the silent-swallow hole that
 * #898 closed on the main agent path — a valid-JSON line of an UNKNOWN event type
 * was dropped with no telemetry. It now routes through `parseStreamEventObserved`,
 * so a CLI wire-format drift is COUNTED instead of vanishing. This test drives the
 * real codex butler spawn path and asserts the unknown-event counter increments.
 */

// --- child_process.spawn mock (same shape as butler-codex-resume-recovery) ---
const spawnMock = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: string[] }>,
  scripts: [] as Array<(h: {
    stdout: Array<(b: Buffer) => void>;
    stderr: Array<(b: Buffer) => void>;
    exit: Array<(code: number) => void>;
  }) => void>,
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn((command: string, args: string[]) => {
    const index = spawnMock.calls.length;
    spawnMock.calls.push({ command, args });
    const handlers = {
      stdout: [] as Array<(b: Buffer) => void>,
      stderr: [] as Array<(b: Buffer) => void>,
      exit: [] as Array<(code: number) => void>,
    };
    const script = spawnMock.scripts[index];
    return {
      pid: 2000 + index,
      stdout: { on: (ev: string, cb: (b: Buffer) => void) => { if (ev === "data") handlers.stdout.push(cb); } },
      stderr: { on: (ev: string, cb: (b: Buffer) => void) => { if (ev === "data") handlers.stderr.push(cb); } },
      stdin: { end: () => { if (script) setTimeout(() => script(handlers), 0); }, write: () => {} },
      on: (ev: string, cb: (...a: unknown[]) => void) => { if (ev === "exit") handlers.exit.push(cb as (code: number) => void); },
      kill: () => {},
    };
  }),
}));

// Imports must come after vi.mock
import {
  ensureButlerSession,
  sendButlerTurn,
  stopButlerSession,
  getButlerSession,
  subscribeButler,
  type ButlerEvent,
} from "../services/butler-sdk.service.js";
import {
  getUnknownEventCounters,
  resetUnknownEventCounters,
  setUnknownEventLogger,
  type UnknownEventLogger,
} from "@agentic-kanban/shared/lib/agent-stream-parser";

function emitJson(handlers: { stdout: Array<(b: Buffer) => void> }, obj: unknown): void {
  for (const cb of handlers.stdout) cb(Buffer.from(`${JSON.stringify(obj)}\n`));
}

function waitFor(desc: string, cond: () => boolean, ms = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (cond()) return resolve();
      if (Date.now() - start > ms) return reject(new Error(`Timed out waiting for ${desc}`));
      setTimeout(check, 5);
    };
    check();
  });
}

describe("Codex butler observed-parse (#898 hole closed on butler path)", () => {
  const toStop: Array<{ projectId: string; butlerId: string }> = [];
  let restoreLogger: UnknownEventLogger;

  beforeEach(() => {
    spawnMock.calls.length = 0;
    spawnMock.scripts.length = 0;
    resetUnknownEventCounters();
    restoreLogger = setUnknownEventLogger(() => {});
  });

  afterEach(() => {
    while (toStop.length) {
      const { projectId, butlerId } = toStop.pop()!;
      stopButlerSession(projectId, butlerId);
    }
    setUnknownEventLogger(restoreLogger);
    resetUnknownEventCounters();
  });

  it("records an unknown codex event type instead of silently swallowing it", async () => {
    // The turn emits a valid-JSON line of an UNKNOWN event type (a hypothetical
    // renamed CLI event), then completes normally so the butler does not hang.
    spawnMock.scripts.push((h) => {
      emitJson(h, { type: "thread.started", thread_id: "obs-thread-1" });
      emitJson(h, { type: "turn.renamed_in_a_future_cli_v9" });
      emitJson(h, { type: "item.completed", item: { id: "i1", type: "agent_message", text: "done" } });
      emitJson(h, { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
      for (const cb of h.exit) cb(0);
    });

    const projectId = randomUUID();
    const butlerId = "default";
    toStop.push({ projectId, butlerId });

    const events: ButlerEvent[] = [];
    subscribeButler(projectId, (e) => events.push(e), butlerId);

    ensureButlerSession({
      projectId,
      repoPath: process.cwd(),
      projectName: "Codex Observed Parse",
      backend: "codex",
    });

    sendButlerTurn(projectId, "hello", { butlerId });

    // The turn completes without error (unknown event does not break the stream).
    await waitFor("successful result", () => events.some((e) => e.type === "result" && !e.isError));

    // The unknown event was OBSERVED (counted under the codex provider), not
    // silently dropped — this is the whole point of the ticket.
    const counters = getUnknownEventCounters();
    expect(counters.counts.get("codex:turn.renamed_in_a_future_cli_v9")).toBe(1);

    // Recognized events (thread.started / item.completed / turn.completed) are NOT
    // miscounted as unknown — only the one drifted event is recorded.
    expect(counters.total).toBe(1);

    // Sanity: the butler still finished cleanly and captured the assistant text.
    const result = events.find((e) => e.type === "result");
    expect(result).toMatchObject({ type: "result", isError: false });
    expect(getButlerSession(projectId, butlerId).busy).toBe(false);
  });
});
