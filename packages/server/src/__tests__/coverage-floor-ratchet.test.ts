// @gate:always-run — reads scripts/coverage-floors.json directly off disk; imports nothing
// that would put it in another suite's import graph (#765's under-reporting failure mode).
/**
 * Per-package coverage floor ratchet (#902, #807 follow-up).
 *
 * #807 decided coverage stays informational — no flat `--min` — because mcp-server (48.85%)
 * and client (48.98%) sit far below repo-wide (71.87%), and a floor pinned to today's numbers
 * does not rise by itself. This is the follow-up: a floor PER PACKAGE, shaped like this repo's
 * other shrink/grow-only ratchets (`compareRatchet` in
 * `packages/shared/__tests__/helpers/guard-scan.ts`, `wire-dto-single-declaration.test.ts`,
 * `time-injection-spelling-ratchet.test.ts`), but inverted: those freeze a count that may only
 * shrink, this freezes a floor that may only rise.
 *
 * The logic under test lives in `scripts/coverage-report.mjs` (`checkFloors`, `readFloors`),
 * not here, because that script is already "the one thing that knows the report layout"
 * (its own header comment) and a second copy of the layout knowledge is exactly the drift
 * #765 was about. This suite:
 *   1. exercises `checkFloors` against synthetic report/floor fixtures (not real coverage
 *      runs — those exist only after `pnpm test:coverage`, which this suite must not require),
 *   2. asserts the checked-in `scripts/coverage-floors.json` is well-formed and covers the
 *      four packages `pnpm test:coverage` measures.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const FLOORS_PATH = path.join(REPO_ROOT, "scripts", "coverage-floors.json");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "coverage-report.mjs");

type CoverageReport = { pkg: string; present: boolean; total?: { lines: { pct: number } } };

async function loadScript() {
  return (await import(pathToFileURL(SCRIPT_PATH).href)) as {
    checkFloors: (
      reports: CoverageReport[],
      floors: Record<string, number>,
      slackPct?: number,
    ) => { ok: boolean; regressions: string[]; stale: string[]; missingReport: string[]; unfloored: string[] };
    readFloors: (floorsPath: string) => Record<string, number>;
    COVERED_PACKAGES: string[];
  };
}

/** A present report at `pct`% lines. */
const report = (pkg: string, pct: number): CoverageReport => ({ pkg, present: true, total: { lines: { pct } } });
const missing = (pkg: string): CoverageReport => ({ pkg, present: false });

describe("per-package coverage floor ratchet (#902)", () => {
  it("passes when measured coverage sits within slack of the floor", async () => {
    const { checkFloors } = await loadScript();
    const verdict = checkFloors([report("shared", 76.5)], { shared: 76.37 }, 2);
    expect(verdict.ok).toBe(true);
    expect(verdict.regressions).toEqual([]);
    expect(verdict.stale).toEqual([]);
  });

  it("fails when measured coverage drops below the stored floor", async () => {
    const { checkFloors } = await loadScript();
    const verdict = checkFloors([report("mcp-server", 40)], { "mcp-server": 48.85 }, 2);
    expect(verdict.ok).toBe(false);
    expect(verdict.regressions).toEqual(["mcp-server: measured 40% < floor 48.85%"]);
  });

  it("fails when the floor sits stale more than the slack below measured coverage", async () => {
    const { checkFloors } = await loadScript();
    // Floor never moved while coverage climbed 10 points — the ratchet must force it up.
    const verdict = checkFloors([report("client", 59)], { client: 48.98 }, 2);
    expect(verdict.ok).toBe(false);
    expect(verdict.stale).toHaveLength(1);
    expect(verdict.stale[0]).toMatch(/measured 59% is 10\.02pt above floor 48\.98%/);
  });

  it("a floor exactly at the slack boundary passes (boundary is inclusive)", async () => {
    const { checkFloors } = await loadScript();
    const verdict = checkFloors([report("shared", 78.37)], { shared: 76.37 }, 2);
    expect(verdict.ok).toBe(true);
  });

  it("fails loudly when a floor exists but the package produced no report", async () => {
    const { checkFloors } = await loadScript();
    const verdict = checkFloors([missing("server")], { server: 79.14 }, 2);
    expect(verdict.ok).toBe(false);
    expect(verdict.missingReport).toEqual(["server"]);
  });

  it("a package with no stored floor is not a failure, just unfloored", async () => {
    const { checkFloors } = await loadScript();
    const verdict = checkFloors([report("shared", 76.37)], {}, 2);
    expect(verdict.ok).toBe(true);
    expect(verdict.unfloored).toEqual(["shared"]);
  });

  it("readFloors ignores metadata keys like $comment and non-numeric values", async () => {
    const { readFloors } = await loadScript();
    const dir = path.join(REPO_ROOT, "scripts");
    const parsed = JSON.parse(readFileSync(path.join(dir, "coverage-floors.json"), "utf8")) as Record<string, unknown>;
    const floors = readFloors(FLOORS_PATH);
    for (const key of Object.keys(parsed)) {
      if (key.startsWith("$")) expect(floors).not.toHaveProperty(key);
    }
    expect(Object.values(floors).every((v) => typeof v === "number")).toBe(true);
  });

  it("the checked-in floors file covers exactly the packages pnpm test:coverage measures", async () => {
    const { readFloors, COVERED_PACKAGES } = await loadScript();
    const floors = readFloors(FLOORS_PATH);
    expect(new Set(Object.keys(floors))).toEqual(new Set(COVERED_PACKAGES));
  });

  it("every stored floor is a plausible line-coverage percentage", async () => {
    const { readFloors } = await loadScript();
    const floors = readFloors(FLOORS_PATH);
    for (const [pkg, pct] of Object.entries(floors)) {
      expect(pct, `${pkg} floor`).toBeGreaterThan(0);
      expect(pct, `${pkg} floor`).toBeLessThanOrEqual(100);
    }
  });
});
