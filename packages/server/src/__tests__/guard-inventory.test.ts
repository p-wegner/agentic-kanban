// @gate:always-run — spawns scripts/guard-inventory.mjs over the whole package tree; imports nothing it checks (#1022).
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { scanAlwaysRunTests, PACKAGES, ALWAYS_RUN_TESTS_DIR } from "../../../../scripts/test-mine.mjs";

/**
 * The guard inventory (#1022) must SEE the whole standing guard set, exactly once per file.
 *
 * The report is the input to a decision about which guards to merge or retire, so a file it
 * silently omits is a guard nobody weighs — the same failure mode #538 fixed for the runner
 * itself (a hand-maintained list that a new suite never joins). This asserts the two properties
 * that make the report trustworthy: it RUNS, and its always-run rows are exactly `test-mine`'s
 * marker-derived set, with no file listed twice.
 *
 * `--no-git` is deliberate: the two git passes are the slow half and they are not what this
 * pins. The CLI path itself is still exercised end to end, including the JSON it writes.
 */
const repoRoot = path.resolve(import.meta.dirname!, "..", "..", "..", "..");

type Inventory = {
  counts: { files: number; alwaysRun: number; ratchet: number };
  rows: { file: string; kinds: string[]; property: string }[];
  candidates: { duplicates: unknown[]; nearDuplicates: unknown[]; slowerThanThreshold: unknown[] };
};

function runInventory(env: Record<string, string> = {}): Inventory {
  const stdout = execFileSync(
    process.execPath,
    [path.join(repoRoot, "scripts", "guard-inventory.mjs"), "--no-git", "--json"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, ...env },
    },
  );
  return JSON.parse(stdout) as Inventory;
}

describe("guard inventory", () => {
  it("runs and reports every @gate:always-run suite exactly once", () => {
    const inv = runInventory();

    const expected = new Set<string>();
    for (const pkg of PACKAGES as { dir: string; label: string }[]) {
      const testsDir = (ALWAYS_RUN_TESTS_DIR as Record<string, string>)[pkg.label];
      for (const rel of scanAlwaysRunTests(path.join(repoRoot, pkg.dir), testsDir) as string[]) {
        expected.add(`${pkg.dir}/${rel}`.split("\\").join("/"));
      }
    }
    expect(expected.size).toBeGreaterThan(50); // the scan itself must not have silently found nothing

    const listed = inv.rows.filter((r) => r.kinds.includes("always-run")).map((r) => r.file);
    expect(new Set(listed).size).toBe(listed.length); // no file twice
    expect([...listed].sort()).toEqual([...expected].sort());

    // The whole report is one row per file, whichever kinds a file belongs to.
    expect(new Set(inv.rows.map((r) => r.file)).size).toBe(inv.rows.length);
    expect(inv.counts.files).toBe(inv.rows.length);
    expect(inv.counts.alwaysRun).toBe(expected.size);

    // Every row states something — a property line, or the literal `MISSING` that makes its
    // absence a visible candidate rather than an empty cell.
    for (const row of inv.rows) {
      expect(row.property.length, `${row.file} has an empty property`).toBeGreaterThan(0);
    }
  }, 180_000);

  /**
   * The `--json` stdout is MACHINE output, so nothing this tool imports may write to it (#1034).
   *
   * `guard-inventory.mjs` imports `scripts/test-mine.mjs` for the package list and the
   * marker scan. That module used to print `[test:mine] scoped to: …` at module scope, so with
   * `KANBAN_TEST_PACKAGES` set — which is precisely what the pre-merge gate's SCOPED tier sets —
   * the notice landed ahead of the JSON and this suite died in `JSON.parse`. A guard suite going
   * red because the gate narrowed its own scope is the one failure the guard set may not have.
   */
  it("emits parseable JSON even when the gate has narrowed the test scope", () => {
    const inv = runInventory({ KANBAN_TEST_PACKAGES: "server" });
    expect(inv.counts.files).toBe(inv.rows.length);
    expect(inv.counts.alwaysRun).toBeGreaterThan(50);
  }, 180_000);
});
