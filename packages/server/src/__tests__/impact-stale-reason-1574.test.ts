import { describe, expect, it } from "vitest";
import { impactStaleLogLine } from "../services/test-impact-outcome.service.js";
import { parseSelection } from "../services/test-impact-outcome/select-payload.js";

const payload = (extra: Record<string, unknown>) =>
  JSON.stringify({ tier: "impact", selected: [{ file: "a.test.ts" }], changed: ["a.ts"], ...extra });

describe("#1574 stale reason", () => {
  it("parses the tool's staleReason and newTests", () => {
    const sel = parseSelection(
      payload({ stale: true, staleReason: "diff-adds-tests", newTests: ["x.test.ts", 3] }),
    );
    expect(sel?.staleReason).toBe("diff-adds-tests");
    expect(sel?.newTests).toEqual(["x.test.ts"]);
  });

  it("a train adding tests keeps its tier and says no rebuild is needed", () => {
    const line = impactStaleLogLine("/w/train", {
      tier: "impact",
      staleReason: "diff-adds-tests",
      newTests: ["a.test.ts", "b.test.ts"],
    });
    expect(line).toContain("2 test file(s)");
    expect(line).toContain("no rebuild needed");
    expect(line).not.toContain("Rebuild it");
  });

  it("map behind base (or an unknown reason) keeps the rebuild remedy", () => {
    expect(impactStaleLogLine("/w", { tier: "all", staleReason: "map-behind-base" })).toContain("map behind base");
    expect(impactStaleLogLine("/w", { tier: "all" })).toContain("Rebuild it");
  });
});
