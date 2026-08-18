import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRemoteAgentService } from "../services/agent-remote.service.js";
import type { WorkerConnectionManager, WorkerMessageListener } from "../services/worker-connection.service.js";
import type { WorkerToBoardMessage, BoardToWorkerMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import type { AgentOutputEvent } from "../services/agent.service.js";
import { createTestDb } from "./helpers/test-db.js";
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

  it("fails sessions when the worker disconnects past the grace window", async () => {
    vi.useFakeTimers();
    try {
      const fm = fakeManager(["w1"]);
      const service = createRemoteAgentService(fm.manager, db, { reconnectGraceMs: 1000 });
      const events: AgentOutputEvent[] = [];
      launchOn(service, "w1", "s1", (e) => events.push(e));

      fm.fireDisconnect("w1");
      expect(events).toHaveLength(0);
      vi.advanceTimersByTime(1500);
      expect(events.map((e) => e.type)).toEqual(["stderr", "exit"]);
      expect(events[0].data).toContain("disconnected");
      expect(events[1].exitCode).toBe(1);
    } finally {
      vi.useRealTimers();
    }
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
