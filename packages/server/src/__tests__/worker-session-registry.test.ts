/**
 * #887 — the worker's half. The ledger is the whole reason `unknown` is worth asking for, so
 * what these cases pin is the DISTINCTION it exists to make: an id the worker was handed and
 * an id it never was must never answer the same way, on any path.
 */
import { describe, expect, it } from "vitest";
import type { WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import { MAX_REMEMBERED, createWorkerSessionRegistry } from "../worker/worker-session-registry.js";

function harness(opts: { live?: Set<string>; pids?: Map<string, number>; stdinOpen?: Map<string, boolean> } = {}) {
  const live = opts.live ?? new Set<string>();
  const pids = opts.pids ?? new Map<string, number>();
  const stdinOpen = opts.stdinOpen;
  const sent: WorkerToBoardMessage[] = [];
  const registry = createWorkerSessionRegistry({
    isLive: (id) => live.has(id),
    pidOf: (id) => pids.get(id),
    ...(stdinOpen ? { stdinOpenOf: (id: string) => stdinOpen.get(id) } : {}),
    safeSend: (message) => void sent.push(message),
  });
  return { registry, live, pids, sent };
}

describe("createWorkerSessionRegistry", () => {
  it("answers UNKNOWN for an id it was never handed — the authoritative never-started fact", () => {
    const h = harness();
    expect(h.registry.probe("never-assigned").state).toBe("unknown");
  });

  it("answers RUNNING with the pid for a live session", () => {
    const h = harness({ live: new Set(["s1"]), pids: new Map([["s1", 4242]]) });
    h.registry.noteAssigned("s1", 1_000);
    h.registry.noteOutput("s1", 2_000);
    const answer = h.registry.probe("s1");
    expect(answer.state).toBe("running");
    expect(answer.pid).toBe(4242);
    expect(answer.lastOutputAtMs).toBeGreaterThan(answer.startedAtMs!);
  });

  it("answers RUNNING while a git-transport checkout is still provisioning, with no pid", () => {
    // The exact window the 100-minute hang sat in: assigned, no process yet, zero output.
    // Reporting `unknown` here would fail a session that is legitimately still cloning.
    const h = harness({ live: new Set(["s1"]) });
    h.registry.noteAssigned("s1");
    const answer = h.registry.probe("s1");
    expect(answer.state).toBe("running");
    expect(answer.pid).toBeUndefined();
  });

  it("answers EXITED with the code once the agent is gone", () => {
    const h = harness();
    h.registry.noteAssigned("s1");
    h.registry.noteExit("s1", 3);
    const answer = h.registry.probe("s1");
    expect(answer.state).toBe("exited");
    expect(answer.exitCode).toBe(3);
    expect(answer.exitedAtMs).toBeDefined();
  });

  it("never answers UNKNOWN for a remembered id whose spawn threw before it ever ran", () => {
    // No process, no recorded exit. The board was already told `assign_failed`; what it must
    // NOT be told is that the assignment never arrived, which is a different failure.
    const h = harness();
    h.registry.noteAssigned("s1");
    const answer = h.registry.probe("s1");
    expect(answer.state).toBe("exited");
    expect(answer.exitCode).toBeNull();
  });

  it("prefers the live process table over a recorded exit, so a re-assign is not reported dead", () => {
    const h = harness({ live: new Set(["s1"]) });
    h.registry.noteAssigned("s1");
    h.registry.noteExit("s1", 0);
    expect(h.registry.probe("s1").state).toBe("running");
  });

  it("does not restart a session's clock when the same id is assigned twice", () => {
    const h = harness();
    h.registry.noteAssigned("s1", 1_000);
    const first = h.registry.probe("s1").startedAtMs;
    h.registry.noteAssigned("s1", 2_000);
    expect(h.registry.probe("s1").startedAtMs).toBe(first);
  });

  it("bounds what it remembers, evicting oldest-first", () => {
    const h = harness();
    for (let i = 0; i < MAX_REMEMBERED + 5; i++) h.registry.noteAssigned(`s${i}`);
    expect(h.registry.size()).toBe(MAX_REMEMBERED);
    expect(h.registry.probe("s0").state).toBe("unknown"); // evicted
    expect(h.registry.probe(`s${MAX_REMEMBERED + 4}`).state).not.toBe("unknown");
  });

  it("ALWAYS answers the board, unknown included — a silent drop is the bug being fixed", () => {
    const h = harness();
    h.registry.answerProbe("never-assigned", "req-1");
    expect(h.sent).toEqual([
      { type: "session_probe_result", sessionId: "never-assigned", probe: { requestId: "req-1", state: "unknown" } },
    ]);
  });

  it("carries stdinOpen for a running session when the caller tracks it (#900)", () => {
    const h = harness({ live: new Set(["s1"]), stdinOpen: new Map([["s1", true]]) });
    h.registry.noteAssigned("s1");
    expect(h.registry.probe("s1")).toMatchObject({ state: "running", stdinOpen: true });
  });

  it("omits stdinOpen rather than guessing when the caller does not track it", () => {
    const h = harness({ live: new Set(["s1"]) });
    h.registry.noteAssigned("s1");
    expect(h.registry.probe("s1").stdinOpen).toBeUndefined();
  });

  it("echoes the requestId back so a stale answer can be told from a fresh one", () => {
    const h = harness({ live: new Set(["s1"]) });
    h.registry.noteAssigned("s1");
    h.registry.answerProbe("s1", "req-7");
    const message = h.sent[0] as Extract<WorkerToBoardMessage, { type: "session_probe_result" }>;
    expect(message.probe.requestId).toBe("req-7");
    expect(message.probe.state).toBe("running");
  });
});
