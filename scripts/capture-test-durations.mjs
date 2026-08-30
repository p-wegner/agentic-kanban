#!/usr/bin/env node
/**
 * Capture real per-test-file durations into `docs/tests/durations.json` (#955).
 *
 * Why this exists: `impact.mjs select --budget 60s` prints `duration unmeasured (budget assumes
 * 3s/file)` unless the map was built with `--durations`. Two consequences — a "60s" tier can be
 * minutes, and ranking is `score / durationMs` with a CONSTANT denominator, so a slow high-signal
 * suite and a fast one rank identically. This script produces the report; the monitor's
 * test-impact-map phase re-feeds it on every rebuild (`impact.mjs build --durations <report>`),
 * because `build` reads durations only from that flag and never carries them over.
 *
 * Run it where a full run is happening anyway — the suite is ~7,000 tests and has been observed
 * at ~15 min under contention. Durations change far more slowly than the import graph, so
 * refreshing this report is occasional; re-feeding it is every rebuild.
 *
 *   node scripts/capture-test-durations.mjs              # run every package, write the report
 *   node scripts/capture-test-durations.mjs --out x.json # elsewhere
 *   node scripts/capture-test-durations.mjs --merge a.json b.json   # merge existing reports only
 *
 * Output shape is the subset of vitest's `--reporter=json` that `readDurations` consumes:
 * `{ testResults: [{ name, startTime, endTime }] }`, with `name` an absolute path (the skill
 * relativizes it against the repo root). Merging several package runs into one file is the
 * whole point: each package's own report carries only its own files.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The packages whose suites feed the map. Mirrors the `test:full` filter list. */
const PACKAGES = [
  { dir: "packages/shared", name: "@agentic-kanban/shared" },
  { dir: "packages/server", name: "agentic-kanban" },
  { dir: "packages/mcp-server", name: "@agentic-kanban/mcp-server" },
  { dir: "packages/client", name: "@agentic-kanban/client" },
];

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const outPath = resolve(ROOT, flag("out", "docs/tests/durations.json"));
const mergeIdx = argv.indexOf("--merge");

/**
 * Read one vitest JSON report into `{absolutePath: durationMs}`.
 *
 * A file that appears in several reports keeps its LONGEST observed time. That is the honest
 * direction for a budget: under-estimating is what makes a "60s" tier overrun, and a suite is
 * more likely to have been measured while contended than while idle.
 */
function collect(reportPath, into) {
  // `replace(/^﻿/, "")`: a BOM makes `JSON.parse` throw on otherwise-valid JSON, and on
  // Windows it is easy to acquire one by writing the report with any UTF-8-with-BOM tool.
  const json = JSON.parse(readFileSync(reportPath, "utf8").replace(/^﻿/, ""));
  for (const r of json.testResults ?? []) {
    if (!r?.name) continue;
    const ms = Math.max(1, (r.endTime ?? 0) - (r.startTime ?? 0));
    const key = repoRelative(r.name);
    if (!key) continue; // outside the repo — not a file the map has an entry for
    if (!into.has(key) || into.get(key) < ms) into.set(key, ms);
  }
  return into;
}

/**
 * Repo-relative, forward slashes — because this report is COMMITTED and read on other machines.
 *
 * vitest reports absolute paths, so writing them through verbatim would bake this checkout's
 * `C:\projects\...` into a shared file; the skill's `rel()` is `relative(ROOT, name)`, which on
 * another clone would relativize those into `../../..` garbage and match no map entry — silently,
 * as zero measured durations. A repo-relative path survives `resolve(ROOT, …)` on any checkout.
 */
function repoRelative(name) {
  const rel = relative(ROOT, resolve(ROOT, name)).split(sep).join("/");
  return rel.startsWith("..") ? null : rel;
}

function write(durations) {
  // Sorted, so a re-capture produces a minimal, readable diff rather than a reshuffled file.
  const names = [...durations.keys()].sort();
  const testResults = names.map((name) => ({ name, startTime: 0, endTime: durations.get(name) }));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify({ testResults }, null, 1)}\n`);
  const total = names.reduce((a, n) => a + durations.get(n), 0);
  console.log(
    `[durations] wrote ${outPath}: ${names.length} test files, ` +
    `${Math.round(total / 1000)}s total, median ${median(names.map((n) => durations.get(n)))}ms`,
  );
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

if (mergeIdx >= 0) {
  // Stop at the next `--flag`, rather than filtering flags out: a plain `--merge a.json b.json
  // --out x.json` would otherwise swallow `x.json` as a third INPUT (and then fail on it, since
  // it does not exist yet).
  const inputs = [];
  for (const arg of argv.slice(mergeIdx + 1)) {
    if (arg.startsWith("--")) break;
    inputs.push(arg);
  }
  if (!inputs.length) {
    console.error("[durations] --merge needs at least one vitest JSON report");
    process.exit(2);
  }
  const durations = new Map();
  for (const input of inputs) collect(resolve(input), durations);
  write(durations);
  process.exit(0);
}

const scratch = join(tmpdir(), `kanban-durations-${process.pid}`);
mkdirSync(scratch, { recursive: true });
const durations = new Map();
let failedPackages = 0;

try {
  for (const pkg of PACKAGES) {
    const report = join(scratch, `${pkg.dir.replace(/[/\\]/g, "__")}.json`);
    console.log(`[durations] running ${pkg.name} …`);
    try {
      // `--maxWorkers=4`: this box runs a merge gate and a base-health probe alongside; letting
      // vitest take one worker per core is what makes the recorded times encode contention
      // rather than the suite.
      execFileSync(
        "pnpm",
        ["--filter", pkg.name, "exec", "vitest", "run", "--maxWorkers=4",
         "--reporter=json", "--outputFile", report],
        { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"], shell: process.platform === "win32" },
      );
    } catch {
      // A red suite still produced timings for everything that ran. Recording them is strictly
      // better than recording nothing — the report is a budget input, not a gate.
      failedPackages++;
      console.warn(`[durations] ${pkg.name} exited non-zero; using whatever it reported`);
    }
    if (existsSync(report)) collect(report, durations);
    else console.warn(`[durations] ${pkg.name} wrote no report at ${report}`);
  }
  write(durations);
  if (failedPackages) {
    console.warn(`[durations] NOTE: ${failedPackages} package(s) had failures — durations are partial`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
