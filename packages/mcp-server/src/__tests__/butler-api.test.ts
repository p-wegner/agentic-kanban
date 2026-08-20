// @covers mcp.butler-api.butlerCall [contract, error-handling]
//
// #508. Ten butler tools each carried the same fetch + `!res.ok` + catch block; they now
// share `butlerCall`. Three things could have silently changed in that swap, and each is
// asserted here rather than assumed:
//
//  1. The FAILURE TEXT. Every tool has its own label ("Butler ensure error: …") and falls
//     back to the HTTP `statusText` when the error body carries no `error` field. The
//     shared `boardApi` did not return `statusText` at all, so adopting it as-is would
//     have degraded "Not Found" to nothing. It now carries it.
//  2. The ARRAY GUARD. `butler_list` answers with a JSON array on success, so reading
//     `.error` off a body is wrong for it. Only that one tool had the guard; it now lives
//     in the helper, so a future array-returning tool inherits it.
//  3. The UNREACHABLE message, which names the port an operator should check.
import { describe, it, expect, afterEach, vi } from "vitest";
import { butlerCall, butlerQuery } from "../butler-api.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

/** Stub a single board response. `body` is serialized unless it is already a string. */
function stubFetch(status: number, body: unknown, statusText = "") {
  globalThis.fetch = vi.fn(async () => new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    { status, statusText, headers: { "Content-Type": "application/json" } },
  )) as unknown as typeof fetch;
}

function textOf(res: { content: Array<{ text: string }> }): string {
  return res.content[0].text;
}

describe("butlerCall failure text (#508)", () => {
  it("prefers the server's error field, prefixed with the tool's label", async () => {
    stubFetch(400, { error: "butler is not running" });
    expect(textOf(await butlerCall("Butler ensure", "/api/x")))
      .toBe("Butler ensure error: butler is not running");
  });

  it("falls back to statusText when the error body has no error field", async () => {
    // The regression this guards: `boardApi` returned only {ok,status,data}, so a naive
    // adoption would have printed nothing (or a bare number) instead of "Not Found".
    stubFetch(404, {}, "Not Found");
    expect(textOf(await butlerCall("Butler stop", "/api/x"))).toBe("Butler stop error: Not Found");
  });

  it("does not read .error off an ARRAY body (the butler_list case)", async () => {
    stubFetch(500, [{ id: "a" }], "Internal Server Error");
    expect(textOf(await butlerCall("Butler list", "/api/x")))
      .toBe("Butler list error: Internal Server Error");
  });

  it("names the port when the board is unreachable", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const text = textOf(await butlerCall("Butler state", "/api/x"));
    expect(text).toContain("Failed to reach the butler");
    expect(text).toContain("ECONNREFUSED");
  });
});

describe("butlerCall success rendering (#508)", () => {
  it("emits compact JSON by default", async () => {
    stubFetch(200, { ok: true, sessionId: "s1" });
    expect(textOf(await butlerCall("Butler ensure", "/api/x"))).toBe('{"ok":true,"sessionId":"s1"}');
  });

  it("pretty-prints when asked, as butler_list and the skill tools do", async () => {
    stubFetch(200, { ok: true });
    expect(textOf(await butlerCall("Butler list", "/api/x", undefined, { pretty: true })))
      .toBe('{\n  "ok": true\n}');
  });

  it("uses a custom render for ask_butler, which answers with reply TEXT", async () => {
    stubFetch(200, { text: "here is your answer" });
    const res = await butlerCall("Butler", "/api/x", undefined, {
      render: (d) => String((d as { text?: string }).text ?? ""),
    });
    expect(textOf(res)).toBe("here is your answer");
  });
});

describe("butlerQuery (#508)", () => {
  it("omits the param for the default butler", () => {
    // "default" is the always-present legacy butler; the routes expect no param for it,
    // so emitting `?butler=default` would change which session is addressed.
    expect(butlerQuery(undefined)).toBe("");
    expect(butlerQuery("default")).toBe("");
  });

  it("encodes a named butler", () => {
    expect(butlerQuery("smart")).toBe("?butler=smart");
    expect(butlerQuery("a b&c")).toBe("?butler=a%20b%26c");
  });
});
