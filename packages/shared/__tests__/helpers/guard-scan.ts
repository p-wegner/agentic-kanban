/**
 * Shared machinery for the repo's GUARD SUITES (#583).
 *
 * A guard suite asserts a property of the whole repo tree rather than of a module: no raw
 * `git` spawn outside the adapter, no untagged `console.*`, one declaration per wire DTO, a
 * `@gate:always-run` marker on every import-graph-invisible suite. Because their subject is
 * the TREE, they all begin the same way — walk a package's sources, skipping `__tests__`,
 * `node_modules`, `dist` and `.test.` files — and that walker was copy-pasted into ≥8 suites,
 * character for character in places, along with the counted-ratchet comparison that follows it.
 *
 * Copy-paste in a guard is not a style problem: each copy is a place the SCAN can silently
 * diverge from what the guard claims to cover. `countAlwaysRunGuardSuites` drifted exactly
 * that way — its private flat `readdirSync` never saw `mcp-server/src/__tests__/tools/` (33
 * suites), so the gate under-reported for months while the marker ratchet, which had been
 * fixed to recurse, was green.
 *
 * Import from a test in any package via its relative path — these are test-only helpers and
 * are deliberately NOT exported from the `shared` package barrel.
 */
import fs from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set(["__tests__", "node_modules", "dist", "coverage", ".git"]);

export interface WalkOptions {
  /** File extensions to collect, WITH the dot. Default: `.ts` and `.tsx`. */
  extensions?: string[];
  /** Directory names to skip anywhere in the tree. Default: {@link SKIP_DIRS}. */
  skipDirs?: Set<string>;
  /** Include `*.test.*` files. Default false — a guard scans PRODUCTION sources. */
  includeTests?: boolean;
}

/**
 * Every source file under `absDir`, recursively. Returns `[]` for a missing directory rather
 * than throwing, because a guard that scans several roots must not die on the one a given
 * checkout happens not to have.
 */
export function walkPackageSources(absDir: string, options: WalkOptions = {}): string[] {
  const extensions = options.extensions ?? [".ts", ".tsx"];
  const skipDirs = options.skipDirs ?? SKIP_DIRS;
  const includeTests = options.includeTests ?? false;
  if (!fs.existsSync(absDir)) return [];

  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name) && !entry.name.startsWith(".")) walk(full);
        continue;
      }
      if (!extensions.some((ext) => entry.name.endsWith(ext))) continue;
      // A generated declaration is never what a guard means by "a source file".
      if (entry.name.endsWith(".d.ts")) continue;
      if (!includeTests && entry.name.includes(".test.")) continue;
      out.push(full);
    }
  };
  walk(absDir);
  return out;
}

/** Every `*.test.*` file under a `__tests__` tree, recursively. */
export function walkTestFiles(absDir: string): string[] {
  return walkPackageSources(absDir, {
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    includeTests: true,
    skipDirs: new Set(["node_modules", "dist", "coverage", ".git"]),
  }).filter((f) => /\.test\.[a-z]+$/.test(path.basename(f)));
}

/** The monorepo's `packages/` directory, resolved from a suite's own module directory. */
export function packagesRootFrom(testModuleDir: string, upLevels: number): string {
  return path.resolve(testModuleDir, ...Array.from({ length: upLevels }, () => ".."));
}

export interface RatchetVerdict {
  /** Entries whose count EXCEEDS the baseline — the regressions that must fail the suite. */
  over: string[];
  /** Entries whose count is now BELOW the baseline — the baseline is stale and should drop. */
  stale: string[];
}

/**
 * Compare measured counts against a frozen baseline, both directions.
 *
 * The one-directional half is what every counted ratchet in this repo already does. The other
 * half is the one people forget and the reason the discipline works at all: a baseline nobody
 * ever LOWERS stops being a ceiling and becomes a budget, and the next regression hides inside
 * the slack that an earlier cleanup opened up. Reporting `stale` makes shrinking mandatory
 * rather than polite.
 *
 * A key absent from `current` counts as 0, so deleting the last offender for a key surfaces as
 * stale (drop the key) rather than passing silently.
 */
export function compareRatchet(
  baseline: Readonly<Record<string, number>>,
  current: Readonly<Record<string, number>>,
): RatchetVerdict {
  const over: string[] = [];
  const stale: string[] = [];
  for (const [key, allowed] of Object.entries(baseline)) {
    const found = current[key] ?? 0;
    if (found > allowed) over.push(`${key}: ${found} > baseline ${allowed}`);
    else if (found < allowed) stale.push(`${key}: ${found} < baseline ${allowed} — lower it`);
  }
  for (const [key, found] of Object.entries(current)) {
    if (found > 0 && !(key in baseline)) over.push(`${key}: ${found} (NEW — not in the baseline)`);
  }
  return { over, stale };
}
