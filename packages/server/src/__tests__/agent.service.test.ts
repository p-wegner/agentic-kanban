import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock child_process before importing agent.service
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

// Mock node:fs to prevent MCP config writes from failing
vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(() => []),
}));

// Import after mocking
import { launch, kill, killAll, sendInput, closeStdin, isStdinOpen, getProcess, agentState } from "../services/agent.service.js";
import { spawn as spawnMock } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createMockProc } from "./helpers/mocks.js";

describe("agent.service", () => {
  const originalAgentCommand = process.env.AGENT_COMMAND;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AGENT_COMMAND = "mock-test-agent";
    agentState.reset();
  });

  afterEach(() => {
    agentState.reset();
    if (originalAgentCommand !== undefined) {
      process.env.AGENT_COMMAND = originalAgentCommand;
    } else {
      delete process.env.AGENT_COMMAND;
    }
  });

  describe("launch", () => {
    it("spawns a process with the AGENT_COMMAND", () => {
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);

      const onOutput = vi.fn();
      launch("/tmp/worktree", "sess-1", "test prompt", undefined, onOutput);

      expect(spawnMock).toHaveBeenCalled();
      const [cmd, _args, opts] = (spawnMock as any).mock.calls[0];
      expect(cmd).toBe("mock-test-agent");
      expect(opts.cwd).toBe("/tmp/worktree");
      expect(getProcess("sess-1")).toBe(mockProc);
    });

    it("appends context file contents to the stdin prompt for Codex", () => {
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);
      (readFileSync as any).mockReturnValue("# Ticket context\n\nPrimer");

      launch(
        "/tmp/worktree",
        "sess-codex-context",
        "test prompt",
        undefined,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "codex",
        undefined,
        undefined,
        undefined,
        undefined,
        ["/tmp/worktree/CLAUDE.local.md"],
      );

      expect(mockProc.stdin.end).toHaveBeenCalledWith(expect.stringContaining("[Attached context files]"));
      expect(mockProc.stdin.end).toHaveBeenCalledWith(expect.stringContaining("# Ticket context"));
      expect(mockProc.stdin.end).toHaveBeenCalledWith(expect.stringContaining("test prompt"));
    });

    it("passes Pi materialized skill files and hook adapter extension from the worktree", () => {
      delete process.env.AGENT_COMMAND;
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);
      (readdirSync as any).mockReturnValue([
        { name: "kanban-workflow", isDirectory: () => true },
        { name: "not-a-skill.md", isDirectory: () => false },
      ]);
      (existsSync as any).mockImplementation((path: string) =>
        path.endsWith(".pi\\plugin\\agentic-kanban-hooks.ts") ||
        path.endsWith(".pi/plugin/agentic-kanban-hooks.ts") ||
        path.endsWith(".claude\\skills\\kanban-workflow\\SKILL.md") ||
        path.endsWith(".claude/skills/kanban-workflow/SKILL.md")
      );

      launch(
        "C:\\repo\\worktree",
        "sess-pi-skills",
        "test prompt",
        undefined,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "pi",
      );

      const [, args] = (spawnMock as any).mock.calls[0];
      expect(args).toContain("--extension");
      expect(args).toContain("C:\\repo\\worktree\\.pi\\plugin\\agentic-kanban-hooks.ts");
      expect(args).toContain("--skill");
      expect(args).toContain("C:\\repo\\worktree\\.claude\\skills\\kanban-workflow\\SKILL.md");
    });

    it("registers stdout/stderr/exit handlers", () => {
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);

      const onOutput = vi.fn();
      launch("/tmp", "sess-2", "prompt", undefined, onOutput);

      expect(mockProc.stdout.on).toHaveBeenCalledWith("data", expect.any(Function));
      expect(mockProc.stderr.on).toHaveBeenCalledWith("data", expect.any(Function));
      expect(mockProc.on).toHaveBeenCalledWith("exit", expect.any(Function));
      expect(mockProc.on).toHaveBeenCalledWith("error", expect.any(Function));
    });

    it("forwards stdout data to callback", () => {
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);

      const onOutput = vi.fn();
      launch("/tmp", "sess-3", "prompt", undefined, onOutput);

      // Find the stdout data handler
      const stdoutHandler = mockProc.stdout.on.mock.calls.find(
        (c: any[]) => c[0] === "data",
      )?.[1] as (...args: unknown[]) => unknown;
      stdoutHandler(Buffer.from("output line"));

      expect(onOutput).toHaveBeenCalledWith({
        type: "stdout",
        sessionId: "sess-3",
        data: "output line",
      });
    });

    it("forwards stderr data to callback", () => {
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);

      const onOutput = vi.fn();
      launch("/tmp", "sess-4", "prompt", undefined, onOutput);

      const stderrHandler = mockProc.stderr.on.mock.calls.find(
        (c: any[]) => c[0] === "data",
      )?.[1] as (...args: unknown[]) => unknown;
      stderrHandler(Buffer.from("error msg"));

      expect(onOutput).toHaveBeenCalledWith({
        type: "stderr",
        sessionId: "sess-4",
        data: "error msg",
      });
    });

    it("emits exit event and cleans up tracking", () => {
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);

      const onOutput = vi.fn();
      launch("/tmp", "sess-5", "prompt", undefined, onOutput);

      const exitHandler = mockProc.on.mock.calls.find(
        (c: any[]) => c[0] === "exit",
      )?.[1] as (...args: unknown[]) => unknown;
      exitHandler(0, null);

      expect(onOutput).toHaveBeenCalledWith({
        type: "exit",
        sessionId: "sess-5",
        exitCode: 0,
      });
      expect(getProcess("sess-5")).toBeUndefined();
    });

    it("wraps callback errors in try/catch", () => {
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);

      let callCount = 0;
      const badCallback = vi.fn(() => {
        callCount++;
        if (callCount === 1) throw new Error("boom");
      });

      launch("/tmp", "sess-6", "prompt", undefined, badCallback);

      // Trigger stdout (which will throw) then exit (should still fire)
      const stdoutHandler = mockProc.stdout.on.mock.calls.find(
        (c: any[]) => c[0] === "data",
      )?.[1] as (...args: unknown[]) => unknown;
      stdoutHandler(Buffer.from("data"));

      const exitHandler = mockProc.on.mock.calls.find(
        (c: any[]) => c[0] === "exit",
      )?.[1] as (...args: unknown[]) => unknown;
      exitHandler(0, null);

      // Exit callback should still be called despite stdout throwing
      const exitCalls = badCallback.mock.calls.filter((c: any[]) => c[0].type === "exit");
      expect(exitCalls.length).toBe(1);
    });

    it("passes resume ID when provided for test mock", () => {
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);

      launch("/tmp", "sess-7", "prompt", undefined, vi.fn(), "claude-sess-id");

      const args = (spawnMock as any).mock.calls[0][1] as string[];
      expect(args).toContain("--resume");
      expect(args).toContain("claude-sess-id");
    });

    it("passes keepAlive flag for multi-turn mock agents", () => {
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);

      launch("/tmp", "sess-8", "prompt", undefined, vi.fn(), undefined, undefined, undefined, true);

      const args = (spawnMock as any).mock.calls[0][1] as string[];
      expect(args).toContain("--profile");
      expect(args).toContain("multi-turn");
    });

    it("writes prompt to stdin in keepAlive mode for test mock", () => {
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);

      launch("/tmp", "sess-9", "hello world", undefined, vi.fn(), undefined, undefined, undefined, true);

      expect(mockProc.stdin.write).toHaveBeenCalledWith("hello world\n");
      expect(isStdinOpen("sess-9")).toBe(true);
    });

    // Regression (#104): a keepAlive=true launch for REAL claude must still CLOSE stdin.
    // claude launches with `-p` and reads its prompt from stdin until EOF; leaving stdin
    // open (the old bug — writeInitialStdin used the caller's raw keepAlive instead of the
    // provider's keepStdinOpen) made claude.exe wait on stdin forever and emit ZERO output,
    // hanging every fix-and-merge / resolve-conflicts / reconcile session. The claude
    // provider returns keepStdinOpen=false for the real CLI, so stdin must be ended.
    it.skipIf(process.platform !== "win32")(
      "closes stdin for a keepAlive real-claude launch (no zero-output hang)",
      () => {
        delete process.env.AGENT_COMMAND;
        const mockProc = createMockProc();
        (spawnMock as any).mockReturnValue(mockProc);

        // provider=claude (12th arg), keepAlive=true (9th arg), agentCommand="claude"
        // keeps it on the shell/attached path so no detached file descriptors are needed.
        launch(
          "/tmp/wt", "sess-fam", "resolve the conflict", undefined, vi.fn(),
          undefined, "claude", undefined, true, undefined, false, "claude",
        );

        expect(mockProc.stdin.end).toHaveBeenCalledWith("resolve the conflict\n");
        expect(mockProc.stdin.write).not.toHaveBeenCalled();
        expect(isStdinOpen("sess-fam")).toBe(false);
      },
    );

    it("emits error event on process spawn failure", () => {
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);

      const onOutput = vi.fn();
      launch("/tmp", "sess-10", "prompt", undefined, onOutput);

      const errorHandler = mockProc.on.mock.calls.find(
        (c: any[]) => c[0] === "error",
      )?.[1] as (...args: unknown[]) => unknown;
      errorHandler(new Error("spawn ENOENT"));

      expect(onOutput).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "stderr",
          sessionId: "sess-10",
          data: expect.stringContaining("spawn ENOENT"),
        }),
      );
      expect(onOutput).toHaveBeenCalledWith({
        type: "exit",
        sessionId: "sess-10",
        exitCode: 1,
      });
      expect(getProcess("sess-10")).toBeUndefined();
    });

    it("sets KANBAN_SERVER_PORT in spawn environment", () => {
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);

      process.env.KANBAN_SERVER_PORT = "3005";
      launch("/tmp", "sess-11", "prompt", undefined, vi.fn());

      const opts = (spawnMock as any).mock.calls[0][2];
      expect(opts.env.KANBAN_SERVER_PORT).toBe("3005");
      expect(opts.env.KANBAN_SESSION_ID).toBe("sess-11");
      expect(opts.env.AGENTIC_KANBAN_SESSION_ID).toBe("sess-11");
      delete process.env.KANBAN_SERVER_PORT;
    });

    it("sets separate board and worktree dev ports for issue worktrees", () => {
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);

      process.env.KANBAN_SERVER_PORT = "3001";
      process.env.KANBAN_CLIENT_PORT = "5173";
      launch("C:\\andrena\\.worktrees\\feature_ak-145-workflow-analytics-drilldown", "sess-ports", "prompt", undefined, vi.fn());

      const opts = (spawnMock as any).mock.calls[0][2];
      expect(opts.env.KANBAN_BOARD_SERVER_PORT).toBe("3001");
      expect(opts.env.KANBAN_SERVER_PORT).toBe("3146");
      expect(opts.env.KANBAN_WORKTREE_SERVER_PORT).toBe("3146");
      expect(opts.env.KANBAN_CLIENT_PORT).toBe("5318");
      expect(opts.env.KANBAN_WORKTREE_CLIENT_PORT).toBe("5318");
      expect(opts.env.PORT).toBe("3146");
      expect(opts.env.SERVER_PORT).toBe("3146");
      expect(opts.env.VITE_PORT).toBe("5318");
      delete process.env.KANBAN_SERVER_PORT;
      delete process.env.KANBAN_CLIENT_PORT;
    });
  });

  describe("hang watchdog", () => {
    const originalHangTimeout = process.env.KANBAN_AGENT_HANG_TIMEOUT_MS;

    beforeEach(() => {
      // Disable the mock-agent path so the real watchdog arms, and use a small timeout.
      delete process.env.AGENT_COMMAND;
      process.env.KANBAN_AGENT_HANG_TIMEOUT_MS = "1000";
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      if (originalHangTimeout !== undefined) {
        process.env.KANBAN_AGENT_HANG_TIMEOUT_MS = originalHangTimeout;
      } else {
        delete process.env.KANBAN_AGENT_HANG_TIMEOUT_MS;
      }
    });

    it("kills the process and emits a diagnostic stderr after prolonged silence", () => {
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);
      const onOutput = vi.fn();

      // agentCommand "claude" → useShell on Windows → attached pipe mode (deterministic
      // in tests, no file watcher). isMockAgent stays false so the watchdog arms.
      launch("/tmp", "hang-1", "prompt", undefined, onOutput, undefined, "claude", undefined, undefined, undefined, undefined, "claude");
      expect(getProcess("hang-1")).toBeDefined();

      vi.advanceTimersByTime(1001);

      expect(onOutput).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "stderr",
          sessionId: "hang-1",
          data: expect.stringContaining("hang watchdog"),
        }),
      );
      // kill() removed it from tracking
      expect(getProcess("hang-1")).toBeUndefined();
    });

    it("does NOT fire if output keeps arriving (watchdog resets on activity)", () => {
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);
      const onOutput = vi.fn();

      launch("/tmp", "hang-2", "prompt", undefined, onOutput, undefined, "claude", undefined, undefined, undefined, undefined, "claude");

      const stdoutHandler = mockProc.stdout.on.mock.calls.find(
        (c: any[]) => c[0] === "data",
      )?.[1] as (...args: unknown[]) => unknown;

      // Emit output every 600ms — under the 1000ms timeout — three times.
      for (let i = 0; i < 3; i++) {
        vi.advanceTimersByTime(600);
        stdoutHandler(Buffer.from(`chunk ${i}`));
      }

      // No hang stderr emitted, process still alive.
      const hangCalls = onOutput.mock.calls.filter(
        (c: any[]) => typeof c[0]?.data === "string" && c[0].data.includes("hang watchdog"),
      );
      expect(hangCalls.length).toBe(0);
      expect(getProcess("hang-2")).toBeDefined();
    });

    it("is disabled when KANBAN_AGENT_HANG_TIMEOUT_MS=0", () => {
      process.env.KANBAN_AGENT_HANG_TIMEOUT_MS = "0";
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);
      const onOutput = vi.fn();

      launch("/tmp", "hang-3", "prompt", undefined, onOutput, undefined, "claude", undefined, undefined, undefined, undefined, "claude");
      vi.advanceTimersByTime(60_000);

      const hangCalls = onOutput.mock.calls.filter(
        (c: any[]) => typeof c[0]?.data === "string" && c[0].data.includes("hang watchdog"),
      );
      expect(hangCalls.length).toBe(0);
      expect(getProcess("hang-3")).toBeDefined();
    });
  });

  describe("kill", () => {
    it("returns false for unknown session", () => {
      expect(kill("nonexistent")).toBe(false);
    });

    it("kills a tracked process and removes it", () => {
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);

      launch("/tmp", "kill-1", "prompt", undefined, vi.fn());
      expect(getProcess("kill-1")).toBeDefined();

      const result = kill("kill-1");
      expect(result).toBe(true);
      expect(getProcess("kill-1")).toBeUndefined();
    });
  });

  describe("killAll", () => {
    it("returns 0 when no processes are running", () => {
      killAll();
      expect(killAll()).toBe(0);
    });

    it("kills all tracked processes and returns count", () => {
      (spawnMock as any).mockReturnValue(createMockProc());
      launch("/tmp", "ka-1", "prompt", undefined, vi.fn());
      launch("/tmp", "ka-2", "prompt", undefined, vi.fn());

      const count = killAll();
      expect(count).toBe(2);
      expect(getProcess("ka-1")).toBeUndefined();
      expect(getProcess("ka-2")).toBeUndefined();
    });
  });

  describe("stdin management", () => {
    it("sendInput returns false for unknown session", () => {
      expect(sendInput("unknown", "msg")).toBe(false);
    });

    it("closeStdin returns false for unknown session", () => {
      expect(closeStdin("unknown")).toBe(false);
    });

    it("isStdinOpen returns false for unknown session", () => {
      expect(isStdinOpen("unknown")).toBe(false);
    });

    it("sendInput works for keepAlive session", () => {
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);

      launch("/tmp", "stdin-1", "prompt", undefined, vi.fn(), undefined, undefined, undefined, true);
      expect(isStdinOpen("stdin-1")).toBe(true);

      const result = sendInput("stdin-1", "follow up");
      expect(result).toBe(true);
      expect(mockProc.stdin.write).toHaveBeenCalledWith(
        JSON.stringify({ type: "user", content: "follow up" }) + "\n",
      );
    });

    it("closeStdin closes stdin and marks it closed", () => {
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);

      launch("/tmp", "stdin-2", "prompt", undefined, vi.fn(), undefined, undefined, undefined, true);
      expect(isStdinOpen("stdin-2")).toBe(true);

      const result = closeStdin("stdin-2");
      expect(result).toBe(true);
      expect(mockProc.stdin.end).toHaveBeenCalled();
      expect(isStdinOpen("stdin-2")).toBe(false);
    });
  });
});
