// @gate:always-run when:scripts/test-mine.mjs
import { describe, it, expect } from "vitest";
import { PACKAGES, liftedExclusions } from "../../../../scripts/test-mine.mjs";

const server = PACKAGES.find((p) => p.label === "server");
const lifted = (files) => liftedExclusions(server, files).map((e) => e.file);

describe("test:mine lifts the CLI spawn exclusions for an intersecting diff (#1295)", () => {
  it("lifts cli-issue.test.ts when a file under src/cli/commands changes", () => {
    expect(lifted(["packages/server/src/cli/commands/issue-writes.ts"])).toContain("src/__tests__/cli-issue.test.ts");
  });
  it("keeps the exclusion for an unrelated diff or an unknown change set", () => {
    expect(lifted(["packages/server/src/services/x.service.ts", "packages/client/src/a.ts"])).toEqual([]);
    expect(lifted([])).toEqual([]);
  });
});