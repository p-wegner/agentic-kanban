// @covers mcp.board-call.boardApiText [contract, error-handling]
// @covers mcp.board-call.boardErrorText [contract]
//
// #684. `board-call.ts` is the shared board-API seam ~20 MCP tools call, and it had no test
// of its own (#688 lists it among the wave's untested files). The two things asserted here
// are the ones whose failure is SILENT rather than loud:
//
//  1. A body-read failure used to be `.catch(() => "")` with `ok` left true, so a truncated
//     or aborted response became an empty string that every caller read as success. For
//     `merge_workspace` that means reporting an empty SUCCESSFUL merge — the branch may not
//     have landed at all, and Conductor/monitor/butler all branch on "no error = merged".
//  2. `boardErrorText` read only `data.error`, dropping `data.detail` — the field the
//     server's `AiOperationError` branch uses to say WHY a prediction failed.
import { describe, it, expect, afterEach, vi } from "vitest";
import { boardApiText, boardErrorText } from "../board-call.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

/** A Response whose body read rejects — a truncated / aborted transfer. */
function stubUnreadableBody(status: number, statusText = "OK") {
  globalThis.fetch = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => { throw new Error("terminated"); },
  }) as unknown as Response);
}

describe("boardApiText", () => {
  it("returns the body and the status for a normal response", async () => {
    globalThis.fetch = vi.fn(async () => new Response("merged into master", { status: 200, statusText: "OK" }));
    const res = await boardApiText("/api/workspaces/w1/merge", { method: "POST" });
    expect(res).toMatchObject({ ok: true, status: 200, text: "merged into master" });
    expect(res.bodyError).toBeUndefined();
  });

  // The #684 defect: a 200 whose body cannot be read must NOT look like a successful merge.
  it("reports an unreadable body as a FAILURE, not as an empty success", async () => {
    stubUnreadableBody(200);
    const res = await boardApiText("/api/workspaces/w1/merge", { method: "POST" });

    expect(res.ok).toBe(false);
    expect(res.text).toBe("");
    expect(res.bodyError).toContain("terminated");
    // The reason must ride on statusText too, because that is what callers render.
    expect(res.statusText).toContain("body could not be read");
  });

  it("keeps the status and names the reason when an ERROR response's body is unreadable", async () => {
    stubUnreadableBody(503, "Service Unavailable");
    const res = await boardApiText("/api/projects/p1/backlog.md");

    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(res.statusText).toContain("Service Unavailable");
    expect(res.statusText).toContain("body could not be read");
  });

  it("still names the status when the response carries no statusText", async () => {
    stubUnreadableBody(500, "");
    const res = await boardApiText("/api/workspaces/w1/merge", { method: "POST" });
    expect(res.statusText).toContain("HTTP 500");
  });
});

describe("boardErrorText", () => {
  it("prefers the server's error message over the status text", () => {
    expect(boardErrorText({ error: "workspace is closed" }, "Conflict")).toBe("workspace is closed");
  });

  it("falls back to the status text for a body with no usable error", () => {
    expect(boardErrorText({}, "Not Found")).toBe("Not Found");
    expect(boardErrorText(null, "Not Found")).toBe("Not Found");
    expect(boardErrorText("plain text body", "Not Found")).toBe("Not Found");
  });

  // The array guard: several endpoints answer with a JSON array, and reading `.error` off
  // one is how a tool ends up reporting `undefined` as its error.
  it("does not read .error off a JSON array", () => {
    expect(boardErrorText([{ error: "not mine" }], "Bad Request")).toBe("Bad Request");
  });

  // #684, related half: `detail` carries the raw AI response explaining the failure.
  it("includes the detail field alongside the error", () => {
    expect(boardErrorText({ error: "AI prediction failed", detail: "model returned no JSON" }, "Internal Server Error"))
      .toBe("AI prediction failed — model returned no JSON");
  });

  it("uses detail alone when there is no error field", () => {
    expect(boardErrorText({ detail: "model returned no JSON" }, "Internal Server Error"))
      .toBe("model returned no JSON");
  });
});
