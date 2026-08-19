import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E_SMOKE_TIMEOUT_MS, decideE2ESmokeStage, e2eLaneExists, runE2ESmokeLane } from "../services/e2e-smoke-lane.js";

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

describe("decideE2ESmokeStage", () => {
  const base = { enabled: true, hasWorktree: true, docsOnly: false, laneExists: true };

  it("does NOT run when the project has not opted in — this is the default", () => {
    // The pref defaults OFF because enabling it taxes every merge on the project with ~52s
    // plus a cold two-server boot. A default that expensive has to be the operator's choice.
    expect(decideE2ESmokeStage({ ...base, enabled: false }).action).toBe("skip");
  });

  it("runs when enabled with a worktree, a code diff and a lane present", () => {
    expect(decideE2ESmokeStage(base).action).toBe("run");
  });

  it("SKIPS a docs-only diff — silently, because the check cannot have changed", () => {
    const d = decideE2ESmokeStage({ ...base, docsOnly: true });
    expect(d.action).toBe("skip");
    expect(d.reason).toContain("docs-only");
  });

  it("is INCONCLUSIVE, never a failure, when the worktree has no e2e package", () => {
    // A worktree off an older commit legitimately has no lane. Red here would block a merge
    // on an absence, which is the habit-forming flake #644 exists to prevent.
    const d = decideE2ESmokeStage({ ...base, laneExists: false });
    expect(d.action).toBe("inconclusive");
    expect(d.reason).toContain("packages/e2e");
  });

  it("is INCONCLUSIVE when there is no worktree to run in", () => {
    expect(decideE2ESmokeStage({ ...base, hasWorktree: false }).action).toBe("inconclusive");
  });

  it("prefers the docs-only skip over the missing-lane warning", () => {
    // Both conditions hold. Reporting "no packages/e2e" would put a warning on the gate for a
    // diff the lane would not have run against anyway.
    expect(decideE2ESmokeStage({ ...base, docsOnly: true, laneExists: false }).action).toBe("skip");
  });

  it("opting out wins over every other condition", () => {
    expect(
      decideE2ESmokeStage({ enabled: false, hasWorktree: false, docsOnly: false, laneExists: false }).action,
    ).toBe("skip");
  });
});
