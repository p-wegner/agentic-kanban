// @gate:always-run — scans the whole `packages/server/src/startup/` tree and the repo's
// dependency-cruiser config; it imports none of the files it judges (#715).
/**
 * `startup/` may not grow another raw-persistence offender (#715).
 *
 * The persistence boundary holds everywhere in the server except `startup/`, where it does
 * not exist at all. Measured when #715 was filed, and re-measured by this suite on every run:
 *
 *     packages/server/src/startup/   -> 31 files value-import drizzle-orm
 *     packages/server/src/services/  ->  0
 *
 * `services-bypass-repositories` in `.dependency-cruiser.cjs` is a total `error` gate, so the
 * services number cannot move. Its neighbour `startup-bypasses-repositories` is pinned
 * `severity: "warn"` — honestly so, and the rule's own comment argues the case: draining ~31
 * files is real work, and a rule that cannot go green today belongs at warn with its count
 * written down. The failure is not the severity, it is that **nothing reads the count**.
 * `pnpm lint:arch` prints "32 warnings, 0 errors" whatever the number is, so the 2026-08-20/21
 * wave could add a new offender (`startup/install-staleness-reconciler.ts`) while ~1400 lines
 * of ratchets were being built for much smaller invariants, and nothing said the number went up.
 *
 * So this suite makes the COUNT the mechanism, in the shape the repo already uses for #569 and
 * #705: an explicit baseline that **may only shrink**. A 32nd offender fails; a REMOVED offender
 * also fails, with "lower the baseline" — because a baseline nobody ever lowers stops being a
 * ceiling and becomes a budget, and the next regression hides in the slack an earlier cleanup
 * opened up.
 *
 * **This is a ratchet, not a drain and not a promotion to `error`.** Draining the 31 is separate,
 * larger work (extract each query into a per-file repository, the way `services/` was drained);
 * promoting the rule cannot go green today. Nothing in this file asks anyone to touch a startup
 * module — it only asks that the number be visible when it changes.
 *
 * **Two signals, deliberately kept apart.** `drizzle-orm` is the one the dependency-cruiser rule
 * matches, so its baseline is the number that rule's comment claims (asserted below, because a
 * documented count that drifts from reality is how this got missed). The `db` VALUE import is the
 * wider signal the same comment cites — a module holding the singleton connection has no seam to
 * swap or fake even when it writes no `eq()` itself — and it covers files the first misses
 * (`base-branch-health-reconciler`, `process-handlers`, `worker-incoming-sweep`).
 *
 * Type-only imports are excluded on both, matching dependency-cruiser's
 * `tsPreCompilationDeps: false`: `import type { Database } from "../db/index.js"` is erased at
 * compile time, carries no runtime edge, and is in fact the SHAPE OF THE FIX — a sweep that takes
 * its `Database` as an injected parameter is exactly what leaving this set means to produce.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { walkPackageSources } from "../../../shared/__tests__/helpers/guard-scan.js";

const serverSrc = path.resolve(import.meta.dirname!, "..");
const repoRoot = path.resolve(serverSrc, "..", "..", "..");
const STARTUP_DIR = path.join(serverSrc, "startup");
const SERVICES_DIR = path.join(serverSrc, "services");

/**
 * Grandfathered files that value-import `drizzle-orm`. MAY ONLY SHRINK.
 *
 * This is the same 31 that `startup-bypasses-repositories` warns about — one entry per file,
 * so moving a module's queries into a repository is a one-line deletion here.
 */
const DRIZZLE_BASELINE = new Set<string>([
  "ancestor-branch-reconciler.ts",
  "auto-merge-orchestrator.ts",
  "born-blocked-reconciler.ts",
  "completion-state-reconciler.ts",
  "done-unmerged-invariant-sweep.ts",
  "drive-completion-reconciler.ts",
  "exit-workflow.ts",
  "hand-merged-branch-reconciler.ts",
  // Added by the 2026-08-20/21 wave with nothing to notice it — the finding behind #715.
  "install-staleness-reconciler.ts",
  "merge-workflow.ts",
  "monitor-auto-start.ts",
  "monitor-backlog.ts",
  "monitor-compounding-setup.ts",
  "monitor-contract.ts",
  "monitor-cycle-actions.ts",
  "monitor-cycle.ts",
  "monitor-eligibility.ts",
  "monitor-file-contention.ts",
  "monitor-helpers.ts",
  "monitor-setup.ts",
  "plan-mode-reconciler.ts",
  "project-completion-reconciler.ts",
  "scheduled-tasks.ts",
  "service-stack-reaper.ts",
  "session-restore.ts",
  "silently-merged-reconciler.ts",
  "startup-tasks.ts",
  "stranded-review-reconciler.ts",
  "terminal-workspace-reaper.ts",
  "workflow-node-divergence-reconciler.ts",
  "zombie-fix-session-reconciler.ts",
]);

/**
 * Grandfathered files that import the `db` singleton (or a raw client) as a VALUE. MAY ONLY
 * SHRINK. Overlaps `DRIZZLE_BASELINE` heavily and on purpose: the two answer different
 * questions ("does this module write queries" vs. "does this module reach for the one global
 * connection"), and a file can lose one and keep the other.
 */
const DB_VALUE_BASELINE = new Set<string>([
  "ancestor-branch-reconciler.ts",
  "base-branch-health-reconciler.ts",
  "born-blocked-reconciler.ts",
  "done-unmerged-invariant-sweep.ts",
  "exit-workflow.ts",
  "hand-merged-branch-reconciler.ts",
  "install-staleness-reconciler.ts",
  "merge-workflow.ts",
  "monitor-auto-start.ts",
  "monitor-backlog.ts",
  "monitor-compounding-setup.ts",
  "monitor-contract.ts",
  "monitor-cycle-actions.ts",
  "monitor-cycle.ts",
  "monitor-file-contention.ts",
  "monitor-helpers.ts",
  "monitor-setup.ts",
  "plan-mode-reconciler.ts",
  // `rawClient` / `rawWriteClient`, for a WAL checkpoint on shutdown — a legitimate reach for
  // the real connection rather than a query, but it is still the singleton, so it is counted
  // and explained rather than quietly exempted.
  "process-handlers.ts",
  "scheduled-tasks.ts",
  "service-stack-reaper.ts",
  "session-restore.ts",
  "silently-merged-reconciler.ts",
  "startup-tasks.ts",
  "stranded-review-reconciler.ts",
  "terminal-workspace-reaper.ts",
  "worker-incoming-sweep.ts",
  "workflow-node-divergence-reconciler.ts",
  "zombie-fix-session-reconciler.ts",
]);

/**
 * Does this import statement bring in at least one VALUE binding?
 *
 * `import type { X } from` and a brace list whose every specifier is `type X` are both fully
 * erased; anything else (a namespace import, a default import, one non-`type` specifier) is a
 * runtime edge.
 */
function importsAValue(typeKeyword: string | undefined, clause: string): boolean {
  if (typeKeyword) return false;
  const braces = clause.match(/\{([\s\S]*)\}/);
  if (!braces) return true;
  const specifiers = braces[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // `import {} from "x"` is a side-effect-only import: an edge, even with no binding.
  if (specifiers.length === 0) return true;
  return specifiers.some((s) => !/^type\s/.test(s));
}

/** Files under `dir` holding a value import whose module specifier matches `modulePattern`. */
function filesValueImporting(dir: string, modulePattern: RegExp): Set<string> {
  const hits = new Set<string>();
  for (const full of walkPackageSources(dir)) {
    const source = fs.readFileSync(full, "utf-8");
    for (const m of source.matchAll(/^import\s+(type\s+)?([\s\S]*?)\s*from\s+"([^"]+)";/gm)) {
      if (!modulePattern.test(m[3])) continue;
      if (importsAValue(m[1], m[2])) {
        hits.add(path.relative(dir, full).replace(/\\/g, "/"));
        break;
      }
    }
  }
  return hits;
}

/** `drizzle-orm` itself and its subpaths (`drizzle-orm/sql`, which one sweep already uses). */
const DRIZZLE = /^drizzle-orm(\/|$)/;
/** The server's own db module — the singleton `db`, `rawClient`, `rawWriteClient`. */
const DB_MODULE = /^(?:\.\.?\/)+db\/index\.js$/;

/** Both halves of the shrink-only comparison, in the repo's usual reporting shape. */
function ratchet(baseline: Set<string>, found: Set<string>, what: string): void {
  const fresh = [...found].filter((f) => !baseline.has(f)).sort();
  expect(
    fresh,
    [
      `NEW startup/ file(s) ${what}. packages/server/src/startup/ has no persistence boundary`,
      `(#715) and this baseline exists so the number cannot grow again unnoticed the way`,
      `install-staleness-reconciler.ts did. Route the queries through a repository (see any`,
      `packages/server/src/repositories/*.repository.ts, and how services/ was drained to 0),`,
      `or take the connection as an injected \`Database\` parameter instead of importing the`,
      `singleton. Only add an entry here if the file genuinely has to be in the backlog:`,
      "",
      ...fresh,
    ].join("\n  "),
  ).toEqual([]);

  const stale = [...baseline].filter((f) => !found.has(f)).sort();
  expect(
    stale,
    [
      `The baseline for "${what}" is STALE — these files no longer match, so the ceiling has`,
      `slack in it and the next regression would hide inside that slack. Lower the baseline:`,
      `delete these entries (and update the Backlog count in .dependency-cruiser.cjs).`,
      "",
      ...stale,
    ].join("\n  "),
  ).toEqual([]);
}

describe("startup/ persistence-boundary baseline may only shrink (#715)", () => {
  const drizzleOffenders = filesValueImporting(STARTUP_DIR, DRIZZLE);
  const dbValueOffenders = filesValueImporting(STARTUP_DIR, DB_MODULE);

  it("no startup/ file value-imports drizzle-orm outside the baseline, and the baseline is not stale", () => {
    ratchet(DRIZZLE_BASELINE, drizzleOffenders, "value-import drizzle-orm");
  });

  it("no startup/ file imports the db singleton outside the baseline, and the baseline is not stale", () => {
    ratchet(DB_VALUE_BASELINE, dbValueOffenders, "import the `db` value from ../db/index.js");
  });

  it("services/ still has zero raw-persistence imports — the contrast this ratchet exists to restore", () => {
    // `services-bypass-repositories` is a total `error` gate, so this cannot regress without
    // `pnpm lint:arch` failing first. Asserted here anyway: the whole argument for the startup
    // baseline is that the boundary is achievable and already achieved next door, and if that
    // ever stopped being true the argument would need rewriting rather than the number nudging.
    expect([...filesValueImporting(SERVICES_DIR, DRIZZLE)].sort()).toEqual([]);
  });

  it("the count in .dependency-cruiser.cjs's startup rule matches what is actually on disk", () => {
    // The rule comment said "Backlog: 30" while 31 files matched — a documented count nobody
    // re-measured is exactly how the new offender slipped in. Binding the two means the warn
    // severity stays honest: the rule keeps stating its own size, and the statement is checked.
    const config = fs.readFileSync(path.join(repoRoot, ".dependency-cruiser.cjs"), "utf-8");
    const rule = config.slice(config.indexOf('name: "startup-bypasses-repositories"'));
    const declared = rule.match(/Backlog:\s*(\d+)/);
    expect(declared, "the startup-bypasses-repositories rule no longer states its Backlog count").not.toBeNull();
    expect(
      Number(declared![1]),
      "the startup-bypasses-repositories rule's documented Backlog count has drifted from the " +
        "files on disk — update the comment (and the baseline above) in the same commit as the change",
    ).toBe(drizzleOffenders.size);
  });
});
