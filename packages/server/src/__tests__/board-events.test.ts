import { describe, it, expect, vi, beforeEach } from "vitest";
import { createBoardEvents } from "../services/board-events.js";

function createMockWs(readyState = 1) {
  return {
    readyState,
    send: vi.fn(),
    close: vi.fn(),
  } as any;
}

function createMockUpgradeWebSocket() {
  return (callback: any) => callback;
}

describe("board-events", () => {
  let boardEvents: ReturnType<typeof createBoardEvents>;

  beforeEach(() => {
    boardEvents = createBoardEvents(createMockUpgradeWebSocket());
  });

  describe("subscribe / unsubscribe", () => {
    it("subscribes a WS client to a project", () => {
      const ws = createMockWs();
      boardEvents.subscribe("proj-1", ws);
      // Should not throw; broadcast should reach this subscriber
      boardEvents.broadcast("proj-1", "test");
      expect(ws.send).toHaveBeenCalledTimes(1);
    });

    it("unsubscribes a WS client from a project", () => {
      const ws = createMockWs();
      boardEvents.subscribe("proj-1", ws);
      boardEvents.unsubscribe("proj-1", ws);
      boardEvents.broadcast("proj-1", "test");
      expect(ws.send).not.toHaveBeenCalled();
    });

    it("handles unsubscribe for unknown project gracefully", () => {
      const ws = createMockWs();
      expect(() => boardEvents.unsubscribe("nonexistent", ws)).not.toThrow();
    });

    it("supports multiple subscribers on the same project", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      boardEvents.subscribe("proj-1", ws1);
      boardEvents.subscribe("proj-1", ws2);
      boardEvents.broadcast("proj-1", "test");
      expect(ws1.send).toHaveBeenCalledTimes(1);
      expect(ws2.send).toHaveBeenCalledTimes(1);
    });

    it("cleans up project when last subscriber unsubscribes", () => {
      const ws = createMockWs();
      boardEvents.subscribe("proj-1", ws);
      boardEvents.unsubscribe("proj-1", ws);
      // No subscribers left; broadcast should be a no-op
      boardEvents.broadcast("proj-1", "test");
      expect(ws.send).not.toHaveBeenCalled();
    });

    it("isolates subscriptions between projects", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      boardEvents.subscribe("proj-1", ws1);
      boardEvents.subscribe("proj-2", ws2);
      boardEvents.broadcast("proj-1", "test");
      expect(ws1.send).toHaveBeenCalledTimes(1);
      expect(ws2.send).not.toHaveBeenCalled();
    });
  });

  describe("broadcast", () => {
    it("sends board_changed event to all subscribers", () => {
      const ws = createMockWs();
      boardEvents.subscribe("proj-1", ws);
      boardEvents.broadcast("proj-1", "issue_created");
      const payload = JSON.stringify({ type: "board_changed", projectId: "proj-1", reason: "issue_created" });
      expect(ws.send).toHaveBeenCalledWith(payload);
    });

    it("does not send to disconnected clients (readyState !== 1)", () => {
      const ws = createMockWs(3); // CLOSED
      boardEvents.subscribe("proj-1", ws);
      boardEvents.broadcast("proj-1", "test");
      expect(ws.send).not.toHaveBeenCalled();
    });

    it("does nothing for projects with no subscribers", () => {
      expect(() => boardEvents.broadcast("no-subs", "test")).not.toThrow();
    });
  });

  describe("broadcastActivity", () => {
    it("sends session_activity event to subscribers", () => {
      const ws = createMockWs();
      boardEvents.subscribe("proj-1", ws);
      boardEvents.broadcastActivity("proj-1", {
        issueId: "issue-1",
        sessionId: "sess-1",
        activity: "Reading file.ts",
      });
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.type).toBe("session_activity");
      expect(sent.projectId).toBe("proj-1");
      expect(sent.issueId).toBe("issue-1");
      expect(sent.sessionId).toBe("sess-1");
      expect(sent.activity).toBe("Reading file.ts");
    });
  });

  describe("broadcastLiveStats", () => {
    it("sends session_stats event with all fields", () => {
      const ws = createMockWs();
      boardEvents.subscribe("proj-1", ws);
      boardEvents.broadcastLiveStats("proj-1", "issue-1", "claude-3.5", 50000, 12, 2);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.type).toBe("session_stats");
      expect(sent.projectId).toBe("proj-1");
      expect(sent.issueId).toBe("issue-1");
      expect(sent.model).toBe("claude-3.5");
      expect(sent.contextTokens).toBe(50000);
      expect(sent.toolUses).toBe(12);
      expect(sent.subagentCount).toBe(2);
    });
  });

  describe("broadcastTodos", () => {
    it("sends session_todos event with todo items", () => {
      const ws = createMockWs();
      boardEvents.subscribe("proj-1", ws);
      const todos = [
        { id: "1", content: "Task A", status: "completed" as const, priority: "high" as const },
        { id: "2", content: "Task B", status: "in_progress" as const, priority: "medium" as const },
      ];
      boardEvents.broadcastTodos("proj-1", "issue-1", todos);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.type).toBe("session_todos");
      expect(sent.projectId).toBe("proj-1");
      expect(sent.issueId).toBe("issue-1");
      expect(sent.todos).toHaveLength(2);
      expect(sent.todos[0].content).toBe("Task A");
      expect(sent.todos[1].status).toBe("in_progress");
    });
  });

  describe("wsRoute", () => {
    it("returns a route handler that subscribes on open and unsubscribes on close", () => {
      const ws = createMockWs();
      const handler = boardEvents.wsRoute();
      const ctx = { req: { param: () => "proj-1" } };
      const result = handler(ctx);
      result.onOpen({}, ws);
      // Should be subscribed now
      boardEvents.broadcast("proj-1", "test");
      expect(ws.send).toHaveBeenCalledTimes(1);

      result.onClose({}, ws);
      // Should be unsubscribed
      boardEvents.broadcast("proj-1", "test2");
      expect(ws.send).toHaveBeenCalledTimes(1); // still 1, not 2
    });
  });
});
