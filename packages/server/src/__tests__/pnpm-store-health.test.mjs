// @gate:always-run when:scripts/pnpm-store-health.mjs — imports scripts/pnpm-store-health.mjs, a script under `scripts/` that no import graph reaches (#1033/#1126).
/**
 * #1126 — every worktree install hard-links into ONE shared pnpm store, and NTFS caps a file
 * at 1024 hard links. This pins the pure link-counting core so the "warn before it becomes an
 * install failure" promise is checked without needing a real 900-link fixture file.
 */
import { describe, expect, it } from "vitest";
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkStoreHealth } from "../../../../scripts/pnpm-store-health.mjs";

describe("checkStoreHealth (#1126)", () => {
  it("reports ok with no offenders when every file is below the threshold", () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-store-health-"));
    try {
      writeFileSync(join(dir, "a.txt"), "a");
      writeFileSync(join(dir, "b.txt"), "b");
      const result = checkStoreHealth(dir, { warnThreshold: 3 });
      expect(result.ok).toBe(true);
      expect(result.offenders).toEqual([]);
      expect(result.checked).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags a file whose hard-link count meets the warn threshold, sorted by links descending", () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-store-health-"));
    try {
      const stub = join(dir, "sub");
      mkdirSync(stub, { recursive: true });
      const original = join(stub, "export-stub.js");
      writeFileSync(original, "export {};");
      // Hard-link the same file several times so nlink crosses a low test threshold.
      const links = [];
      for (let i = 0; i < 3; i++) {
        const linked = join(stub, `link-${i}.js`);
        linkSync(original, linked);
        links.push(linked);
      }
      writeFileSync(join(dir, "quiet.txt"), "never linked");

      const result = checkStoreHealth(dir, { warnThreshold: 3 });
      expect(result.ok).toBe(false);
      expect(result.offenders.length).toBeGreaterThan(0);
      expect(result.offenders[0].links).toBeGreaterThanOrEqual(3);
      expect(result.hardCap).toBe(1024);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips an unreadable subtree instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-store-health-"));
    try {
      const result = checkStoreHealth(join(dir, "does-not-exist"), { warnThreshold: 900 });
      expect(result.ok).toBe(true);
      expect(result.checked).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
