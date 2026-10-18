import { describe, expect, it } from "vitest";
import { buildAgentFixBrief } from "../services/merge-train-agent-fix.js";

describe("#1602 shepherd brief: check your own work", () => {
  const brief = buildAgentFixBrief({ label: "t1", baseBranch: "master", members: [], failureMessage: "x", turn: 1 });
  it("names the stage commands to run before committing", () => {
    for (const cmd of ["pnpm check:arch", "pnpm typecheck", "vitest run", "impact.mjs select"]) expect(brief).toContain(cmd);
  });
  it("points at the fix precedents and says later stages did not run", () => {
    expect(brief).toContain("fix precedents");
    expect(brief).toContain("BASELINE_TOTAL_MS");
    expect(brief).toMatch(/did NOT run/);
  });
});
