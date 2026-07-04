import { describe, it, expect } from "vitest";
import { getNodeAgentOverride } from "../src/lib/workflow-engine/node-config.js";

describe("getNodeAgentOverride", () => {
  it("returns null for missing/empty/invalid config", () => {
    expect(getNodeAgentOverride(null)).toBeNull();
    expect(getNodeAgentOverride("")).toBeNull();
    expect(getNodeAgentOverride("not json")).toBeNull();
    expect(getNodeAgentOverride(JSON.stringify({ guidance: "hi" }))).toBeNull();
    expect(getNodeAgentOverride(JSON.stringify({ agent: {} }))).toBeNull();
  });

  it("parses provider/profile/model", () => {
    const config = JSON.stringify({
      guidance: "review only",
      agent: { provider: "codex", profile: "oauth-1", model: "gpt-5.5" },
    });
    expect(getNodeAgentOverride(config)).toEqual({
      provider: "codex",
      profile: "oauth-1",
      model: "gpt-5.5",
    });
  });

  it("drops unknown providers but keeps valid fields", () => {
    const config = JSON.stringify({ agent: { provider: "gemini", model: "opus" } });
    expect(getNodeAgentOverride(config)).toEqual({ model: "opus" });
  });

  it("trims and drops empty strings", () => {
    const config = JSON.stringify({ agent: { provider: "claude", profile: "  ", model: " m1 " } });
    expect(getNodeAgentOverride(config)).toEqual({ provider: "claude", model: "m1" });
  });
});
