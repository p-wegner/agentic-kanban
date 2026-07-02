import { describe, it, expect } from "vitest";
import { parseCopilotEvent } from "../src/lib/agent-stream/copilot.js";
import { createAgentStreamParseContext } from "../src/lib/agent-stream/shared.js";

/**
 * #951: `extractCopilotAssistantText` used to exist in THREE places with
 * different field precedence — agent-stream/copilot.ts, session-summary.ts,
 * and server agent-provider/helpers.ts. The latter two are gone: the offline
 * summary consumes `parseCopilotEvent`, and the server fork was dead code and
 * deleted. Parity is now by construction; this test pins the UNIONED field
 * coverage on the single remaining implementation, including the shapes only
 * the deleted server fork used to handle (top-level `text` on
 * `assistant.message`, bare `content[]` arrays with no recognizable
 * type/role).
 */
function parse(obj: Record<string, unknown>) {
  return parseCopilotEvent(obj, JSON.stringify(obj), createAgentStreamParseContext());
}

describe("copilot assistant text extraction (single source, #951)", () => {
  it("extracts flat REST shapes (assistant_message with top-level text)", () => {
    expect(parse({ type: "assistant_message", text: "Done" })?.assistantText).toBe("Done");
  });

  it("extracts CLI nested shapes (assistant.message with data.content)", () => {
    expect(parse({ type: "assistant.message", data: { content: "Nested done" } })?.assistantText).toBe("Nested done");
  });

  it("extracts top-level text on assistant.message (former server-helper shape)", () => {
    expect(parse({ type: "assistant.message", text: "Flat done" })?.assistantText).toBe("Flat done");
  });

  it("joins bare content[] arrays with no recognizable type/role (former server-helper shape)", () => {
    expect(parse({ type: "x", content: [{ text: "a" }, { text: "b" }] })?.assistantText).toBe("a\nb");
  });

  it("extracts role-based assistant messages", () => {
    expect(parse({ type: "message", role: "assistant", content: "Role based" })?.assistantText).toBe("Role based");
  });

  it("never extracts user content as assistant text", () => {
    expect(parse({ type: "message", role: "user", content: "user words" })?.assistantText).toBeUndefined();
    expect(parse({ type: "user.message", data: { content: "user words" } })?.assistantText).toBeUndefined();
  });
});
