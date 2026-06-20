import { describe, it, expect } from "vitest";
import {
  shouldDetachAgent,
  resolveLaunchPorts,
  buildAgentSpawnEnv,
  DEFAULT_BOARD_SERVER_PORT,
  DEFAULT_BOARD_CLIENT_PORT,
} from "../lib/agent-launch-env.js";

describe("shouldDetachAgent", () => {
  it("does NOT detach a shell agent on Windows (would break the stdout pipe)", () => {
    expect(shouldDetachAgent(true, "win32")).toBe(false);
  });
  it("detaches a non-shell agent on Windows", () => {
    expect(shouldDetachAgent(false, "win32")).toBe(true);
  });
  it("detaches shell agents on non-Windows platforms", () => {
    expect(shouldDetachAgent(true, "linux")).toBe(true);
    expect(shouldDetachAgent(true, "darwin")).toBe(true);
  });
});

describe("resolveLaunchPorts", () => {
  it("falls back to defaults when env + worktree ports are absent", () => {
    expect(resolveLaunchPorts({}, null)).toEqual({
      boardServerPort: DEFAULT_BOARD_SERVER_PORT,
      boardClientPort: DEFAULT_BOARD_CLIENT_PORT,
      worktreeServerPort: DEFAULT_BOARD_SERVER_PORT,
      worktreeClientPort: DEFAULT_BOARD_CLIENT_PORT,
    });
  });

  it("prefers KANBAN_SERVER_PORT/KANBAN_CLIENT_PORT over PORT/VITE_PORT", () => {
    const ports = resolveLaunchPorts({ KANBAN_SERVER_PORT: "3005", PORT: "9999", KANBAN_CLIENT_PORT: "5180", VITE_PORT: "8888" }, null);
    expect(ports.boardServerPort).toBe("3005");
    expect(ports.boardClientPort).toBe("5180");
  });

  it("falls back to PORT/VITE_PORT when the KANBAN_* vars are unset", () => {
    const ports = resolveLaunchPorts({ PORT: "3010", VITE_PORT: "5190" }, null);
    expect(ports.boardServerPort).toBe("3010");
    expect(ports.boardClientPort).toBe("5190");
  });

  it("uses worktree ports for the worktree slots, board ports for the board slots", () => {
    const ports = resolveLaunchPorts({ KANBAN_SERVER_PORT: "3001", KANBAN_CLIENT_PORT: "5173" }, { serverPort: "3007", clientPort: "5179" });
    expect(ports.boardServerPort).toBe("3001");
    expect(ports.worktreeServerPort).toBe("3007");
    expect(ports.worktreeClientPort).toBe("5179");
  });
});

describe("buildAgentSpawnEnv", () => {
  const ports = { boardServerPort: "3001", boardClientPort: "5173", worktreeServerPort: "3007", worktreeClientPort: "5179" };

  it("wires board + worktree ports onto the documented keys", () => {
    const env = buildAgentSpawnEnv({ spawnEnv: {}, ports, serverPid: "100", protectedPidsEnv: undefined, sessionId: "s1", extraEnv: undefined });
    expect(env.KANBAN_BOARD_SERVER_PORT).toBe("3001");
    expect(env.KANBAN_SERVER_PORT).toBe("3007");
    expect(env.PORT).toBe("3007");
    expect(env.VITE_PORT).toBe("5179");
    expect(env.KANBAN_WORKTREE_CLIENT_PORT).toBe("5179");
    expect(env.FORCE_COLOR).toBe("0");
    expect(env.KANBAN_SESSION_ID).toBe("s1");
    expect(env.AGENTIC_KANBAN_SESSION_ID).toBe("s1");
  });

  it("appends the board pid to the existing protected-pid list", () => {
    expect(buildAgentSpawnEnv({ spawnEnv: {}, ports, serverPid: "100", protectedPidsEnv: "55,66", sessionId: "s1", extraEnv: undefined }).KANBAN_PROTECTED_PIDS).toBe("55,66,100");
  });

  it("uses just the board pid when none were protected", () => {
    expect(buildAgentSpawnEnv({ spawnEnv: {}, ports, serverPid: "100", protectedPidsEnv: undefined, sessionId: "s1", extraEnv: undefined }).KANBAN_PROTECTED_PIDS).toBe("100");
  });

  it("lets extraEnv override later, but never the session id markers", () => {
    const env = buildAgentSpawnEnv({ spawnEnv: { FOO: "base" }, ports, serverPid: "100", protectedPidsEnv: undefined, sessionId: "s1", extraEnv: { FOO: "override", BAR: "x" } });
    expect(env.FOO).toBe("override");
    expect(env.BAR).toBe("x");
    expect(env.KANBAN_SESSION_ID).toBe("s1");
  });

  it("keeps base spawnEnv values that aren't overridden", () => {
    const env = buildAgentSpawnEnv({ spawnEnv: { ANTHROPIC_API_KEY: "sk-x" }, ports, serverPid: "1", protectedPidsEnv: undefined, sessionId: "s", extraEnv: undefined });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-x");
  });
});
