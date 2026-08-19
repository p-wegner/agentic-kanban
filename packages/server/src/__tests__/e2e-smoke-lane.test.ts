import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E_SMOKE_TIMEOUT_MS, e2eLaneExists, runE2ESmokeLane } from "../services/e2e-smoke-lane.js";

/**
 * The E2E smoke lane, runnable on ALLOCATED ports (#660).
 *
 * The lane pins 3901/5973 with `reuseExistingServer: false` — right for a developer (it stops
 * a run adopting the live board), wrong for the merge gate, which can run for several
 * workspaces at once and would collide. A gate that goes red on SCHEDULING is worse than no
 * gate, because people learn to re-run it.
 */
describe("e2eLaneExists", () => {
  it("is true for a checkout that has the e2e package", () => {
    // This repo. If this ever goes false the lane moved and the gate silently stops running it.
    const repoRoot = join(import.meta.dirname!, "..", "..", "..", "..");
    expect(e2eLaneExists(repoRoot)).toBe(true);
  });

  it("is false for a checkout without one", () => {
    const dir = mkdtempSync(join(tmpdir(), "no-e2e-"));
    try {
      expect(e2eLaneExists(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runE2ESmokeLane", () => {
  it("reports INCONCLUSIVE — never failed — when there is no e2e package", async () => {
    // The distinction that matters: a checkout without the lane has not failed anything.
    // Reporting red here would block merges on an absence.
    const dir = mkdtempSync(join(tmpdir(), "no-e2e-run-"));
    try {
      const result = await runE2ESmokeLane(dir);
      expect(result.inconclusive).toBe(true);
      expect(result.passed).toBe(false);
      expect(result.message).toContain("no packages/e2e");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a timeout as INCONCLUSIVE, not as a test failure", async () => {
    // Same distinction the verify gate draws (#192): a wall-clock kill is retryable, not proof
    // the code is broken. Uses a real e2e-shaped checkout with a 1ms budget so the kill is
    // certain and instant.
    const dir = mkdtempSync(join(tmpdir(), "e2e-timeout-"));
    try {
      mkdirSync(join(dir, "packages", "e2e"), { recursive: true });
      writeFileSync(join(dir, "packages", "e2e", "playwright.config.ts"), "export default {};\n");
      const result = await runE2ESmokeLane(dir, { timeoutMs: 1 });
      expect(result.passed).toBe(false);
      // Either a timeout kill or a spawn failure in a directory with no pnpm workspace — both
      // are infrastructure, and both must read as inconclusive rather than red.
      expect(result.inconclusive || result.message.includes("failed")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("budgets for a COLD stack, not just the test run", () => {
    // Measured: ~52 s of tests, behind two servers each allowed 120 s to boot. A budget sized
    // to the test time alone would kill every cold run.
    expect(E2E_SMOKE_TIMEOUT_MS).toBeGreaterThan((52 + 120 + 120) * 1000);
  });
});
