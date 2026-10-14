import { describe, expect, it } from "vitest";
import { looksLikeMissingDepsFailure, missingDepsEvidence } from "../services/missing-deps-signature.js";

describe("missingDepsEvidence (#1493)", () => {
  it("names the line that tripped the signature", () => {
    const out = "ok line\nError: Cannot find module '@agentic-kanban/shared/dist/x.js'\nnext line";
    expect(looksLikeMissingDepsFailure(out)).toBe(true);
    expect(missingDepsEvidence(out)).toBe("Error: Cannot find module '@agentic-kanban/shared/dist/x.js'");
  });

  it("is null when nothing matches", () => {
    expect(missingDepsEvidence("1 test failed: expected 1 to be 2")).toBeNull();
  });
});
