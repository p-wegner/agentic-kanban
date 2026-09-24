import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * The `@gate:always-run` GUARD FLOOR: which guard suites a gate run forces, and what they cost.
 *
 * Split out of `pre-merge-gate-tier.ts` when #1043 pushed that file past the god-module ceiling.
 * It is a cohesive unit on its own terms — a tree scan, a marker rule, a glob matcher and a
 * duration read, all answering one question — and the tier module re-exports its surface so no
 * caller has to know it moved.
 *
 * **Why the floor is worth measuring at all.** A passing `impact`-tier message read
 * `… 9 changed file(s), +14 guard suites, workers 6`, in which `+14 guard suites` parses as a
 * small top-up on the selection. Measured 2026-09-05 it was the ENTIRE run: the selection was
 * 1 file / ~3s and this floor 177 files / ~546s. So the one number the message emphasised was
 * the 0.5%, and "the gate is slow" got attributed to the selection — which is where the fixes
 * then went (#1043).
 *
 * **Everything here is a deliberate MIRROR of `scripts/test-mine.mjs`, not an import.**
 * `packages/server` ships only `dist/` (see its `files`), so importing a repo-root script would
 * make a published install crash on load; and the script itself imports only Node built-ins on
 * purpose, so it cannot depend on this package either. Two implementations is the floor the
 * packaging allows. What stops them drifting is `always-run-dirs-lockstep.test.ts`, which feeds
 * both the same fixtures and asserts identical classification — for the marker RULE (#891) and,
 * since #1041, for the `when:` precondition too.
 */

/** Mirrors `ALWAYS_RUN_MARKER_RE` in `scripts/test-mine.mjs`; the tail carries the `when:` clause. */
const ALWAYS_RUN_MARKER_RE = /^\s*\/\/\s*@gate:always-run\b(.*)$/m;

/**
 * Does this suite's source carry the `@gate:always-run` marker (#1230)? The one rule, exported so
 * `verify-failed-suites.ts` classifies a failing suite by the SAME marker this floor forces it
 * to run by — two regexes for one marker is how the classification would drift from the run.
 */
export function hasAlwaysRunMarker(source: string): boolean {
  return ALWAYS_RUN_MARKER_RE.test(source);
}

/** Mirrors `ALWAYS_RUN_WHEN_RE` in `scripts/test-mine.mjs` (#1041). */
const ALWAYS_RUN_WHEN_RE = /\bwhen:([^\s,]+(?:\s*,\s*[^\s,]+)*)/;

/** Mirrors `ALWAYS_RUN_TEST_FILE` in `scripts/test-mine.mjs`. */
const ALWAYS_RUN_TEST_FILE = /\.test\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** The default per-file estimate for a guard with no measured duration. Mirrors
 *  `ASSUMED_GUARD_MS` in `scripts/test-mine.mjs` (#1042). */
export const ASSUMED_GUARD_MS = 3000;

/**
 * Package `__tests__` dirs to scan for the marker, mirroring `scripts/test-mine.mjs`'s
 * `ALWAYS_RUN_TESTS_DIR`. Best-effort: this repo checkout's own monorepo layout, so the scan is
 * inert (returns 0) for a project the gate runs FOR that isn't this repo — the count only
 * decorates the message, it never gates behavior.
 */
export const ALWAYS_RUN_TESTS_DIRS = [
  join("packages", "shared", "__tests__"),
  join("packages", "server", "src", "__tests__"),
  join("packages", "mcp-server", "src", "__tests__"),
  // #601: the client's suites were invisible to the always-run scan, so a
  // `@gate:always-run` marker in a client guard would have been silently ignored.
  join("packages", "client", "src", "__tests__"),
];

/** The `GateTierInfo` fields this module fills — see {@link guardFloorFor}. */
export interface GuardFloorFields {
  guardSuiteCount: number;
  guardEstMs?: number;
  guardAssumedCount?: number;
}

/**
 * How many `@gate:always-run` suites will run, and what they are estimated to cost (#1043).
 *
 * `changedFiles` applies each marker's `when:` precondition (#1041), so the count describes the
 * RUN rather than the tree. Pass `[]` whenever the runner will not narrow either (no
 * `KANBAN_TEST_FILES`): the two must agree, or the message is
 * wrong in the flattering direction.
 *
 * Best-effort throughout: a scan or parse error yields whatever was gathered, never an exception.
 * `estMs: null` means no duration report was readable, and the message then omits the estimate
 * rather than inventing one.
 */
export function describeAlwaysRunGuards(
  repoRoot: string,
  options?: { changedFiles?: readonly string[]; packages?: readonly string[] },
): { count: number; estMs: number | null; assumedCount: number } {
  const changedFiles = (options?.changedFiles ?? []).map((f) => f.replace(/\\/g, "/"));
  const durations = readTestDurationsMap(repoRoot);
  let count = 0;
  let estMs = 0;
  let assumedCount = 0;
  // #583 — RECURSIVE, and every test extension. The old flat `readdirSync` over `.test.ts`
  // only saw a `__tests__` dir's top level, so `mcp-server/src/__tests__/tools/` (33 suites)
  // and every `.test.tsx`/`.test.mjs` were invisible: the gate under-reported the guard set
  // it claims to run while the marker ratchet, which had been fixed to recurse, stayed green.
  // A number in a gate message that quietly means something narrower than it says is worse
  // than no number, because it is the thing an operator checks instead of the suite list.
  const scan = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const full = join(abs, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && !entry.name.startsWith(".")) scan(full);
        continue;
      }
      if (!ALWAYS_RUN_TEST_FILE.test(entry.name)) continue;
      const marker = ALWAYS_RUN_MARKER_RE.exec(readFileSync(full, "utf8"));
      if (!marker) continue;
      if (!guardRunsForChanges(parseWhenClause(marker[1] ?? ""), changedFiles)) continue;
      count += 1;
      const measured = durations?.get(relative(repoRoot, full).split(sep).join("/"));
      estMs += measured ?? ASSUMED_GUARD_MS;
      if (measured === undefined) assumedCount += 1;
    }
  };
  for (const dir of ALWAYS_RUN_TESTS_DIRS) {
    if (options?.packages && !options.packages.includes(dir.split(sep)[1])) continue;
    const abs = resolve(repoRoot, dir);
    if (!existsSync(abs)) continue;
    try {
      scan(abs);
    } catch {
      // Best-effort decoration only — never let a scan error affect the gate.
    }
  }
  return { count, estMs: durations ? estMs : null, assumedCount };
}

/** The `when:` globs on a marker line, `[]` for a bare marker. Mirrors `parseAlwaysRunMarker`. */
function parseWhenClause(markerTail: string): string[] {
  const when = ALWAYS_RUN_WHEN_RE.exec(markerTail);
  if (!when) return [];
  return when[1].split(",").map((g) => g.trim().replace(/\\/g, "/")).filter(Boolean);
}

/**
 * Mirrors `guardAppliesToChanges` in `scripts/test-mine.mjs`, both fail-open cases included: a
 * bare marker is unconditional, and an UNKNOWN change set runs every guard (a precondition that
 * narrowed on an empty change set would silently claim a floor of nothing).
 */
function guardRunsForChanges(when: string[], changedFiles: readonly string[]): boolean {
  if (when.length === 0 || changedFiles.length === 0) return true;
  return changedFiles.some((file) => when.some((glob) => matchesGuardGlob(glob, file)));
}

/** Mirrors `matchesPathGlob` in `scripts/test-mine.mjs`: `**` spans segments, `*` does not. */
function matchesGuardGlob(glob: string, relPath: string): boolean {
  const rx = glob
    .replace(/\\/g, "/")
    .split("/")
    .map((seg) =>
      seg === "**" ? "(?:.*)" : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"),
    )
    .join("/")
    // `**' + '/x` must also match a bare `x` at the root.
    .replace(/\(\?:\.\*\)\//g, "(?:.*/)?");
  return new RegExp(`^${rx}$`).test(relPath.replace(/\\/g, "/"));
}

/**
 * The committed per-test-file durations, as `repo-relative path -> ms`; `null` when absent.
 *
 * Mirrors `readTestDurations` in `scripts/test-mine.mjs`, and reads the same COMMITTED report —
 * not `docs/tests/impact-map.json`, which is a gitignored per-checkout artifact (#1018) and would
 * make the figure in a merge comment mean something different on every machine.
 */
function readTestDurationsMap(repoRoot: string): Map<string, number> | null {
  try {
    // Strip a BOM: it makes `JSON.parse` throw on otherwise-valid JSON, and on Windows it is
    // easy to acquire one (`capture-test-durations.mjs` guards the same way).
    const raw = readFileSync(resolve(repoRoot, "docs", "tests", "durations.json"), "utf8").replace(/^﻿/, "");
    const json = JSON.parse(raw) as { testResults?: unknown[] };
    const map = new Map<string, number>();
    // Read the vitest-report fields through bracket access rather than declaring an interface
    // for them. `{ startTime?: number; endTime?: number }` is an optional time-named number pair,
    // which is exactly the SHAPE `time-injection-spelling-ratchet.test.ts` (#614/#721) treats as
    // a new spelling of an injected clock — and it is not one: these are keys of somebody else's
    // JSON, not parameters this code could rename.
    for (const entry of json.testResults ?? []) {
      const row = (entry ?? {}) as Record<string, unknown>;
      const name = row["name"];
      if (typeof name !== "string" || !name) continue;
      const from = typeof row["startTime"] === "number" ? row["startTime"] : 0;
      const to = typeof row["endTime"] === "number" ? row["endTime"] : 0;
      const ms = Math.max(1, to - from);
      const key = name.replace(/\\/g, "/");
      if (!map.has(key) || (map.get(key) ?? 0) < ms) map.set(key, ms);
    }
    return map.size > 0 ? map : null;
  } catch {
    return null;
  }
}

/** How many suites currently carry the `@gate:always-run` marker — the count half of
 *  {@link describeAlwaysRunGuards}, kept because several suites pin it directly. */
export function countAlwaysRunGuardSuites(repoRoot: string): number {
  return describeAlwaysRunGuards(repoRoot).count;
}

/**
 * {@link describeAlwaysRunGuards} shaped as the `GateTierInfo` fields it fills (#1043).
 *
 * A helper rather than a conditional at the call site because `runPreMergeGate` sits ON the
 * god-module gate's branch ceiling (grandfathered at 34) — the same reason `guardsOnlyReasonFor`
 * and `buildVerifyEnv` live outside it. `narrowed` is therefore a parameter rather than a ternary
 * on the caller's side: it says whether the RUNNER will see a file list at all, which is the only
 * condition under which the `when:` preconditions can apply.
 *
 * The unmeasured fields are OMITTED rather than set to 0, so "no duration report" and "the guards
 * cost nothing" can never read the same.
 */
export function guardFloorFor(
  repoRoot: string,
  changedFiles: readonly string[],
  options: { narrowed: boolean; packages?: readonly string[]; guardsOnly?: boolean },
): GuardFloorFields {
  const floor = describeAlwaysRunGuards(repoRoot, {
    changedFiles: options.narrowed ? changedFiles : [],
    packages: options.guardsOnly ? undefined : options.packages,
  });
  return {
    guardSuiteCount: floor.count,
    ...(floor.estMs === null ? {} : { guardEstMs: floor.estMs, guardAssumedCount: floor.assumedCount }),
  };
}
