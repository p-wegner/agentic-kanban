import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerButlerInterrupt } from "../../tools/butler-interrupt.js";
import { registerButlerSetModel } from "../../tools/butler-set-model.js";
import { registerButlerSetProfile } from "../../tools/butler-set-profile.js";
import { registerButlerState } from "../../tools/butler-state.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;

function capture(register: (s: McpServer) => void): Handler {
  let handler: Handler | undefined;
  const fakeServer = {
    tool: (_n: string, _d: string, _s: unknown, h: Handler) => { handler = h; },
  } as unknown as McpServer;
  register(fakeServer);
  if (!handler) throw new Error("tool not registered");
  return handler;
}

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  const json = JSON.stringify(body);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(json, { status: ok ? status : 500 })));
}

describe("butler MCP tools (HTTP wrappers)", () => {
  beforeEach(() => {});
  afterEach(() => { vi.unstubAllGlobals(); });

  it("butler_interrupt POSTs /interrupt and returns the JSON", async () => {
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toMatch(/\/projects\/p1\/butler\/interrupt$/);
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const invoke = capture(registerButlerInterrupt);
    const result = await invoke({ projectId: "p1" });
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("butler_set_model POSTs the model body to /model", async () => {
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toMatch(/\/projects\/p1\/butler\/model$/);
      expect(JSON.parse(init!.body as string)).toEqual({ model: "opus" });
      return new Response(JSON.stringify({ ok: true, model: "opus", applied: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const invoke = capture(registerButlerSetModel);
    const result = await invoke({ projectId: "p1", model: "opus" });
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true, model: "opus", applied: true });
  });

  it("butler_set_profile POSTs the profile body to /profile", async () => {
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toMatch(/\/projects\/p1\/butler\/profile$/);
      expect(JSON.parse(init!.body as string)).toEqual({ profile: "work" });
      return new Response(JSON.stringify({ ok: true, profile: "work", active: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const invoke = capture(registerButlerSetProfile);
    const result = await invoke({ projectId: "p1", profile: "work" });
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true, profile: "work", active: true });
  });

  it("butler_state GETs the butler endpoint and returns the JSON", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      expect(url).toMatch(/\/projects\/p1\/butler$/);
      return new Response(JSON.stringify({ active: true, sessionId: "s1", model: "sonnet" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const invoke = capture(registerButlerState);
    const result = await invoke({ projectId: "p1" });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ active: true, sessionId: "s1", model: "sonnet" });
  });

  it("returns the server's error message on non-2xx", async () => {
    mockFetchOnce({ error: "Project not found" }, false, 404);
    const invoke = capture(registerButlerInterrupt);
    const result = await invoke({ projectId: "nope" });
    expect(result.content[0].text).toContain("Project not found");
  });

  it("returns a friendly message when the server is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const invoke = capture(registerButlerState);
    const result = await invoke({ projectId: "p1" });
    expect(result.content[0].text).toContain("Failed to reach the butler");
  });
});
