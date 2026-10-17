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

  it("ignores a test's captured console output and board log tags (#1543)", () => {
    const out = [
      "stderr | src/__tests__/merge-verify-gate-path-coverage.test.ts > gate > logs",
      "Error: Could not resolve 'vitest/config'",
      "",
      "[pre-merge-gate] verify_script failed with a missing-deps signature for workspace 34f23546 (matched: Error: Could not resolve 'vitest/config') — retrying once",
      " Test Files  6 failed | 400 passed (406)",
    ].join("\n");
    expect(looksLikeMissingDepsFailure(out)).toBe(false);
    expect(missingDepsEvidence(out)).toBeNull();
  });

  it("ignores ANSI-coloured log lines and captured-block headers (#1570)", () => {
    const logLine =
      "\x1b[22m\x1b[39m[pre-merge-gate] verify_script failed with a missing-deps signature for workspace a995af4f (matched: Error: Could not resolve 'vitest/config') — retrying once ...";
    expect(looksLikeMissingDepsFailure(logLine)).toBe(false);
    expect(missingDepsEvidence(logLine)).toBeNull();
    const block = "\x1b[90mstderr |\x1b[39m \x1b[2msrc/a.test.ts > t\x1b[22m\nError: Could not resolve 'vitest/config'\n\nok";
    expect(looksLikeMissingDepsFailure(block)).toBe(false);
  });

  it("still matches a coloured real error (#1570)", () => {
    expect(looksLikeMissingDepsFailure("\x1b[31mError: Cannot find module 'foo'\x1b[39m")).toBe(true);
  });

  it("still matches a real error after a captured block ends", () => {
    const out = "stdout | a.test.ts > t\nhello\n\nError: Cannot find module 'foo'";
    expect(looksLikeMissingDepsFailure(out)).toBe(true);
  });

  it("is null when nothing matches", () => {
    expect(missingDepsEvidence("1 test failed: expected 1 to be 2")).toBeNull();
  });
});
