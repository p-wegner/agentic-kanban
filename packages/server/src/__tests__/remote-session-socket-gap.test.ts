// #746: a socket gap is a lost VIEW of a remote agent, not its death.
//
// Before this: `WORKER_RECONNECT_GRACE_MS` = 60s, and expiry called `finishSession`,
// which synthesized `stderr` + `exit(1)` for every session on the worker while the
// agent was still running there (confirmed live by a second agent this session). And
// the reverse hello direction — the board tracks a session on worker W, W reconnects
// and no longer lists it — was not handled at all, so those rows stayed `running`
// forever with no exit ever arriving while the worker took new work.
//
// After: two bounds with different meanings. `graceMs` REPORTS (session marked
// detached, the hold written into its own transcript, nothing finalized);
// `abandonMs` GIVES UP, and only then after landing anything the worker pushed. A
// reconnect re-adopts. A worker that reconnects WITHOUT the session is the genuinely
// ambiguous case and is decided deliberately: finalize, because a hello is positive
// information and the exit can never arrive (the worker's pending-result queue is
// in-memory and does not survive a daemon restart) — but land the pushed result
// first, and never record it as a clean success.
//
// Fails on the pre-fix code for the right reason: the grace-expiry cases assert NO
// exit event at 1.5x grace, which the old `finishSession` call cannot satisfy.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkerConnectionManager, WorkerMessageListener } from "../services/worker-connection.service.js";
import type { BoardToWorkerMessage, WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import type { AgentOutputEvent } from "../services/agent.service.js";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";

const syncCalls: Array<{ repoPath: string; branch: string }> = [];
let syncResult: { ok: boolean; status: string; error?: string } = { ok: true, status: "fast-forward" };

vi.mock("../services/worker-remote-sync.service.js", () => ({
  incomingRefFor: (branch: string) => `refs/kanban/incoming/${branch}`,
  syncIncomingBranch: async (repoPath: string, branch: string) => {
    syncCalls.push({ repoPath, branch });
    return syncResult;
  },
  clearIncomingRef: async () => {},
}));

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

const { createRemoteAgentService } = await import("../services/agent-remote.service.js");

function fakeManager(initiallyConnected: string[] = []) {
  const messageListeners: WorkerMessageListener[] = [];
  const connectListeners: Array<(id: string) => void> = [];
  const disconnectListeners: Array<(id: string) => void> = [];
  const connected = new Set(initiallyConnected);
  const sent: Array<{ workerId: string; message: BoardToWorkerMessage }> = [];
  const manager = {
    send: (workerId: string, message: BoardToWorkerMessage) => {
      if (!connected.has(workerId)) return false;
      sent.push({ workerId, message });
      return true;
    },
    isConnected: (id: string) => connected.has(id),
    connectedWorkerIds: () => [...connected],
    runningSessionIds: () => [],
    onMessage: (l: WorkerMessageListener) => { messageListeners.push(l); return () => {}; },
    onConnect: (l: (id: string) => void) => { connectListeners.push(l); return () => {}; },
    onDisconnect: (l: (id: string) => void) => { disconnectListeners.push(l); return () => {}; },
  } as unknown as WorkerConnectionManager;
  return {
    manager, sent,
    fireMessage: (workerId: string, message: WorkerToBoardMessage) =>
      messageListeners.forEach((l) => l(workerId, message)),
    fireDisconnect: (workerId: string) => {
      connected.delete(workerId);
      disconnectListeners.forEach((l) => l(workerId));
    },
    fireConnect: (workerId: string) => {
      connected.add(workerId);
      connectListeners.forEach((l) => l(workerId));
    },
  };
}

const MOCK_AGENT_COMMAND = "node fleet-mock-agent.cjs";

describe("a remote session survives a socket gap (#746)", () => {
  let db: Database;
  beforeEach(() => {
    db = createTestDb().db as unknown as Database;
    syncCalls.length = 0;
    syncResult = { ok: true, status: "fast-forward" };
  });

  function launch(
    service: ReturnType<typeof createRemoteAgentService>,
    sessionId: string,
    onOutput: (e: AgentOutputEvent) => void,
    repo?: { projectId: string; repoPath: string; branch: string; baseBranch: string },
  ) {
    return service.launch({
      worktreePath: "C:/some/worktree", sessionId, prompt: "do the ticket",
      agentArgs: undefined, onOutput, agentCommand: MOCK_AGENT_COMMAND, keepAlive: false,
      placement: { kind: "remote", workerId: "w1", ...(repo ? { repo } : {}) },
    });
  }

  it("past the grace window it REPORTS the gap and holds — no exit is synthesized", () => {
    vi.useFakeTimers();
    try {
      const fm = fakeManager(["w1"]);
      const service = createRemoteAgentService(fm.manager, db, { reconnectGraceMs: 1000, abandonMs: 60_000 });
      const events: AgentOutputEvent[] = [];
      launch(service, "s1", (e) => events.push(e));

      fm.fireDisconnect("w1");
      vi.advanceTimersByTime(1500);

      // The hold is REPORTED (into the session's own transcript) but nothing is finalized.
      expect(events.map((e) => e.type)).toEqual(["stderr"]);
      expect(events[0].data).toContain("HELD, not failed");
      expect(events.some((e) => e.type === "exit")).toBe(false);
      // And the board still considers the session live: it has no evidence of death.
      expect(service.isPidAlive("s1")).toBe(true);
      expect(service.trackedSessionIds()).toContain("s1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a reconnect AFTER the grace window re-adopts the detached session and streaming resumes", () => {
    vi.useFakeTimers();
    try {
      const fm = fakeManager(["w1"]);
      const service = createRemoteAgentService(fm.manager, db, { reconnectGraceMs: 1000, abandonMs: 60_000 });
      const events: AgentOutputEvent[] = [];
      launch(service, "s1", (e) => events.push(e));

      fm.fireDisconnect("w1");
      vi.advanceTimersByTime(1500);   // detached
      fm.fireConnect("w1");
      fm.fireMessage("w1", { type: "hello", runningSessionIds: ["s1"] } as never);
      vi.advanceTimersByTime(600_000); // long past the abandon bound — it was cancelled

      expect(events.some((e) => e.type === "exit")).toBe(false);
      expect(events.some((e) => e.type === "stderr" && String(e.data).includes("live again"))).toBe(true);

      // The callback was never torn down, so the worker's next event still lands.
      fm.fireMessage("w1", { type: "event", event: { type: "stdout", sessionId: "s1", data: "still working" } } as never);
      expect(events.some((e) => e.type === "stdout" && e.data === "still working")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up only at the abandon bound, and lands the pushed result first", async () => {
    vi.useFakeTimers();
    try {
      const fm = fakeManager(["w1"]);
      const service = createRemoteAgentService(fm.manager, db, { reconnectGraceMs: 1000, abandonMs: 10_000 });
      const events: AgentOutputEvent[] = [];
      launch(service, "s1", (e) => events.push(e), {
        projectId: "p1", repoPath: "C:/repo", branch: "feature/ak-1-x", baseBranch: "main",
      });

      fm.fireDisconnect("w1");
      vi.advanceTimersByTime(5000);
      expect(events.some((e) => e.type === "exit")).toBe(false); // still holding

      vi.advanceTimersByTime(6000);
      await vi.waitFor(() => expect(events.some((e) => e.type === "exit")).toBe(true));

      // The result the worker managed to push is landed through the #743 path, not a new one.
      expect(syncCalls).toEqual([{ repoPath: "C:/repo", branch: "feature/ak-1-x" }]);
      const exit = events.find((e) => e.type === "exit");
      expect(exit?.exitCode).toBe(1);
      expect(events.some((e) => e.type === "stderr" && String(e.data).includes("Giving"))).toBe(true);
      expect(service.trackedSessionIds()).not.toContain("s1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a worker that reconnects WITHOUT a session it was RUNNING finalizes it instead of hanging forever", async () => {
    const fm = fakeManager(["w1"]);
    const service = createRemoteAgentService(fm.manager, db, { reconnectGraceMs: 1000, abandonMs: 10_000 });
    const events: AgentOutputEvent[] = [];
    launch(service, "s1", (e) => events.push(e), {
      projectId: "p1", repoPath: "C:/repo", branch: "feature/ak-1-x", baseBranch: "main",
    });
    // The worker spoke about this session, so it demonstrably took the assign.
    fm.fireMessage("w1", { type: "event", event: { type: "stdout", sessionId: "s1", data: "working" } } as never);

    // Daemon restarted: it is back, and its hello enumerates everything it holds — no s1.
    fm.fireMessage("w1", { type: "hello", runningSessionIds: [] } as never);
    await vi.waitFor(() => expect(events.some((e) => e.type === "exit")).toBe(true));

    // Landed first (the push may well have completed), then failed — the board never
    // observed the agent's own verdict, so it is never recorded as a clean success.
    expect(syncCalls).toEqual([{ repoPath: "C:/repo", branch: "feature/ak-1-x" }]);
    expect(events.find((e) => e.type === "exit")?.exitCode).toBe(1);
    expect(events.some((e) => e.type === "stderr" && String(e.data).includes("reconnected without this session"))).toBe(true);
    expect(service.trackedSessionIds()).not.toContain("s1");
  });

  // The race the first cut of this fix introduced, caught by the worker-dispatch e2e: a
  // reconnect can cross a fresh `assign`, and the worker legitimately does not list a
  // session it has not registered yet. Acting on that hello failed work the board had
  // just dispatched. A worker DOES list provisioning sessions, so the honest window is
  // short — but it is not zero, and skipping outright would reinstate the hang for an
  // ADOPTED session, which this process has never seen an event for.
  it("a hello that crosses a fresh assign does not kill the session — it re-checks", () => {
    vi.useFakeTimers();
    try {
      const fm = fakeManager(["w1"]);
      const service = createRemoteAgentService(fm.manager, db, { assignSettleMs: 5000 });
      const events: AgentOutputEvent[] = [];
      launch(service, "s1", (e) => events.push(e));

      fm.fireMessage("w1", { type: "hello", runningSessionIds: [] } as never);
      vi.advanceTimersByTime(1000);
      expect(events.some((e) => e.type === "exit")).toBe(false);
      expect(service.trackedSessionIds()).toContain("s1");

      // It starts speaking inside the window: the hello meant nothing.
      fm.fireMessage("w1", { type: "event", event: { type: "stdout", sessionId: "s1", data: "hi" } } as never);
      vi.advanceTimersByTime(60_000);
      expect(events.some((e) => e.type === "exit")).toBe(false);
      expect(service.trackedSessionIds()).toContain("s1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a session that never speaks IS lost once the settle window passes", async () => {
    vi.useFakeTimers();
    try {
      const fm = fakeManager(["w1"]);
      const service = createRemoteAgentService(fm.manager, db, { assignSettleMs: 5000 });
      const events: AgentOutputEvent[] = [];
      launch(service, "s1", (e) => events.push(e));

      fm.fireMessage("w1", { type: "hello", runningSessionIds: [] } as never);
      vi.advanceTimersByTime(6000);
      await vi.waitFor(() => expect(events.some((e) => e.type === "exit")).toBe(true));
      expect(events.find((e) => e.type === "exit")?.exitCode).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a hello that DOES list the session leaves it completely alone", async () => {
    const fm = fakeManager(["w1"]);
    const service = createRemoteAgentService(fm.manager, db);
    const events: AgentOutputEvent[] = [];
    launch(service, "s1", (e) => events.push(e));

    fm.fireMessage("w1", { type: "hello", runningSessionIds: ["s1"] } as never);
    await new Promise((r) => setTimeout(r, 0));

    expect(events).toHaveLength(0);
    expect(fm.sent.filter((m) => m.message.type === "stop")).toHaveLength(0);
    expect(service.trackedSessionIds()).toContain("s1");
  });

  it("the reconnect grace is at least the heartbeat-stale window the board itself uses", async () => {
    const { WORKER_RECONNECT_GRACE_MS } = await import("../services/agent-remote.service.js");
    const { WORKER_HEARTBEAT_STALE_MS } = await import("../services/worker-registry.service.js");
    // 60s was shorter than the daemon's own supervisor backoff plus a reconnect, and
    // shorter than the board's own definition of an offline worker.
    expect(WORKER_RECONNECT_GRACE_MS).toBeGreaterThanOrEqual(WORKER_HEARTBEAT_STALE_MS);
  });
});

// #751's last line, which had to be wired from THIS side: a launch failure the remote
// service discovers AFTER `launch` returned must reach the dispatch proxy's
// `onDeferredLaunchFailure`, which owns the #245 host-fallback/strict rule. Flattening
// it into a synthesized exit(1) here is what made a non-strict project get a failed
// session instead of a host run.
describe("a late LAUNCH failure reaches the dispatch proxy, not the exit code (#751)", () => {
  let db: Database;
  beforeEach(() => {
    db = createTestDb().db as unknown as Database;
    syncCalls.length = 0;
  });

  function launchWithHook(
    service: ReturnType<typeof createRemoteAgentService>,
    sessionId: string,
    onOutput: (e: AgentOutputEvent) => void,
    onDeferredLaunchFailure: (f: { kind: string; reason: string }) => void,
    repo?: { projectId: string; repoPath: string; branch: string; baseBranch: string },
  ) {
    return service.launch({
      worktreePath: "C:/some/worktree", sessionId, prompt: "do the ticket",
      agentArgs: undefined, onOutput, agentCommand: MOCK_AGENT_COMMAND, keepAlive: false,
      placement: { kind: "remote", workerId: "w1", ...(repo ? { repo } : {}) },
      onDeferredLaunchFailure: onDeferredLaunchFailure as never,
    });
  }

  it("reports a git-transport dispatch failure instead of synthesizing exit(1)", async () => {
    // The worker is NOT connected, so the assign cannot be delivered — and this path
    // cannot throw, because it resolves the listener/token asynchronously.
    const fm = fakeManager([]);
    const service = createRemoteAgentService(fm.manager, db);
    const events: AgentOutputEvent[] = [];
    const failures: Array<{ kind: string; reason: string }> = [];
    launchWithHook(service, "s1", (e) => events.push(e), (f) => failures.push(f), {
      projectId: "p1", repoPath: "C:/repo", branch: "feature/ak-1-x", baseBranch: "main",
    });

    await vi.waitFor(() => expect(failures).toHaveLength(1));
    expect(failures[0].kind).toBe("dispatch");
    expect(failures[0].reason).toContain("not connected");
    // No exit was synthesized: the proxy decides host-fallback vs strict refusal.
    expect(events.some((e) => e.type === "exit")).toBe(false);
    expect(service.trackedSessionIds()).not.toContain("s1");
  });

  it("classifies an assign_failed refusal by KIND so a capacity refusal is re-placeable", async () => {
    const fm = fakeManager(["w1"]);
    const service = createRemoteAgentService(fm.manager, db);
    const events: AgentOutputEvent[] = [];
    const failures: Array<{ kind: string; reason: string }> = [];
    launchWithHook(service, "s1", (e) => events.push(e), (f) => failures.push(f));

    fm.fireMessage("w1", {
      type: "assign_failed", sessionId: "s1", error: "refused: worker already at capacity",
    } as never);

    expect(failures).toEqual([{ kind: "capacity", reason: "refused: worker already at capacity" }]);
    expect(events.some((e) => e.type === "exit")).toBe(false);
  });

  it("a provisioning refusal is named as such, and no hook still degrades to exit(1)", async () => {
    const fm = fakeManager(["w1"]);
    const service = createRemoteAgentService(fm.manager, db);
    const withHook: Array<{ kind: string }> = [];
    launchWithHook(service, "s1", () => {}, (f) => withHook.push(f));
    fm.fireMessage("w1", {
      type: "assign_failed", sessionId: "s1", error: "repo provisioning failed: clone timed out",
    } as never);
    expect(withHook.map((f) => f.kind)).toEqual(["provisioning"]);

    // Same refusal with no proxy listening: the old behaviour is still there, so a
    // direct consumer of the service never loses the failure entirely.
    const events: AgentOutputEvent[] = [];
    service.launch({
      worktreePath: "C:/some/worktree", sessionId: "s2", prompt: "p",
      agentArgs: undefined, onOutput: (e) => events.push(e),
      agentCommand: MOCK_AGENT_COMMAND, keepAlive: false,
      placement: { kind: "remote", workerId: "w1" },
    });
    fm.fireMessage("w1", { type: "assign_failed", sessionId: "s2", error: "boom" } as never);
    expect(events.map((e) => e.type)).toEqual(["stderr", "exit"]);
    expect(events[1].exitCode).toBe(1);
  });
});
