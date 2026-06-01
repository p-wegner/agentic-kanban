import { describe, expect, it } from "vitest";
import { resolveRuntimeServerPort } from "../runtime-port.js";

describe("resolveRuntimeServerPort", () => {
  it("uses SERVER_PORT so worktree smoke launches match the client proxy target", () => {
    expect(resolveRuntimeServerPort({
      SERVER_PORT: "3222",
      VITE_PORT: "5394",
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

  it("falls back to the default board server port only when no port env is set", () => {
    expect(resolveRuntimeServerPort({})).toBe(3001);
  });
});
