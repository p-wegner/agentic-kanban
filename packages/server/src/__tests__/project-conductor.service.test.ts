import { describe, expect, it } from "vitest";
import { parseProjectConductorConfig } from "../services/project-conductor.service.js";

describe("project conductor config", () => {
  it("treats absent and false preferences as disabled", () => {
    expect(parseProjectConductorConfig(undefined).enabled).toBe(false);
    expect(parseProjectConductorConfig("false").enabled).toBe(false);
  });

  it("supports the simple true opt-in", () => {
    expect(parseProjectConductorConfig("true")).toEqual({
      enabled: true,
      agent: "codex",
      cadenceSeconds: 1800,
    });
  });

  it("supports JSON conductor settings", () => {
    expect(parseProjectConductorConfig(JSON.stringify({
      enabled: true,
      agent: "claude",
      cadenceSeconds: 900,
    }))).toEqual({
      enabled: true,
      agent: "claude",
      cadenceSeconds: 900,
    });
  });
});
