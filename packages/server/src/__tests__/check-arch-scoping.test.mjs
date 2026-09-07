// @gate:always-run when:scripts/check-arch.mjs — imports a repo script, outside this suite's own
// package import graph, exactly like `test-mine-scope-derivation.test.mjs` beside it. Scoped to
// its own subject file (#1041's `when:`) rather than left unconditional: this ticket's whole
// point is shrinking the floor every merge pays, so it would be self-defeating for its own test
// to join that floor unconditionally.
// #1052: `check:arch` runs three sub-steps of very different cost (god-modules ~5s,
// lint:arch 18-69s, mcp-catalog-parity 10-56s) but the whole script ran unconditionally at
// every gate tier — the impact tier governed `test:mine` only. This exercises the TERRITORY
// each scoped sub-step declares in `scripts/check-arch.mjs`, a repo script outside this
// suite's own import graph.
import { describe, expect, it } from "vitest";
import { stepApplies, matchesPathGlob, isArchRelevantFile, STEP_TERRITORY } from "../../../../scripts/check-arch.mjs";

describe("check:arch sub-step territory (#1052)", () => {
  it("god-modules has no territory — it always applies, diff or no diff", () => {
    expect(stepApplies("god-modules", [])).toBe(true);
    expect(stepApplies("god-modules", ["docs/README.md"])).toBe(true);
  });

  it("an UNKNOWN diff (empty changed-file list) runs every step — fail open, never fail narrow", () => {
    expect(stepApplies("lint:arch", [])).toBe(true);
    expect(stepApplies("mcp-catalog-parity", [])).toBe(true);
  });

  it("a diff that skips BOTH scoped steps: docs only, no import edge, no MCP tool/catalog touch", () => {
    const changedFiles = ["docs/state.md", "CONTINUE.md"];
    expect(stepApplies("lint:arch", changedFiles)).toBe(false);
    expect(stepApplies("mcp-catalog-parity", changedFiles)).toBe(false);
    expect(stepApplies("god-modules", changedFiles)).toBe(true);
  });

  it("a diff that skips NEITHER: touches a server import edge and an MCP tool module", () => {
    const changedFiles = [
      "packages/server/src/services/foo.service.ts",
      "packages/mcp-server/src/tools/get_issue.ts",
    ];
    expect(stepApplies("lint:arch", changedFiles)).toBe(true);
    expect(stepApplies("mcp-catalog-parity", changedFiles)).toBe(true);
  });

  it("lint:arch's territory ignores test-only changes — a test file cannot move an import edge depcruise checks", () => {
    // Mirrors `.dependency-cruiser.cjs`'s own `exclude.path` for tests/dist/drizzle/d.ts.
    const changedFiles = [
      "packages/server/src/__tests__/foo.test.ts",
      "packages/server/src/services/foo.test.ts",
    ];
    expect(stepApplies("lint:arch", changedFiles)).toBe(false);
  });

  it("mcp-catalog-parity's territory covers the catalog file and the tool registry entrypoint", () => {
    expect(stepApplies("mcp-catalog-parity", ["packages/mcp-server/src/index.ts"])).toBe(true);
    expect(stepApplies("mcp-catalog-parity", ["packages/shared/src/lib/mcp-tool-definitions.ts"])).toBe(true);
    // But not an unrelated shared lib file:
    expect(stepApplies("mcp-catalog-parity", ["packages/shared/src/lib/git-service.ts"])).toBe(false);
  });

  it("matchesPathGlob: ** spans segments, * does not (mirrors the other two copies of this matcher)", () => {
    expect(matchesPathGlob("packages/**", "packages/server/src/index.ts")).toBe(true);
    expect(matchesPathGlob("packages/mcp-server/src/tools/**", "packages/mcp-server/src/tools/get_issue.ts")).toBe(true);
    expect(matchesPathGlob("packages/mcp-server/src/tools/**", "packages/mcp-server/src/index.ts")).toBe(false);
  });

  it("isArchRelevantFile excludes exactly what depcruise's own config excludes", () => {
    expect(isArchRelevantFile("packages/server/src/__tests__/foo.test.ts")).toBe(false);
    expect(isArchRelevantFile("packages/server/src/foo.test.ts")).toBe(false);
    expect(isArchRelevantFile("packages/shared/drizzle/0001_init.sql")).toBe(false);
    expect(isArchRelevantFile("packages/shared/src/types/api.d.ts")).toBe(false);
    expect(isArchRelevantFile("packages/server/src/services/foo.service.ts")).toBe(true);
  });

  it("declares a reason for each scoped step, for the gate message", () => {
    expect(STEP_TERRITORY["lint:arch"].reason).toBeTruthy();
    expect(STEP_TERRITORY["mcp-catalog-parity"].reason).toBeTruthy();
  });
});
