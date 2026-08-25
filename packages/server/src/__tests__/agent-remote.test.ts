import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRemoteAgentService } from "../services/agent-remote.service.js";
import type { WorkerConnectionManager, WorkerMessageListener } from "../services/worker-connection.service.js";
import type { WorkerToBoardMessage, BoardToWorkerMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import type { AgentOutputEvent } from "../services/agent.service.js";
import { createTestDb } from "./helpers/test-db.js";
import { projects, projectStatuses, issues, workspaces, sessions, sessionMessages, workerEvents } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import type { Database } from "../db/index.js";

function fakeManager(initiallyConnected: string[] = []) {
  const messageListeners: WorkerMessageListener[] = [];
  const connectListeners: Array<(id: string) => void> = [];
  const disconnectListeners: Array<(id: string) => void> = [];
  const connected = new Set(initiallyConnected);
  const sent: Array<{ workerId: string; message: BoardToWorkerMessage }> = [];
  const manager = {
    handleOpen: () => {},
    handleMessage: () => {},
    handleClose: () => {},
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
    manager,
    sent,
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

describe("agent-remote service (worker fleet phase 1c)", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb().db as unknown as Database;
  });

  function launchOn(
    service: ReturnType<typeof createRemoteAgentService>,
    workerId: string,
    sessionId: string,
    onOutput: (e: AgentOutputEvent) => void = () => {},
    keepAlive = false,
  ) {
    return service.launch({
      worktreePath: "C:/some/worktree", sessionId, prompt: "do the ticket",
      agentArgs: undefined, onOutput,
      agentCommand: MOCK_AGENT_COMMAND, keepAlive,
      placement: { kind: "remote", workerId },
    });
  }

  it("sends an assign with a complete launch spec", () => {
    const fm = fakeManager(["w1"]);
    const service = createRemoteAgentService(fm.manager, db);
    const handle = launchOn(service, "w1", "s1");
    expect(handle).toEqual({});
    expect(fm.sent).toHaveLength(1);
    const msg = fm.sent[0].message;
    expect(msg.type).toBe("assign");
    if (msg.type !== "assign") throw new Error("unreachable");
    expect(msg.sessionId).toBe("s1");
    expect(msg.spec.command).toContain("mock-agent");
    expect(msg.spec.cwd).toBe("C:/some/worktree");
    expect(msg.spec.stdinPrompt).toContain("do the ticket");
    expect(msg.spec.env.KANBAN_SESSION_ID).toBe("s1");
    expect(msg.spec.env.KANBAN_BOARD_SERVER_PID).toBe(String(process.pid));
    expect(service.isPidAlive("s1")).toBe(true);
    expect(service.getProcess("s1")).toBeTruthy();
  });

  it("throws without a remote placement or when the worker is not connected", () => {
    const fm = fakeManager(["w1"]);
    const service = createRemoteAgentService(fm.manager, db);
    expect(() =>
      service.launch({ worktreePath: "/wt", sessionId: "s1", prompt: "p", agentArgs: undefined, onOutput: () => {} }),
    ).toThrow(/remote placement/);
    expect(() => launchOn(service, "w-gone", "s2")).toThrow(/not connected/);
  });

  it("routes worker events to the session's onOutput and clears on exit", () => {
    const fm = fakeManager(["w1"]);
    const service = createRemoteAgentService(fm.manager, db);
    const events: AgentOutputEvent[] = [];
    launchOn(service, "w1", "s1", (e) => events.push(e));

    fm.fireMessage("w1", { type: "event", event: { type: "stdout", sessionId: "s1", data: "hi" } });
    // Events from the wrong worker for this session are ignored.
    fm.fireMessage("w2", { type: "event", event: { type: "stdout", sessionId: "s1", data: "spoof" } });
    fm.fireMessage("w1", { type: "event", event: { type: "exit", sessionId: "s1", exitCode: 0 } });

    expect(events.map((e) => e.type)).toEqual(["stdout", "exit"]);
    expect(events[0].data).toBe("hi");
    expect(service.isPidAlive("s1")).toBe(false);
    expect(service.getProcess("s1")).toBeUndefined();
  });

  it("turns assign_failed into stderr + exit(1)", () => {
    const fm = fakeManager(["w1"]);
    const service = createRemoteAgentService(fm.manager, db);
    const events: AgentOutputEvent[] = [];
    launchOn(service, "w1", "s1", (e) => events.push(e));

    fm.fireMessage("w1", { type: "assign_failed", sessionId: "s1", error: "spawn ENOENT" });
    expect(events.map((e) => e.type)).toEqual(["stderr", "exit"]);
    expect(events[0].data).toContain("spawn ENOENT");
    expect(events[1].exitCode).toBe(1);
  });

  it("routes stdin controls over the socket (multi-turn only)", () => {
    const fm = fakeManager(["w1"]);
    const service = createRemoteAgentService(fm.manager, db);
    launchOn(service, "w1", "s1", () => {}, true);

    expect(service.isStdinOpen("s1")).toBe(true);
    expect(service.sendInput("s1", "follow-up")).toBe(true);
    const input = fm.sent.find((m) => m.message.type === "input");
    expect(input && input.message.type === "input" && input.message.data).toContain("follow-up");

    expect(service.closeStdin("s1")).toBe(true);
    expect(service.isStdinOpen("s1")).toBe(false);
    expect(service.sendInput("s1", "too late")).toBe(false);

    expect(service.kill("s1")).toBe(true);
    expect(fm.sent.some((m) => m.message.type === "stop")).toBe(true);
  });

  // #746: this used to assert that grace expiry FAILED the session (stderr + exit 1).
  // That was the defect, not the contract — the agent is still running on the worker,
  // so expiry now reports the gap and HOLDS; only the abandon bound finalizes.
  // The hold/re-adopt/abandon behaviour is covered in depth by
  // remote-session-socket-gap.test.ts.
  it("holds sessions past the grace window and only abandons them at the abandon bound", async () => {
    vi.useFakeTimers();
    try {
      const fm = fakeManager(["w1"]);
      const service = createRemoteAgentService(fm.manager, db, { reconnectGraceMs: 1000, abandonMs: 10_000 });
      const events: AgentOutputEvent[] = [];
      launchOn(service, "w1", "s1", (e) => events.push(e));

      fm.fireDisconnect("w1");
      expect(events).toHaveLength(0);
      vi.advanceTimersByTime(1500);
      expect(events.map((e) => e.type)).toEqual(["stderr"]);
      expect(events[0].data).toContain("HELD, not failed");

      vi.advanceTimersByTime(10_000);
      await vi.waitFor(() => expect(events.some((e) => e.type === "exit")).toBe(true));
      expect(events.find((e) => e.type === "exit")?.exitCode).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // A worker reconnecting after a board restart announces sessions this process
  // has no memory of. Stopping all of them killed an agent that had been working
  // for 65 seconds, and pre-empted its push, so the work was unrecoverable.
  describe("a reconnecting worker's unknown sessions", () => {
    async function seedSession(sessionId: string, status: string, workerId: string | null) {
      await db.insert(projects).values({ id: "p1", name: "p" }).onConflictDoNothing();
      await db.insert(projectStatuses).values({ id: "st1", projectId: "p1", name: "Todo", sortOrder: 0 }).onConflictDoNothing();
      await db.insert(issues).values({ id: "i1", title: "t", statusId: "st1", projectId: "p1" }).onConflictDoNothing();
      await db.insert(workspaces).values({ id: "ws1", issueId: "i1", branch: "feature/x" }).onConflictDoNothing();
      await db.insert(sessions).values({ id: sessionId, workspaceId: "ws1", status, workerId });
    }

    const flush = () => new Promise((r) => setTimeout(r, 0));

    it("leaves a session the DB still has running on that worker alone", async () => {
      await seedSession("live", "running", "w1");
      const fm = fakeManager(["w1"]);
      createRemoteAgentService(fm.manager, db);

      fm.fireMessage("w1", { type: "hello", runningSessionIds: ["live"] } as never);
      await flush();

      expect(fm.sent.filter((m) => m.message.type === "stop")).toHaveLength(0);
    });

    it("still stops a genuine zombie whose row is finished", async () => {
      await seedSession("dead", "completed", "w1");
      const fm = fakeManager(["w1"]);
      createRemoteAgentService(fm.manager, db);

      fm.fireMessage("w1", { type: "hello", runningSessionIds: ["dead"] } as never);
      await flush();

      const stops = fm.sent.filter((m) => m.message.type === "stop");
      expect(stops).toHaveLength(1);
      expect((stops[0].message as { sessionId: string }).sessionId).toBe("dead");
    });

    it("stops one the board has no row for at all", async () => {
      const fm = fakeManager(["w1"]);
      createRemoteAgentService(fm.manager, db);

      fm.fireMessage("w1", { type: "hello", runningSessionIds: ["ghost"] } as never);
      await flush();

      expect(fm.sent.filter((m) => m.message.type === "stop")).toHaveLength(1);
    });

    it("does not kill a running session that belongs to a different worker", async () => {
      // Reported by w1 but the DB says it runs on w2 — not w1's to keep, and the
      // stop is addressed to the worker that actually reported it.
      await seedSession("elsewhere", "running", "w2");
      const fm = fakeManager(["w1"]);
      createRemoteAgentService(fm.manager, db);

      fm.fireMessage("w1", { type: "hello", runningSessionIds: ["elsewhere"] } as never);
      await flush();

      expect(fm.sent.filter((m) => m.message.type === "stop")).toHaveLength(1);
    });
  });

  // #871 — a worker reporting a COMPLETED session whose result it still cannot push. The
  // session is long finalized, so the report must land somewhere durable: the worker's
  // event timeline, and the session's own transcript.
  describe("a worker's undelivered_result report", () => {
    async function seedFinalizedSession(sessionId: string, workerId: string) {
      await db.insert(projects).values({ id: "p1", name: "p" }).onConflictDoNothing();
      await db.insert(projectStatuses).values({ id: "st1", projectId: "p1", name: "Todo", sortOrder: 0 }).onConflictDoNothing();
      await db.insert(issues).values({ id: "i1", title: "t", statusId: "st1", projectId: "p1" }).onConflictDoNothing();
      await db.insert(workspaces).values({ id: "ws1", issueId: "i1", branch: "feature/x" }).onConflictDoNothing();
      await db.insert(sessions).values({ id: sessionId, workspaceId: "ws1", status: "failed", workerId });
    }

    const report = {
      type: "undelivered_result" as const,
      sessionId: "s-undelivered",
      branch: "feature/x",
      incomingRef: "refs/kanban/incoming/feature/x",
      checkoutPath: "C:\\worker\\checkouts\\s-undelivered",
      attempts: 7,
      lastError: "connect timeout",
    };

    it("records a worker event and stamps the finalized session's transcript", async () => {
      await seedFinalizedSession("s-undelivered", "w1");
      const fm = fakeManager(["w1"]);
      createRemoteAgentService(fm.manager, db);

      fm.fireMessage("w1", report);

      await vi.waitFor(async () => {
        const rows = await db.select().from(workerEvents).where(eq(workerEvents.type, "undelivered_result"));
        expect(rows).toHaveLength(1);
        expect(rows[0].sessionId).toBe("s-undelivered");
        expect(rows[0].summary).toContain("could not be pushed");
        expect(rows[0].summary).toContain(report.checkoutPath);
      });
      await vi.waitFor(async () => {
        const messages = await db.select().from(sessionMessages).where(eq(sessionMessages.sessionId, "s-undelivered"));
        expect(messages).toHaveLength(1);
        expect(messages[0].type).toBe("stderr");
        expect(messages[0].data).toContain("UNDELIVERED");
        expect(messages[0].data).toContain(report.checkoutPath);
        expect(messages[0].data).toContain(report.lastError);
      });
    });

    it("does not fabricate transcript rows for a session this board has no row for", async () => {
      const fm = fakeManager(["w1"]);
      createRemoteAgentService(fm.manager, db);

      fm.fireMessage("w1", { ...report, sessionId: "s-foreign" });
      await new Promise((r) => setTimeout(r, 50));

      // No session row -> nothing to stamp (an insert would violate the FK anyway); the
      // loud log and the worker-event write are the record. The worker event itself is
      // fire-and-forget and its session FK cannot hold, so no row is asserted here either.
      const messages = await db.select().from(sessionMessages).where(eq(sessionMessages.sessionId, "s-foreign"));
      expect(messages).toHaveLength(0);
    });
  });

  it("keeps sessions alive when the worker reconnects within grace", () => {
    vi.useFakeTimers();
    try {
      const fm = fakeManager(["w1"]);
      const service = createRemoteAgentService(fm.manager, db, { reconnectGraceMs: 1000 });
      const events: AgentOutputEvent[] = [];
      launchOn(service, "w1", "s1", (e) => events.push(e));

      fm.fireDisconnect("w1");
      vi.advanceTimersByTime(500);
      fm.fireConnect("w1");
      vi.advanceTimersByTime(2000);
      expect(events).toHaveLength(0);
      expect(service.isPidAlive("s1")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
