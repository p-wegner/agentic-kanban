import { describe, expect, it } from "vitest";
import { looksLikeMissingDepsFailure, missingDepsEvidence } from "../services/missing-deps-signature.js";

describe("missingDepsEvidence (#1493)", () => {
  it("names the line that tripped the signature", () => {
    const out = "ok line\nError: Cannot find module '@agentic-kanban/shared/dist/x.js'\nnext line";
    expect(looksLikeMissingDepsFailure(out)).toBe(true);
    expect(missingDepsEvidence(out)).toBe("Error: Cannot find module '@agentic-kanban/shared/dist/x.js'");
  });

  it("does not match the benign reaper log line (#1512)", () => {
    const out = "[services] reaper skipped — could not resolve this instance's id: db unavailable";
    expect(looksLikeMissingDepsFailure(out)).toBe(false);
    expect(missingDepsEvidence(out)).toBeNull();
  });

  it.each([
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod' imported from x.js",
    "Error: Cannot find module 'foo'",
    "Failed to resolve import \"bar\" from \"src/a.ts\"",
    "Error: Could not resolve 'vitest/config'",
  ])("still matches real resolution errors: %s", (line) => {
    expect(looksLikeMissingDepsFailure(line)).toBe(true);
  });

  it("is null when nothing matches", () => {
    expect(missingDepsEvidence("1 test failed: expected 1 to be 2")).toBeNull();
  });
});
