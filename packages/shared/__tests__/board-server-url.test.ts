import { afterEach, describe, expect, it } from "vitest";
import { boardApiUrl, resolveBoardServerPort } from "../src/lib/board-server-url.js";

const PORT_VARS = ["KANBAN_BOARD_SERVER_PORT", "KANBAN_SERVER_PORT", "SERVER_PORT", "PORT"] as const;

function clearPortVars() {
  for (const key of PORT_VARS) delete process.env[key];
}

afterEach(() => {
  clearPortVars();
});

describe("resolveBoardServerPort", () => {
  it("defaults to 3001 when nothing is set", () => {
    clearPortVars();
    expect(resolveBoardServerPort()).toBe(3001);
  });

  it("prefers an explicit override over every env var", () => {
    clearPortVars();
    process.env.PORT = "9999";
    expect(resolveBoardServerPort("4242")).toBe(4242);
  });

  it("honours the precedence KANBAN_BOARD_SERVER_PORT > KANBAN_SERVER_PORT > SERVER_PORT > PORT", () => {
    clearPortVars();
    process.env.PORT = "1001";
    process.env.SERVER_PORT = "1002";
    process.env.KANBAN_SERVER_PORT = "1003";
    process.env.KANBAN_BOARD_SERVER_PORT = "1004";
    expect(resolveBoardServerPort()).toBe(1004);

    delete process.env.KANBAN_BOARD_SERVER_PORT;
    expect(resolveBoardServerPort()).toBe(1003);

    delete process.env.KANBAN_SERVER_PORT;
    expect(resolveBoardServerPort()).toBe(1002);

    delete process.env.SERVER_PORT;
    expect(resolveBoardServerPort()).toBe(1001);
  });

  it("falls through to env when the override is empty/unparseable", () => {
    clearPortVars();
    process.env.KANBAN_SERVER_PORT = "3123";
    expect(resolveBoardServerPort("")).toBe(3123);
    expect(resolveBoardServerPort(undefined)).toBe(3123);
  });
});

describe("boardApiUrl", () => {
  it("builds an IPv4-loopback URL, normalizing a path without a leading slash", () => {
    clearPortVars();
    expect(boardApiUrl("/api/projects", 3123)).toBe("http://127.0.0.1:3123/api/projects");
    expect(boardApiUrl("api/projects", 3123)).toBe("http://127.0.0.1:3123/api/projects");
  });
});
