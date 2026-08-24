import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock child_process before importing agent.service
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
  // agent.service reaches the kill seam in process-exec (#833), which promisifies
  // `execFile` at module load — a missing export here fails the whole file at import.
  // Callback-style so `promisify` resolves; the stop path is fire-and-forget anyway.
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb?: (e: Error | null, o: string, r: string) => void) => {
    if (typeof cb === "function") cb(null, "", "");
  }),
}));

// Mock node:fs to prevent MCP config writes from failing
vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(() => {
    throw new Error("ENOENT");
  }),
  openSync: vi.fn(() => 0),
  closeSync: vi.fn(),
  readSync: vi.fn(() => 0),
  unlinkSync: vi.fn(),
  appendFileSync: vi.fn(),
}));

// Fake docker runner (#154) — asserts the container kill leg without shelling out.
vi.mock("@agentic-kanban/shared/lib/docker-exec", () => ({
  dockerExec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
}));

// #167: spy on the version guard so tests can assert WHICH command it was asked
// to check, without actually shelling out to `--version`.
vi.mock("../services/agent-cli-version.service.js", () => ({
  warnIfCliVersionRisky: vi.fn(async () => null),
}));

// Import after mocking
import { launch, kill, killAll, sendInput, closeStdin, isStdinOpen, getProcess, agentState } from "../services/agent.service.js";
import { spawn as spawnMock } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dockerExec as dockerExecMock } from "@agentic-kanban/shared/lib/docker-exec";
import { warnIfCliVersionRisky as warnIfCliVersionRiskyMock } from "../services/agent-cli-version.service.js";
import { createMockProc } from "./helpers/mocks.js";
import type { ContainerProvision } from "../services/devcontainer-workspace.service.js";
import { join, sep } from "node:path";
import { shouldDetachAgent } from "../lib/agent-launch-env.js";

/**
 * Whether THIS platform gives a non-shell agent real stdout/stderr PIPES (#828).
 *
 * A detached agent's stdio goes to the session .out/.err FILES, so
 * `proc.stdout.on("data", ...)` is never registered. `shouldDetachAgent` keeps an agent
 * attached ONLY when it uses a shell AND runs on Windows — and the mock/AGENT_COMMAND
 * agent these tests launch always uses a shell. So the pipe assertions below hold on
 * Windows and cannot hold anywhere else, which nobody had seen until CI first ran this
 * suite on Linux. The detached wiring is asserted separately by "wires stdio per the
 * platform's detach decision", which runs everywhere and derives the expectation from the
 * actual launch config.
 */
const AGENT_STDIO_IS_PIPED = !shouldDetachAgent(true, process.platform);

function makeContainerProvision(containerId: string): ContainerProvision {
  return {
    handle: { containerId, remoteUser: "node", remoteWorkspaceFolder: "/workspaces/wt" },
    pathMappings: [],
    dependencyVolumes: [],
    containerEnv: {},
  };
}

/**
 * A `Dirent` stub carrying EVERY predicate `couldHoldSkill`
 * (`packages/shared/src/lib/agent-skill-files.ts`) calls — currently `isDirectory` and
 * `isSymbolicLink` (#664).
 *
 * The literal `{ name, isDirectory }` objects this replaces threw
 * `entry.isSymbolicLink is not a function` the moment that predicate was widened to follow
 * a junctioned PLUGIN skill — readdir reports a junction as a symlink, never a directory.
 * One factory means the next predicate has one place to be taught instead of N literals.
 */
function dirent(name: string, opts: { directory?: boolean; symlink?: boolean } = {}) {
  return {
    name,
    isDirectory: () => opts.directory ?? false,
    isSymbolicLink: () => opts.symlink ?? false,
  };
}

describe("agent.service", () => {
  const originalAgentCommand = process.env.AGENT_COMMAND;

  // #674 — these tests set ONE port var and assert what the child is launched with, so they
  // only hold in an environment carrying no OTHER KANBAN_* port vars. That is not the
  // environment the pre-merge gate runs in: the gate runs inside a worktree spawned by the
  // board, whose env carries KANBAN_BOARD_SERVER_PORT (how a worktree names the MAIN board)
  // plus the derived KANBAN_WORKTREE_* pair. resolveLaunchPorts reads BOARD_SERVER_PORT first
  // by design (#615), so `sets KANBAN_SERVER_PORT in spawn environment` got the board's 3001
  // instead of its own 3005 and failed — deterministically, for EVERY branch, while passing in
  // any clean shell. That non-hermetic pair was one of the two reasons no merge could land on
  // this board. The production ladder is right; the test just has to own its environment.
  const AMBIENT_PORT_VARS = [
    "KANBAN_BOARD_SERVER_PORT",
    "KANBAN_BOARD_CLIENT_PORT",
    "KANBAN_WORKTREE_SERVER_PORT",
    "KANBAN_WORKTREE_CLIENT_PORT",
    "KANBAN_SERVER_PORT",
    "KANBAN_CLIENT_PORT",
    "SERVER_PORT",
    "PORT",
    "VITE_PORT",
  ] as const;
  const savedPortVars: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of AMBIENT_PORT_VARS) {
      savedPortVars[key] = process.env[key];
      delete process.env[key];
    }
    process.env.AGENT_COMMAND = "mock-test-agent";
    agentState.reset();
  });

  afterEach(() => {
    agentState.reset();
    for (const key of AMBIENT_PORT_VARS) {
      if (savedPortVars[key] === undefined) delete process.env[key];
      else process.env[key] = savedPortVars[key];
    }
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
      launch({
        worktreePath: "/tmp/worktree",
        sessionId: "sess-1",
        prompt: "test prompt",
        agentArgs: undefined,
        onOutput: onOutput,
      });

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

      launch({
        worktreePath: "/tmp/worktree",
        sessionId: "sess-codex-context",
        prompt: "test prompt",
        agentArgs: undefined,
        onOutput: vi.fn(),
        provider: "codex",
        contextFiles: ["/tmp/worktree/CLAUDE.local.md"],
      });

      expect(mockProc.stdin.end).toHaveBeenCalledWith(expect.stringContaining("[Attached context files]"));
      expect(mockProc.stdin.end).toHaveBeenCalledWith(expect.stringContaining("# Ticket context"));
      expect(mockProc.stdin.end).toHaveBeenCalledWith(expect.stringContaining("test prompt"));
    });

    it("passes Pi materialized skill files and hook adapter extension from the worktree", () => {
      delete process.env.AGENT_COMMAND;
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);
      (readdirSync as any).mockReturnValue([
        dirent("kanban-workflow", { directory: true }),
        dirent("not-a-skill.md"),
      ]);
      (existsSync as any).mockImplementation((path: string) =>
        path.endsWith(".pi\\plugin\\agentic-kanban-hooks.ts") ||
        path.endsWith(".pi/plugin/agentic-kanban-hooks.ts") ||
        path.endsWith(".claude\\skills\\kanban-workflow\\SKILL.md") ||
        path.endsWith(".claude/skills/kanban-workflow/SKILL.md")
      );

      // The worktree root takes the host's own absolute shape, and each expected argument
      // is built with the host's `join` (#828). A `C:\repo\worktree` literal plus
      // backslash-joined expectations only agree with `node:path` on Windows; off it the
      // service joins with "/" and the assertions could never match.
      const worktree = sep === "\\" ? "C:\\repo\\worktree" : "/repo/worktree";
      launch({
        worktreePath: worktree,
        sessionId: "sess-pi-skills",
        prompt: "test prompt",
        agentArgs: undefined,
        onOutput: vi.fn(),
        provider: "pi",
      });

      const [, args] = (spawnMock as any).mock.calls[0];
      expect(args).toContain("--extension");
      expect(args).toContain(join(worktree, ".pi", "plugin", "agentic-kanban-hooks.ts"));
      expect(args).toContain("--skill");
      expect(args).toContain(join(worktree, ".claude", "skills", "kanban-workflow", "SKILL.md"));
    });

    it.runIf(AGENT_STDIO_IS_PIPED)("registers stdout/stderr/exit handlers", () => {
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);

      const onOutput = vi.fn();
      launch({
        worktreePath: "/tmp",
        sessionId: "sess-2",
        prompt: "prompt",
        agentArgs: undefined,
        onOutput: onOutput,
      });

      expect(mockProc.stdout.on).toHaveBeenCalledWith("data", expect.any(Function));
      expect(mockProc.stderr.on).toHaveBeenCalledWith("data", expect.any(Function));
      expect(mockProc.on).toHaveBeenCalledWith("exit", expect.any(Function));
      expect(mockProc.on).toHaveBeenCalledWith("error", expect.any(Function));
    });

    it.runIf(AGENT_STDIO_IS_PIPED)("forwards stdout data to callback", () => {
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);

      const onOutput = vi.fn();
      launch({
        worktreePath: "/tmp",
        sessionId: "sess-3",
        prompt: "prompt",
        agentArgs: undefined,
        onOutput: onOutput,
      });

      // Find the stdout data handler
      const stdoutHandler = vi.mocked(mockProc.stdout.on).mock.calls.find(
        (c: any[]) => c[0] === "data",
      )?.[1] as (...args: unknown[]) => unknown;
      stdoutHandler(Buffer.from("output line"));

      expect(onOutput).toHaveBeenCalledWith({
        type: "stdout",
        sessionId: "sess-3",
        data: "output line",
      });
    });

    it.runIf(AGENT_STDIO_IS_PIPED)("forwards stderr data to callback", () => {
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);

      const onOutput = vi.fn();
      launch({
        worktreePath: "/tmp",
        sessionId: "sess-4",
        prompt: "prompt",
        agentArgs: undefined,
        onOutput: onOutput,
      });

      const stderrHandler = vi.mocked(mockProc.stderr.on).mock.calls.find(
        (c: any[]) => c[0] === "data",
      )?.[1] as (...args: unknown[]) => unknown;
      stderrHandler(Buffer.from("error msg"));

      expect(onOutput).toHaveBeenCalledWith({
        type: "stderr",
        sessionId: "sess-4",
        data: "error msg",
      });
    });

    it("wires stdio per the platform's detach decision", () => {
      // The half of the output wiring that IS platform-independent, and the only coverage
      // the DETACHED path (every non-shell agent, i.e. the whole Linux/CI fleet) had (#828):
      // a detached agent must be spawned detached with its stdout on a real file
      // descriptor, an attached one with pipes.
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);

      launch({
        worktreePath: "/tmp",
        sessionId: "sess-stdio",
        prompt: "prompt",
        agentArgs: undefined,
        onOutput: vi.fn(),
      });

      const [, , opts] = (spawnMock as any).mock.calls[0];
      const [, out, err] = opts.stdio as unknown[];
      // Derived from the ACTUAL launch config, not assumed — `shouldDetachAgent` is a
      // function of `useShell` as well as the platform.
      if (!shouldDetachAgent(Boolean(opts.shell), process.platform)) {
        expect(opts.detached).toBe(false);
        expect(out).toBe("pipe");
        expect(err).toBe("pipe");
      } else {
        expect(opts.detached).toBe(true);
        expect(typeof out).toBe("number");
        expect(err === "ignore" || typeof err === "number").toBe(true);
      }
    });

    it("emits exit event and cleans up tracking", () => {
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);

      const onOutput = vi.fn();
      launch({
        worktreePath: "/tmp",
        sessionId: "sess-5",
        prompt: "prompt",
        agentArgs: undefined,
        onOutput: onOutput,
      });

      const exitHandler = vi.mocked(mockProc.on).mock.calls.find(
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

    it.runIf(AGENT_STDIO_IS_PIPED)("wraps callback errors in try/catch", () => {
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);

      let callCount = 0;
      const badCallback = vi.fn(() => {
        callCount++;
        if (callCount === 1) throw new Error("boom");
      });

      launch({
        worktreePath: "/tmp",
        sessionId: "sess-6",
        prompt: "prompt",
        agentArgs: undefined,
        onOutput: badCallback,
      });

      // Trigger stdout (which will throw) then exit (should still fire)
      const stdoutHandler = vi.mocked(mockProc.stdout.on).mock.calls.find(
        (c: any[]) => c[0] === "data",
      )?.[1] as (...args: unknown[]) => unknown;
      stdoutHandler(Buffer.from("data"));

      const exitHandler = vi.mocked(mockProc.on).mock.calls.find(
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

      launch({
        worktreePath: "/tmp",
        sessionId: "sess-7",
        prompt: "prompt",
        agentArgs: undefined,
        onOutput: vi.fn(),
        providerSessionId: "claude-sess-id",
      });

      const args = (spawnMock as any).mock.calls[0][1] as string[];
      expect(args).toContain("--resume");
      expect(args).toContain("claude-sess-id");
    });

    it("passes keepAlive flag for multi-turn mock agents", () => {
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);

      launch({
        worktreePath: "/tmp",
        sessionId: "sess-8",
        prompt: "prompt",
        agentArgs: undefined,
        onOutput: vi.fn(),
        keepAlive: true,
      });

      const args = (spawnMock as any).mock.calls[0][1] as string[];
      expect(args).toContain("--profile");
      expect(args).toContain("multi-turn");
    });

    it("writes prompt to stdin in keepAlive mode for test mock", () => {
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);

      launch({
        worktreePath: "/tmp",
        sessionId: "sess-9",
        prompt: "hello world",
        agentArgs: undefined,
        onOutput: vi.fn(),
        keepAlive: true,
      });

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
        launch({
          worktreePath: "/tmp/wt",
          sessionId: "sess-fam",
          prompt: "resolve the conflict",
          agentArgs: undefined,
          onOutput: vi.fn(),
          agentCommand: "claude",
          keepAlive: true,
          planMode: false,
          provider: "claude-code",
        });

        expect(mockProc.stdin.end).toHaveBeenCalledWith("resolve the conflict\n");
        expect(mockProc.stdin.write).not.toHaveBeenCalled();
        expect(isStdinOpen("sess-fam")).toBe(false);
      },
    );

    it("emits error event on process spawn failure", () => {
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);

      const onOutput = vi.fn();
      launch({
        worktreePath: "/tmp",
        sessionId: "sess-10",
        prompt: "prompt",
        agentArgs: undefined,
        onOutput: onOutput,
      });

      const errorHandler = vi.mocked(mockProc.on).mock.calls.find(
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
      launch({
        worktreePath: "/tmp",
        sessionId: "sess-11",
        prompt: "prompt",
        agentArgs: undefined,
        onOutput: vi.fn(),
      });

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
      launch({
        worktreePath: "C:\\andrena\\.worktrees\\feature_ak-145-workflow-analytics-drilldown",
        sessionId: "sess-ports",
        prompt: "prompt",
        agentArgs: undefined,
        onOutput: vi.fn(),
      });

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
      launch({
        worktreePath: "/tmp",
        sessionId: "hang-1",
        prompt: "prompt",
        agentArgs: undefined,
        onOutput: onOutput,
        agentCommand: "claude",
        provider: "claude-code",
      });
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

    it.runIf(AGENT_STDIO_IS_PIPED)("does NOT fire if output keeps arriving (watchdog resets on activity)", () => {
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);
      const onOutput = vi.fn();

      launch({
        worktreePath: "/tmp",
        sessionId: "hang-2",
        prompt: "prompt",
        agentArgs: undefined,
        onOutput: onOutput,
        agentCommand: "claude",
        provider: "claude-code",
      });

      const stdoutHandler = vi.mocked(mockProc.stdout.on).mock.calls.find(
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

      launch({
        worktreePath: "/tmp",
        sessionId: "hang-3",
        prompt: "prompt",
        agentArgs: undefined,
        onOutput: onOutput,
        agentCommand: "claude",
        provider: "claude-code",
      });
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

      launch({
        worktreePath: "/tmp",
        sessionId: "kill-1",
        prompt: "prompt",
        agentArgs: undefined,
        onOutput: vi.fn(),
      });
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
      launch({
        worktreePath: "/tmp",
        sessionId: "ka-1",
        prompt: "prompt",
        agentArgs: undefined,
        onOutput: vi.fn(),
      });
      launch({
        worktreePath: "/tmp",
        sessionId: "ka-2",
        prompt: "prompt",
        agentArgs: undefined,
        onOutput: vi.fn(),
      });

      const count = killAll();
      expect(count).toBe(2);
      expect(getProcess("ka-1")).toBeUndefined();
      expect(getProcess("ka-2")).toBeUndefined();
    });
  });

  // #154: stopSession/hang-kill/killAll used to kill only the host docker-exec
  // CLIENT for a containerized session, orphaning the exec'd agent inside the
  // container — invisible, still able to edit the bind-mounted worktree. kill()
  // and killAll() must also reach the container itself.
  describe("containerized sessions (#154)", () => {
    beforeEach(() => {
      // isMockAgent is derived from AGENT_COMMAND being set — disable it so the
      // container-wrap path actually runs (mock agents are never containerized).
      delete process.env.AGENT_COMMAND;
    });

    it("kill() sends docker kill to the container in addition to the host client", () => {
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);
      const containerProvision = makeContainerProvision("container-abc123");

      launch({
        worktreePath: "/tmp",
        sessionId: "sess-container-1",
        prompt: "prompt",
        agentArgs: undefined,
        onOutput: vi.fn(),
        agentCommand: "claude",
        provider: "claude-code",
        containerProvision: containerProvision,
      });

      const result = kill("sess-container-1");

      expect(result).toBe(true);
      expect(dockerExecMock).toHaveBeenCalledWith(["kill", "container-abc123"]);
      // Host leg still fires (the docker-exec client itself is also cleaned up).
      expect(getProcess("sess-container-1")).toBeUndefined();
    });

    it("killAll() sends docker kill for every containerized session", () => {
      (spawnMock as any).mockReturnValue(createMockProc());
      launch({
        worktreePath: "/tmp",
        sessionId: "sess-container-2",
        prompt: "prompt",
        agentArgs: undefined,
        onOutput: vi.fn(),
        agentCommand: "claude",
        provider: "claude-code",
        containerProvision: makeContainerProvision("container-def456"),
      });
      launch({
        worktreePath: "/tmp",
        sessionId: "sess-host-only",
        prompt: "prompt",
        agentArgs: undefined,
        onOutput: vi.fn(),
      });

      const count = killAll();

      expect(count).toBe(2);
      expect(dockerExecMock).toHaveBeenCalledWith(["kill", "container-def456"]);
      expect(dockerExecMock).toHaveBeenCalledTimes(1);
    });

    it("does NOT touch docker for a host (non-container) session stop", () => {
      const mockProc = createMockProc();
      (spawnMock as any).mockReturnValue(mockProc);

      launch({
        worktreePath: "/tmp",
        sessionId: "sess-host-1",
        prompt: "prompt",
        agentArgs: undefined,
        onOutput: vi.fn(),
      });
      const result = kill("sess-host-1");

      expect(result).toBe(true);
      expect(dockerExecMock).not.toHaveBeenCalled();
    });

    // #167 leak 1: the version guard used to run on the WRAPPED command, so a
    // containerized launch version-checked `docker` as if it were the agent CLI.
    it("version-checks the pre-wrap agent CLI command, not the wrapped `docker`", () => {
      (spawnMock as any).mockReturnValue(createMockProc());

      launch({
        worktreePath: "/tmp",
        sessionId: "sess-container-version",
        prompt: "prompt",
        agentArgs: undefined,
        onOutput: vi.fn(),
        agentCommand: "claude",
        provider: "claude-code",
        containerProvision: makeContainerProvision("container-version1"),
      });

      expect(warnIfCliVersionRiskyMock).toHaveBeenCalledTimes(1);
      const [, checkedCommand] = (warnIfCliVersionRiskyMock as any).mock.calls[0];
      expect(checkedCommand).toBe("claude");
      expect(checkedCommand).not.toBe("docker");
    });

    // #167 leak 2: env assembled AFTER the wrap (ports/extraEnv/session vars)
    // used to land only on the host docker-exec client, never inside the
    // container, because the wrap's `-e` allowlist was computed from the
    // provider's base env before that later env was layered on. The full env
    // must now be computed BEFORE the wrap so it shows up in the `-e` flags.
    it("carries session/extraEnv vars into the container's `-e` allowlist, not just the host docker client", () => {
      (spawnMock as any).mockReturnValue(createMockProc());

      launch({
        worktreePath: "/tmp",
        sessionId: "sess-container-env",
        prompt: "prompt",
        agentArgs: undefined,
        onOutput: vi.fn(),
        agentCommand: "claude",
        provider: "claude-code",
        extraEnv: { KANBAN_CUSTOM_TEST: "abc123" },
        containerProvision: makeContainerProvision("container-env1"),
      });

      const [cmd, args, opts] = (spawnMock as any).mock.calls[0];
      expect(cmd).toBe("docker");
      expect(args).toContain("-e");
      expect(args).toContain("KANBAN_SESSION_ID=sess-container-env");
      expect(args).toContain("KANBAN_CUSTOM_TEST=abc123");
      // The docker CLIENT process itself no longer needs the full env — it all
      // travels inside the container via -e flags now.
      expect(opts.env).toEqual({});
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

      launch({
        worktreePath: "/tmp",
        sessionId: "stdin-1",
        prompt: "prompt",
        agentArgs: undefined,
        onOutput: vi.fn(),
        keepAlive: true,
      });
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

      launch({
        worktreePath: "/tmp",
        sessionId: "stdin-2",
        prompt: "prompt",
        agentArgs: undefined,
        onOutput: vi.fn(),
        keepAlive: true,
      });
      expect(isStdinOpen("stdin-2")).toBe(true);

      const result = closeStdin("stdin-2");
      expect(result).toBe(true);
      expect(mockProc.stdin.end).toHaveBeenCalled();
      expect(isStdinOpen("stdin-2")).toBe(false);
    });
  });
});
