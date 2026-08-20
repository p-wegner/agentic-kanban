import { describe, expect, it } from "vitest";
import { createTestDb } from "./helpers/test-db.js";
import { createProjectDirectly } from "./helpers/api-test-helpers.js";
import { recordBaseBranchHealth, countBaseBranchHealthOutcomes } from "../repositories/base-branch-health.repository.js";
import {
  DEGENERATE_BASE_HEALTH_MIN_PROBES,
  isDegenerateBaseHealth,
  scanDegenerateBaseHealth,
} from "../services/degenerate-base-health.js";

/**
 * #681 — nothing asked "has this base-health probe EVER been green?".
 *
 * Measured on this board: 200 probes, 199 red + 1 timeout, 0 green, over five days, with reds
 * that were unmistakable install artifacts. Every consumer read only the LATEST row, where "red
 * again" and "this probe cannot produce a green" look identical — and the answer was USED, to
 * blame branches and withhold merges. Roughly half of all recorded verdicts were false.
 */
describe("degenerate base-health distribution alarm (#681)", () => {
  const counts = (green: number, red: number, timeout = 0, unverified = 0) => ({
    byOutcome: { green, red, timeout, unverified },
  });

  it("is degenerate only with enough CONCLUSIVE probes and zero greens", () => {
    const n = DEGENERATE_BASE_HEALTH_MIN_PROBES;
    expect(isDegenerateBaseHealth(counts(0, n)).degenerate).toBe(true);
    expect(isDegenerateBaseHealth(counts(0, n - 1, 1)).degenerate).toBe(true); // timeouts count
    expect(isDegenerateBaseHealth(counts(0, n - 1)).degenerate).toBe(false); // a bad afternoon
    expect(isDegenerateBaseHealth(counts(1, n * 10)).degenerate).toBe(false); // one green is enough
  });

  it("does NOT count `unverified` rows toward the threshold", () => {
    // `unverified` records that the probe could not run at all (no verify_script, missing
    // clone) — a different fact, and not evidence about the base. Counting it would let a
    // project with 50 of those and one red trip the alarm.
    const res = isDegenerateBaseHealth(counts(0, 1, 0, 100));
    expect(res.conclusiveProbes).toBe(1);
    expect(res.degenerate).toBe(false);
  });

  it("counts a project's whole history by outcome, not just the newest page", async () => {
    const { db } = createTestDb();
    const projectId = await createProjectDirectly(db, {});
    for (let i = 0; i < 25; i++) {
      await recordBaseBranchHealth({ projectId, sha: `sha${i}`, branch: "master", outcome: "red" }, db);
    }
    await recordBaseBranchHealth({ projectId, sha: "shaT", branch: "master", outcome: "timeout" }, db);
    const c = await countBaseBranchHealthOutcomes(projectId, db);
    expect(c.byOutcome).toMatchObject({ green: 0, red: 25, timeout: 1 });
    expect(c.total).toBe(26);
    expect(c.firstAt).not.toBeNull();
  });

  it("warns for a never-green project and names what to check", async () => {
    const { db } = createTestDb();
    const projectId = await createProjectDirectly(db, {});
    for (let i = 0; i < DEGENERATE_BASE_HEALTH_MIN_PROBES; i++) {
      await recordBaseBranchHealth({ projectId, sha: `sha${i}`, branch: "master", outcome: "red" }, db);
    }
    const warnings = await scanDegenerateBaseHealth(db);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      type: "degenerate_base_health",
      projectId,
      greenCount: 0,
      redCount: DEGENERATE_BASE_HEALTH_MIN_PROBES,
    });
    expect(warnings[0].message).toContain("NEVER been green");
    // The point of the alarm is that the probe, not the base, is the suspect.
    expect(warnings[0].message).toMatch(/Check the probe itself/);
  });

  it("stays silent for a project whose probe has ever produced a green", async () => {
    const { db } = createTestDb();
    const projectId = await createProjectDirectly(db, {});
    for (let i = 0; i < DEGENERATE_BASE_HEALTH_MIN_PROBES; i++) {
      await recordBaseBranchHealth({ projectId, sha: `sha${i}`, branch: "master", outcome: "red" }, db);
    }
    await recordBaseBranchHealth({ projectId, sha: "green1", branch: "master", outcome: "green" }, db);
    expect(await scanDegenerateBaseHealth(db)).toEqual([]);
  });

  it("stays silent for a project with no probes at all", async () => {
    const { db } = createTestDb();
    await createProjectDirectly(db, {});
    expect(await scanDegenerateBaseHealth(db)).toEqual([]);
  });
});
