import { describe, expect, it } from "vitest";
import { detectFirstTurnContextRise } from "../lib/first-turn-context-trend.js";
import { mapWorkspaceDetailsRow, parseFirstTurnContextTokens } from "../lib/workspace-details-projection.js";
import { parseAgentStreamLine } from "@agentic-kanban/shared/lib/agent-stream-parser";

describe("first-turn context (#1765)", () => {
  it("flags a >20% median rise and names the delta", () => {
    const r = detectFirstTurnContextRise([...Array(3).fill(23000), ...Array(3).fill(29300)], 3);
    expect(r?.deltaPct).toBe(27);
    expect(r?.message).toContain("27%");
  });
  it("is quiet for flat, short or falling series", () => {
    expect(detectFirstTurnContextRise([...Array(3).fill(100), ...Array(3).fill(110)], 3)).toBeNull();
    expect(detectFirstTurnContextRise([1, 2, 3], 3)).toBeNull();
    expect(detectFirstTurnContextRise([...Array(3).fill(300), ...Array(3).fill(100)], 3)).toBeNull();
  });
  it("reads the stat from the stats blob", () => {
    expect(parseFirstTurnContextTokens(JSON.stringify({ firstTurnContextTokens: 29325 }))).toBe(29325);
    expect(parseFirstTurnContextTokens("{nope")).toBeNull();
    expect(parseFirstTurnContextTokens(null)).toBeNull();
    expect(typeof mapWorkspaceDetailsRow).toBe("function");
  });
  it("claude parser counts cache creation in the first request size", () => {
    const evt = parseAgentStreamLine("claude", JSON.stringify({
      type: "assistant",
      message: { model: "m", content: [], usage: { input_tokens: 4, cache_creation_input_tokens: 17683, cache_read_input_tokens: 11642 } },
    }));
    expect(evt?.liveStats?.requestTokens).toBe(29329);
    expect(evt?.liveStats?.contextTokens).toBe(11646);
  });
});
