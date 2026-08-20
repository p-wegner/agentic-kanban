// @covers shared.agent-stream.copilot.isError [correctness, stream-parsing]
//
// A copilot tool result is marked failed from several signals, one of them the `status`
// field. That check was `String(payload.status ?? "").toLowerCase() === "error"`, and
// `status` is untyped stream JSON — so an OBJECT-shaped status stringified to
// "[object Object]", matched neither "error" nor "failed", and a failed tool call was
// reported to the UI and the summary as a SUCCESS.
//
// Found by `@typescript-eslint/no-base-to-string` while triaging #624, not by a test —
// which is the argument for lint being a gate that runs.
import { describe, it, expect } from "vitest";
import { parseCopilotEvent } from "../src/lib/agent-stream/copilot.js";
import { createAgentStreamParseContext } from "../src/lib/agent-stream/shared.js";

function toolResult(status: unknown) {
  const obj = { type: "tool_call_completed", id: "call-1", name: "bash", status };
  const parsed = parseCopilotEvent(obj, JSON.stringify(obj), createAgentStreamParseContext());
  return parsed?.displayEvents?.find((e) => e.kind === "tool_result");
}

describe("copilot tool_result isError from `status` (#624)", () => {
  it("flags a string error status", () => {
    expect(toolResult("error")?.isError).toBe(true);
    expect(toolResult("failed")?.isError).toBe(true);
    expect(toolResult("ERROR")?.isError).toBe(true);
  });

  it("does not flag a successful status", () => {
    expect(toolResult("completed")?.isError).toBe(false);
    expect(toolResult(undefined)?.isError).toBe(false);
  });

  it("ignores a non-string status instead of stringifying it", () => {
    // Two cases, and they differ in whether behaviour actually changed:
    //
    //  - `{code:"error"}` — UNCHANGED. `String({...})` was "[object Object]", which
    //    matched nothing, so this was false before and is false now.
    //  - `["error"]` — CHANGED. Arrays stringify to their joined elements, so
    //    `String(["error"])` was exactly "error" and the old check reported isError:true.
    //    Narrowing to real strings drops that.
    //
    // The flip is deliberate and is the honest reading of an untyped field: a status the
    // parser cannot read as a string is not evidence of failure. It is recorded here
    // rather than buried because it IS a behaviour change, however unlikely the shape —
    // copilot's observed `status` is always a string, and the other signals
    // (`is_error`, `error`, `success:false`) still catch a real failure regardless.
    expect(toolResult({ code: "error" })?.isError).toBe(false);
    expect(toolResult(["error"])?.isError).toBe(false);
  });

  it("still flags an error from the other signals regardless of status shape", () => {
    const obj = { type: "tool_call_completed", id: "c2", name: "bash", status: { x: 1 }, is_error: true };
    const parsed = parseCopilotEvent(obj, JSON.stringify(obj), createAgentStreamParseContext());
    expect(parsed?.displayEvents?.find((e) => e.kind === "tool_result")?.isError).toBe(true);
  });
});
