/**
 * #1056 — the `%TEMP%` health probe the pre-merge gate admits on.
 *
 * The property that matters is not "counts entries" — it is that the probe is BOUNDED. Reading
 * the true size of the directory is the very operation that stalls: 12.7s for 100,324 entries
 * on the measured box, over 120s at 707,242. A preflight that pays that cost is part of the
 * problem it exists to detect, so every test here is about a bound holding.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeTempHealth } from "../src/lib/temp-health.js";

let root: string;
let small: string;
let large: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ak-temp-health-"));
  small = join(root, "small");
  large = join(root, "large");
  mkdirSync(small);
  mkdirSync(large);
  for (let i = 0; i < 5; i++) writeFileSync(join(small, `f${i}`), "");
  for (let i = 0; i < 200; i++) writeFileSync(join(large, `f${i}`), "");
});

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("probeTempHealth (#1056)", () => {
  it("a small, fast directory is healthy and fully counted", () => {
    const h = probeTempHealth({ dir: small, maxEntries: 1000, budgetMs: 5000 });
    expect(h.degraded).toBe(false);
    expect(h.complete).toBe(true);
    expect(h.stoppedBy).toBeNull();
    expect(h.entries).toBe(5);
    expect(h.reason).toBe("");
  });

  it("stops at the entry cap and reports degraded — without walking the rest", () => {
    const h = probeTempHealth({ dir: large, maxEntries: 20, budgetMs: 5000 });
    expect(h.degraded).toBe(true);
    expect(h.stoppedBy).toBe("entry_cap");
    // The bound is the assertion: it saw 20, not the 200 that are there. A probe that counted
    // them all would be exactly the 120-second enumeration this replaces.
    expect(h.entries).toBe(20);
    expect(h.complete).toBe(false);
    expect(h.reason).toContain("at least 20 entries");
  });

  it("a directory at exactly the cap is degraded — the cap is a ceiling, not a target", () => {
    const h = probeTempHealth({ dir: large, maxEntries: 200, budgetMs: 5000 });
    expect(h.degraded).toBe(true);
    expect(h.stoppedBy).toBe("entry_cap");
  });

  it("names the directory it probed, so a hold message can say which one", () => {
    expect(probeTempHealth({ dir: small, maxEntries: 1000, budgetMs: 5000 }).dir).toBe(small);
    expect(probeTempHealth({ dir: large, maxEntries: 20, budgetMs: 5000 }).dir).toBe(large);
  });

  /**
   * Fail-open, mirroring `readTier0Capacity` (#1009/#1057): a preflight that blocks every merge
   * when its own sensor breaks is strictly worse than no preflight. An unreadable directory is
   * not evidence of a bad one.
   */
  it("an unreadable directory is NOT degraded — it never throws and never fails closed", () => {
    const h = probeTempHealth({ dir: join(root, "does-not-exist"), maxEntries: 10, budgetMs: 5000 });
    expect(h.degraded).toBe(false);
    expect(h.reason).toBe("");
    expect(h.entries).toBe(0);
  });

  it("defaults are a real ceiling, not unbounded", () => {
    // A default of Infinity would make the whole module a no-op on the machine it was written
    // for, which is the failure mode a caller could never see.
    expect(probeTempHealth({ dir: small }).complete).toBe(true);
  });
});
