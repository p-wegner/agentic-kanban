// @gate:always-run when:scripts/test-mine.mjs — pins a repo-script behaviour (the vitest spawn env)
// and scans test files across packages, both outside this suite's own import graph.
/**
 * #1563 — the gate must run vitest under a time zone the box does not choose. Every board box is
 * Europe/Berlin, so local-time snapshots (#1553) passed here for 13 days and failed only on UTC CI.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { gateTimeZoneEnv } from "../../../../scripts/test-mine.mjs";
import { walkRepoTree } from "../../../../scripts/lib/repo-tree.mjs";

const ROOT = resolve(import.meta.dirname, "../../../..");

describe("test:mine pins the time zone (#1563)", () => {
  it("defaults to UTC and honours KANBAN_TEST_TZ", () => {
    expect(gateTimeZoneEnv({})).toEqual({ TZ: "UTC" });
    expect(gateTimeZoneEnv({ KANBAN_TEST_TZ: "Asia/Tokyo" })).toEqual({ TZ: "Asia/Tokyo" });
  });

  it("the vitest spawn actually applies it", () => {
    const src = readFileSync(join(ROOT, "scripts/test-mine.mjs"), "utf8");
    expect(src).toMatch(/\.\.\.gateTimeZoneEnv\(process\.env\)/);
  });
});

describe("snapshot suites do not render the box's local time (#1563)", () => {
  it("no snapshot test file uses local-time APIs without an explicit timeZone", () => {
    const offenders = [];
    const files = walkRepoTree(join(ROOT, "packages"), { skipDirs: ["dist"], filter: (f) => /\.test\.(ts|tsx|mjs)$/.test(f) });
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (!/toMatch(Inline)?Snapshot/.test(src)) continue;
      if (!/toLocale(Time|Date)?String|\.getHours\(/.test(src)) continue;
      if (/timeZone/.test(src)) continue;
      offenders.push(file.slice(ROOT.length + 1));
    }
    expect(offenders).toEqual([]);
  });
});
