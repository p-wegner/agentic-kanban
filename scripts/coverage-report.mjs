#!/usr/bin/env node
// The CONSUMER of the coverage reports. #688 installed `@vitest/coverage-v8`, added a
// `coverage` block to every package's vitest/vite config and a root `pnpm test:coverage`
// — and then nothing on this machine or in CI ever read a byte of it. #765 measured the
// consequence: `code-metrics` fell back to `safety_net_basis = "test_cochange"` for
// 1375 of 1375 production files, i.e. every "is this file protected" number the repo
// produces was "was it ever committed alongside a test file", which is a different
// question with a different answer (GraphEdges.tsx: co-change basis 0.00, measured line
// coverage 88%).
//
// This script is deliberately the only thing that knows the report LAYOUT, so the CI
// workflow, the docs and any future gate all agree:
//   packages/<pkg>/coverage/coverage-summary.json   (json-summary reporter)
//   packages/<pkg>/coverage/lcov.info               (lcov reporter — what code-metrics eats)
//
// It exits NON-ZERO when a package that runs tests produced no report, because the #688
// failure mode was SILENCE: a `test:coverage` script that appeared to work while
// emitting nothing. A missing report must be loud.
//
// Usage:
//   node scripts/coverage-report.mjs               # table + lcov paths, fails if a report is missing
//   node scripts/coverage-report.mjs --json        # machine-readable
//   node scripts/coverage-report.mjs --min 35      # also fail below N% total lines
//   node scripts/coverage-report.mjs --lcov-paths  # just the lcov files, one per line
//   node scripts/coverage-report.mjs --allow-missing   # report what is there, never fail on absence
//   node scripts/coverage-report.mjs --merge [out]  # ONE repo-root-relative lcov for the analyzer
//   node scripts/coverage-report.mjs --check-floors  # per-package shrink-proof floor ratchet (#902)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FLOORS_PATH = join(REPO_ROOT, "scripts", "coverage-floors.json");

// The packages `pnpm test:coverage` runs, in its order. Kept here (not derived from the
// workspace) so a NEW package that ships tests without a coverage block is a visible
// omission rather than an invisible one — which is exactly how packages/client came to
// be doubted in #765 (its coverage block lives in vite.config.ts, not vitest.config.ts).
export const COVERED_PACKAGES = ["shared", "server", "mcp-server", "client"];

export function coverageArtifactPaths(repoRoot, pkg) {
  const dir = join(repoRoot, "packages", pkg, "coverage");
  return { dir, summary: join(dir, "coverage-summary.json"), lcov: join(dir, "lcov.info") };
}

/** Read one package's report. Never throws: an unreadable report is a finding, not a crash. */
export function readPackageCoverage(repoRoot, pkg) {
  const paths = coverageArtifactPaths(repoRoot, pkg);
  const out = { pkg, ...paths, present: false, lcovPresent: existsSync(paths.lcov), total: null, error: null };
  if (!existsSync(paths.summary)) {
    out.error = "no coverage-summary.json";
    return out;
  }
  try {
    const parsed = JSON.parse(readFileSync(paths.summary, "utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.total) {
      out.error = "coverage-summary.json has no `total` block";
      return out;
    }
    // A report that measured NOTHING is the #688 failure mode wearing a report's clothes:
    // vitest writes `{"total":{"lines":{"total":0,...,"pct":"Unknown"}}}` when the run
    // matched no test file, and a naive reader prints "Unknown%" and exits 0. Observed for
    // real on 2026-08-23. Treat it as absent.
    if (!parsed.total.lines || (parsed.total.lines.total ?? 0) === 0) {
      out.error = "coverage-summary.json measured 0 lines (the run matched no test files)";
      return out;
    }
    out.present = true;
    out.total = parsed.total;
    out.fileCount = Object.keys(parsed).filter((k) => k !== "total").length;
    out.zeroCoverageFiles = Object.entries(parsed)
      .filter(([k, v]) => k !== "total" && v?.lines && v.lines.pct === 0)
      .map(([k]) => k);
  } catch (err) {
    out.error = `coverage-summary.json unreadable: ${err instanceof Error ? err.message : String(err)}`;
  }
  return out;
}

/**
 * #797 — `code-metrics analyze --coverage <path>` takes exactly ONE report, and each package's
 * lcov names its files relative to that package with Windows separators (`SF:src\lib\x.ts`).
 * Feeding it one package's report leaves the other three on the co-change proxy; feeding it a
 * naive `cat` of all four makes `src/lib/x.ts` ambiguous across packages and the analyzer
 * matches the wrong file or none.
 *
 * lcov IS just concatenated records, so merging is legitimate — it only needs every `SF:`
 * re-anchored to the repo root and normalised to forward slashes. That is what this does.
 */
export function mergeLcov(repoRoot, reports) {
  const out = [];
  const seen = new Set();
  for (const r of reports) {
    if (!r.lcovPresent) continue;
    const prefix = `packages/${r.pkg}/`;
    for (const line of readFileSync(r.lcov, "utf8").split(/\r?\n/)) {
      if (line.startsWith("SF:")) {
        const rel = line.slice(3).split("\\").join("/").replace(/^\.\//, "");
        // Already repo-anchored (a future reporter change) — do not double-prefix.
        const full = rel.startsWith("packages/") ? rel : prefix + rel;
        seen.add(full);
        out.push(`SF:${full}`);
      } else {
        out.push(line);
      }
    }
  }
  return { text: out.join("\n"), fileCount: seen.size };
}

function pct(covered, total) {
  if (!total) return 0;
  return Math.round((covered / total) * 10000) / 100;
}

/** Roll the per-package summaries into one repo-wide line/statement/branch/function total. */
export function aggregate(reports) {
  const keys = ["lines", "statements", "functions", "branches"];
  const totals = {};
  for (const key of keys) totals[key] = { total: 0, covered: 0, pct: 0 };
  for (const r of reports) {
    if (!r.present) continue;
    for (const key of keys) {
      const t = r.total?.[key];
      if (!t) continue;
      totals[key].total += t.total ?? 0;
      totals[key].covered += t.covered ?? 0;
    }
  }
  for (const key of keys) totals[key].pct = pct(totals[key].covered, totals[key].total);
  return totals;
}

/** Read the stored per-package floors. Never throws — a missing/unreadable file is a finding. */
export function readFloors(floorsPath) {
  if (!existsSync(floorsPath)) return {};
  const parsed = JSON.parse(readFileSync(floorsPath, "utf8"));
  const out = {};
  for (const [pkg, value] of Object.entries(parsed)) {
    if (pkg.startsWith("$")) continue; // "$comment" etc — not a package
    if (typeof value === "number") out[pkg] = value;
  }
  return out;
}

/**
 * The per-package floor ratchet (#902, #807 follow-up).
 *
 * Same shape as this repo's other shrink/grow-only ratchets (`compareRatchet` in
 * `packages/shared/__tests__/helpers/guard-scan.ts`), but inverted: those freeze a count that
 * may only SHRINK, this freezes a floor that may only RISE. Two ways to fail:
 *
 *   - `regressions` — measured coverage dropped below its stored floor. The floor is a promise
 *     that coverage will not get worse than this; a run below it broke that promise.
 *   - `stale` — measured coverage is now MORE than `slackPct` above its stored floor. #807
 *     rejected a floor pinned to today's numbers because nothing forces it to rise — this is
 *     that force: a floor that is allowed to sit arbitrarily far below reality is not a floor,
 *     it is a number nobody looks at again.
 *
 * A package with no measured report and no stored floor is silently skipped (nothing to ratchet
 * yet); a package with a stored floor but no report is a `missingReport` finding, since the
 * floor becomes unverifiable rather than passing vacuously.
 */
export function checkFloors(reports, floors, slackPct = 2) {
  const regressions = [];
  const stale = [];
  const missingReport = [];
  const unfloored = [];
  for (const r of reports) {
    const floor = floors[r.pkg];
    if (!r.present) {
      if (floor !== undefined) missingReport.push(r.pkg);
      continue;
    }
    const measured = r.total.lines.pct;
    if (floor === undefined) {
      unfloored.push(r.pkg);
      continue;
    }
    if (measured < floor) {
      regressions.push(`${r.pkg}: measured ${measured}% < floor ${floor}%`);
    } else if (measured - floor > slackPct) {
      stale.push(`${r.pkg}: measured ${measured}% is ${(measured - floor).toFixed(2)}pt above floor ${floor}% (> ${slackPct}pt slack) — raise the floor in ${FLOORS_PATH}`);
    }
  }
  return { ok: regressions.length === 0 && stale.length === 0 && missingReport.length === 0, regressions, stale, missingReport, unfloored };
}

function numArg(argv, flag) {
  const i = argv.indexOf(flag);
  if (i === -1) return null;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : null;
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const lcovOnly = argv.includes("--lcov-paths");
  const allowMissing = argv.includes("--allow-missing");
  const mergeIdx = argv.indexOf("--merge");
  const min = numArg(argv, "--min");
  const checkFloorsFlag = argv.includes("--check-floors");
  const slackArg = numArg(argv, "--floor-slack");

  const reports = COVERED_PACKAGES.map((pkg) => readPackageCoverage(REPO_ROOT, pkg));
  const totals = aggregate(reports);
  const missing = reports.filter((r) => !r.present);

  if (checkFloorsFlag) {
    const floors = readFloors(FLOORS_PATH);
    const verdict = checkFloors(reports, floors, slackArg ?? undefined);
    if (asJson) {
      console.log(JSON.stringify(verdict, null, 2));
    } else {
      console.log(`coverage floor ratchet (source: ${FLOORS_PATH})\n`);
      for (const r of reports) {
        const floor = floors[r.pkg];
        const measured = r.present ? `${r.total.lines.pct}%` : "MISSING";
        console.log(`${r.pkg.padEnd(12)} measured ${measured.padEnd(9)} floor ${floor === undefined ? "(none)" : floor + "%"}`);
      }
      if (verdict.unfloored.length) {
        console.log(`\nNo stored floor yet (not a failure, but nothing is ratcheted): ${verdict.unfloored.join(", ")}`);
      }
      if (verdict.missingReport.length) {
        console.log(`\nFAIL: floor exists but no report was produced for: ${verdict.missingReport.join(", ")}. Run \`pnpm test:coverage\` first.`);
      }
      if (verdict.regressions.length) {
        console.log(`\nFAIL: coverage dropped below its stored floor:\n  ${verdict.regressions.join("\n  ")}`);
      }
      if (verdict.stale.length) {
        console.log(`\nFAIL: stored floor is stale (measured coverage moved on without it):\n  ${verdict.stale.join("\n  ")}`);
      }
      if (verdict.ok) console.log("\nAll floored packages are within slack of their stored floor.");
    }
    process.exit(verdict.ok ? 0 : 1);
  }

  if (mergeIdx !== -1) {
    const outPath = resolve(
      argv[mergeIdx + 1] && !argv[mergeIdx + 1].startsWith("--")
        ? argv[mergeIdx + 1]
        : join(REPO_ROOT, "coverage", "lcov.info"),
    );
    const { text, fileCount } = mergeLcov(REPO_ROOT, reports);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, text, "utf8");
    const from = reports.filter((r) => r.lcovPresent).map((r) => r.pkg);
    console.log(`merged ${fileCount} files from ${from.length} package(s) (${from.join(", ")}) -> ${outPath}`);
    console.log(`
Feed it to the analyzer:
  code-metrics analyze . --changeset-strategy pr --coverage ${outPath}`);
    if (missing.length && !allowMissing) {
      console.error(
        `
FAIL: ${missing.length} package(s) contributed nothing: ${missing.map((r) => r.pkg).join(", ")}.
` +
          `A partial merge silently leaves those files on the co-change proxy — run \`pnpm test:coverage\` first,
` +
          `or pass --allow-missing if a partial report is what you meant.`,
      );
      process.exit(1);
    }
    process.exit(0);
  }

  if (lcovOnly) {
    for (const r of reports) if (r.lcovPresent) console.log(r.lcov);
    process.exit(missing.length && !allowMissing ? 1 : 0);
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          totals,
          packages: reports.map((r) => ({
            pkg: r.pkg,
            present: r.present,
            lcov: r.lcovPresent ? r.lcov : null,
            error: r.error,
            lines: r.total?.lines ?? null,
            files: r.fileCount ?? 0,
            zeroCoverageFileCount: r.zeroCoverageFiles?.length ?? 0,
          })),
        },
        null,
        2,
      ),
    );
  } else {
    console.log("coverage report (source: packages/*/coverage/coverage-summary.json)\n");
    console.log("package      files  lines            stmts    branch   funcs    lcov");
    for (const r of reports) {
      if (!r.present) {
        console.log(`${r.pkg.padEnd(12)} —      MISSING (${r.error})`);
        continue;
      }
      const l = r.total.lines;
      console.log(
        `${r.pkg.padEnd(12)} ${String(r.fileCount).padEnd(6)} ` +
          `${(l.pct + "%").padEnd(7)} ${String(l.covered + "/" + l.total).padEnd(9)} ` +
          `${(r.total.statements.pct + "%").padEnd(8)} ${(r.total.branches.pct + "%").padEnd(8)} ` +
          `${(r.total.functions.pct + "%").padEnd(8)} ${r.lcovPresent ? "yes" : "NO"}`,
      );
    }
    console.log(
      `\nTOTAL        —      ${totals.lines.pct}%   ${totals.lines.covered}/${totals.lines.total} lines, ` +
        `${totals.branches.pct}% branches, ${totals.functions.pct}% functions`,
    );
    const lcovs = reports.filter((r) => r.lcovPresent).map((r) => r.lcov);
    if (lcovs.length) {
      console.log(
        `\nFeed these to the analyzer so safety_net stops being a co-change guess:\n` +
          lcovs.map((p) => `  code-metrics analyze . --coverage ${p}`).join("\n"),
      );
    }
    // Root scripts/ has no vitest project, so v8 coverage can never see it. Say so
    // rather than letting a reader infer "absent from the report" = "0% covered".
    console.log(
      "\nNot in scope of any report: root scripts/*.mjs, packages/e2e, packages/desktop —\n" +
        "no vitest project owns them, so the co-change proxy remains the only signal there.",
    );
  }

  if (missing.length && !allowMissing) {
    console.error(
      `\nFAIL: ${missing.length} package(s) produced no coverage report: ${missing.map((r) => r.pkg).join(", ")}.\n` +
        `Run \`pnpm test:coverage\` first. If a package legitimately has no tests, remove it from\n` +
        `COVERED_PACKAGES in this script — do not leave it silently missing (that was #688's bug).`,
    );
    process.exit(1);
  }
  if (min !== null && totals.lines.pct < min) {
    console.error(`\nFAIL: total line coverage ${totals.lines.pct}% is below the --min ${min}% floor.`);
    process.exit(1);
  }
}

// Only run when invoked directly, so the tests can import the helpers above.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
