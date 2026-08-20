import { describe, expect, it } from "vitest";
import { resolvePublicBoardUrl, resolveRuntimeServerPort } from "../runtime-port.js";

describe("resolveRuntimeServerPort", () => {
  it("uses SERVER_PORT so worktree smoke launches match the client proxy target", () => {
    expect(resolveRuntimeServerPort({
      SERVER_PORT: "3222",
      VITE_PORT: "5394",
    })).toBe(3222);
  });

  it("prefers KANBAN_SERVER_PORT over inherited PORT fallbacks", () => {
    expect(resolveRuntimeServerPort({
      KANBAN_SERVER_PORT: "3222",
      PORT: "3001",
    })).toBe(3222);
  });

  it("prefers the explicit worktree server port over default board-port fallbacks", () => {
    expect(resolveRuntimeServerPort({
      KANBAN_WORKTREE_SERVER_PORT: "3222",
      KANBAN_BOARD_SERVER_PORT: "3001",
      KANBAN_SERVER_PORT: "3001",
      SERVER_PORT: "3001",
      PORT: "3001",
    })).toBe(3222);
  });

  it("prefers the internal dev backend port over the public proxy port", () => {
    expect(resolveRuntimeServerPort({
      KANBAN_INTERNAL_SERVER_PORT: "13001",
      KANBAN_SERVER_PORT: "3001",
      SERVER_PORT: "3001",
      PORT: "3001",
    })).toBe(13001);
  });

  it("skips invalid port values instead of masking lower-precedence fallbacks", () => {
    expect(resolveRuntimeServerPort({
      KANBAN_WORKTREE_SERVER_PORT: "not-a-port",
      KANBAN_SERVER_PORT: "3222",
    })).toBe(3222);
  });

  it("falls back to the default board server port only when no port env is set", () => {
    expect(resolveRuntimeServerPort({})).toBe(3001);
  });
});

describe("resolvePublicBoardUrl (#236 — {{boardUrl}} source)", () => {
  it("uses the PUBLIC proxy port, never the internal dev backend port", () => {
    // In dev the backend binds 13001 behind the stable proxy on 3001; clients
    // (plugin views, scripts, planners) must be handed the proxy URL.
    expect(resolvePublicBoardUrl({
      KANBAN_INTERNAL_SERVER_PORT: "13001",
      KANBAN_SERVER_PORT: "3001",
      SERVER_PORT: "3001",
      PORT: "3001",
    })).toBe("http://localhost:3001");
  });

  it("a worktree server on 3001+N produces its own URL", () => {
    expect(resolvePublicBoardUrl({
      KANBAN_WORKTREE_SERVER_PORT: "3237",
      KANBAN_SERVER_PORT: "3001",
    })).toBe("http://localhost:3237");
  });

  it("defaults to http://localhost:3001 with no port env", () => {
    expect(resolvePublicBoardUrl({})).toBe("http://localhost:3001");
  });
});
