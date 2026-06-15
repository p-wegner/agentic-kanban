import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

/**
 * Regression: a codex butler that resumes a thread whose on-disk rollout is gone
 * (pruned, or created under a different CODEX_HOME) used to exit code 1 on EVERY
 * turn — `codex exec ... resume <id>` writes "no rollout found for thread id" to
 * stderr and exits non-zero, and the dead thread id stayed persisted. The butler
 * now detects this, drops the resume, and retries the turn on a fresh thread —
 * mirroring the Claude butler's stale-resume recovery.
 */

// --- child_process.spawn mock ---
const spawnMock = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: string[] }>,
  /** Per-call scripts: each drives one fake process's stdout/stderr/exit. */
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
      pid: 1000 + index,
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

describe("Codex butler stale-resume recovery", () => {
  const toStop: Array<{ projectId: string; butlerId: string }> = [];

  beforeEach(() => {
    spawnMock.calls.length = 0;
    spawnMock.scripts.length = 0;
  });

  afterEach(() => {
    while (toStop.length) {
      const { projectId, butlerId } = toStop.pop()!;
      stopButlerSession(projectId, butlerId);
    }
  });

  it("drops a dead resume id and retries the turn on a fresh thread", async () => {
    // Attempt 1 (resume): codex writes the missing-rollout error to stderr, exits 1.
    spawnMock.scripts.push((h) => {
      for (const cb of h.stderr) {
        cb(Buffer.from("Error: thread/resume: thread/resume failed: no rollout found for thread id dead-thread (code -32600)"));
      }
      for (const cb of h.exit) cb(1);
    });
    // Attempt 2 (fresh, no resume): a new thread starts and the turn succeeds.
    spawnMock.scripts.push((h) => {
      emitJson(h, { type: "thread.started", thread_id: "fresh-thread-1" });
      emitJson(h, { type: "item.completed", item: { id: "i1", type: "agent_message", text: "recovered" } });
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
      projectName: "Codex Resume Recovery",
      backend: "codex",
      resumeSessionId: "dead-thread",
    });

    expect(getButlerSession(projectId, butlerId).sessionId).toBe("dead-thread");

    sendButlerTurn(projectId, "say recovered", { butlerId });

    // Two spawns: the failed resume, then the fresh retry.
    await waitFor("two spawn calls", () => spawnMock.calls.length >= 2);

    // First attempt resumed the dead thread; second did NOT include resume.
    expect(spawnMock.calls[0].args).toContain("resume");
    expect(spawnMock.calls[0].args).toContain("dead-thread");
    expect(spawnMock.calls[1].args).not.toContain("resume");

    // The turn ends successfully on the fresh thread (no exit-1 surfaced).
    await waitFor("successful result", () => events.some((e) => e.type === "result" && !e.isError));
    const result = events.find((e) => e.type === "result");
    expect(result).toMatchObject({ type: "result", isError: false });
    expect((result as { text?: string }).text).toContain("recovered");

    // The session adopted the fresh thread id; no error was broadcast.
    expect(getButlerSession(projectId, butlerId).sessionId).toBe("fresh-thread-1");
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(getButlerSession(projectId, butlerId).busy).toBe(false);
  });

  it("surfaces a non-resume failure as an error (no infinite retry)", async () => {
    // A genuine failure (not a stale resume) must still surface, and must not retry.
    spawnMock.scripts.push((h) => {
      for (const cb of h.stderr) cb(Buffer.from("Error: something else went wrong"));
      for (const cb of h.exit) cb(1);
    });

    const projectId = randomUUID();
    const butlerId = "default";
    toStop.push({ projectId, butlerId });

    const events: ButlerEvent[] = [];
    subscribeButler(projectId, (e) => events.push(e), butlerId);

    ensureButlerSession({
      projectId,
      repoPath: process.cwd(),
      projectName: "Codex Failure",
      backend: "codex",
      resumeSessionId: "some-thread",
    });

    sendButlerTurn(projectId, "do a thing", { butlerId });

    await waitFor("error result", () => events.some((e) => e.type === "result" && e.isError));
    // Only ONE spawn — no retry for a non-stale-resume failure.
    expect(spawnMock.calls.length).toBe(1);
    const result = events.find((e) => e.type === "result");
    expect((result as { text?: string }).text).toContain("exited with code 1");
  });
});
