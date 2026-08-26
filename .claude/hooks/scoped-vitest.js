#!/usr/bin/env node
/**
 * Scoped Vitest — run only the tests RELATED to the files this session edited.
 *
 * Replaces the old Stop check `pnpm --filter @agentic-kanban/server test` with a
 * 60s timeout (#280). That check was structurally impossible to pass: the server
 * suite is ~4,165 tests and takes 20–40 min under load, so every server-editing
 * session burned its whole budget, got SIGTERM'd, reported a fail-closed
 * "hook infrastructure failure" that looked like a real veto, and — worst —
 * spawned an extra full vitest fleet onto an already loaded box, competing with
 * whatever pre-merge gate was running.
 *
 * Instead: map the edited files to their package, then run `vitest related` on
 * them, with worker parallelism capped. `vitest related` resolves the module
 * graph, so editing a source file runs the suites that import it (directly or
 * transitively) — the signal the Stop check was actually after.
 *
 * Contract with smart-hooks-runner.js:
 *   - reads the edited-file list from SMART_HOOKS_EDITED_FILES (JSON array of
 *     repo-relative paths); exits 0 when there is nothing in scope,
 *   - exit 0 = pass, non-zero + stderr = fail (the runner surfaces the output).
 *
 * Worker cap: vitest defaults to `maxWorkers = cpus/2` with `pool: "forks"`, and
 * full isolation means each fork re-transforms its own module graph. Measured on
 * this repo, a suite that takes 1.27s standalone shows 30–96s of import time
 * under full fan-out (#278) — the fan-out is self-defeating on a loaded box, so
 * a small cap is faster in wall-clock AND leaves the machine usable.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  capacityHold,
  budgetMs,
  hitBudget,
  killTree,
  budgetMessage,
} = require("./machine-capacity.js");

// Repo-relative package dir -> pnpm filter name. Longest prefix wins, so
// `packages/server/...` never matches a shorter sibling by accident.
const PACKAGES = [
  { dir: "packages/server", filter: "agentic-kanban" },
  { dir: "packages/shared", filter: "shared" },
  { dir: "packages/mcp-server", filter: "@agentic-kanban/mcp-server" },
  { dir: "packages/client", filter: "client" },
];

const MAX_WORKERS = process.env.SCOPED_VITEST_MAX_WORKERS || "2";

function repoRoot() {
  // The hook lives at <root>/.claude/hooks/, so the root is two levels up. Do not
  // shell out to git for this — every avoided spawn matters here (#279).
  return path.resolve(__dirname, "..", "..");
}

function editedFiles() {
  const raw = process.env.SMART_HOOKS_EDITED_FILES;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((f) => typeof f === "string") : [];
  } catch {
    return [];
  }
}

function packageFor(relPath) {
  const normalized = relPath.replace(/\\/g, "/");
  let best = null;
  for (const pkg of PACKAGES) {
    if (normalized.startsWith(`${pkg.dir}/`) && (!best || pkg.dir.length > best.dir.length)) {
      best = pkg;
    }
  }
  return best;
}

function main() {
  const root = repoRoot();
  const files = editedFiles();
  if (files.length === 0) process.exit(0);

  // Group surviving TS/TSX files by owning package, as paths relative to that
  // package (vitest resolves `related` args against its own root).
  const byPackage = new Map();
  for (const file of files) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const pkg = packageFor(file);
    if (!pkg) continue;
    // A deleted file (edited then removed) would make vitest error out.
    if (!fs.existsSync(path.join(root, file))) continue;
    const rel = file.replace(/\\/g, "/").slice(`${pkg.dir}/`.length);
    if (!byPackage.has(pkg.filter)) byPackage.set(pkg.filter, []);
    byPackage.get(pkg.filter).push(rel);
  }

  if (byPackage.size === 0) process.exit(0);

  // Even scoped, this spawns a vitest per package. On a box already swapping that
  // is the #280 failure in miniature — so stand down loudly instead (see
  // machine-capacity.js). Not a code failure: nothing ran, nothing is claimed.
  const gate = capacityHold({ label: `Scoped vitest (${byPackage.size} package(s))` });
  if (gate.hold) {
    console.error(`[smart-hooks] ${gate.reason}`);
    process.exit(0);
  }

  // Wall-clock budget across all packages. Without `timeout` the spawn relied on
  // the runner's outer 300s kill, which reaps cmd.exe and leaves the vitest fork
  // workers alive, reparented — the leak machine-capacity.js documents. Budget
  // here, kill the tree ourselves, and report the stand-down honestly.
  const budget = budgetMs("SCOPED_VITEST_BUDGET_MS", 120_000);
  const startedAt = Date.now();
  let overBudget = false;

  const failures = [];
  for (const [filter, relFiles] of byPackage) {
    const remaining = budget - (Date.now() - startedAt);
    if (remaining <= 0) {
      overBudget = true;
      break;
    }
    const args = [
      "--filter",
      filter,
      "exec",
      "vitest",
      "related",
      ...relFiles,
      "--run",
      // NOTE: vitest 4 rejects `--minWorkers` (CACError: Unknown option). Only
      // --maxWorkers is a valid CLI flag here.
      `--maxWorkers=${MAX_WORKERS}`,
      // No related test for an edited file is a pass, not an error — plenty of
      // source files legitimately have no direct suite.
      "--passWithNoTests",
      // Stop at the first failing file. `vitest related` is bounded by the module
      // graph, not by a file count: editing something widely imported (a barrel, a
      // type module) can resolve to hundreds of suites, and then this check is the
      // full-suite run it exists to avoid. A hook only needs to answer "did I break
      // something" — the exhaustive list is the pre-merge gate's job, so paying for
      // failures 2..N here buys nothing and costs the whole budget.
      "--bail=1",
    ];
    const result = spawnSync("pnpm", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      shell: process.platform === "win32",
      timeout: remaining,
    });
    if (hitBudget(result)) {
      overBudget = true;
      killTree(result.pid);
      break;
    }
    if (result.status !== 0) {
      failures.push(
        `--- ${filter} (${relFiles.length} edited file(s)) ---\n` +
        summarizeVitestOutput(result.stdout || "", result.stderr || ""),
      );
    }
  }

  if (failures.length > 0) {
    console.error(
      `Scoped vitest failed for ${failures.length} package(s). These are the suites related to\n` +
      `the files this session edited — not the full suite.\n`
    );
    console.error(failures.join("\n\n"));
    process.exit(1);
  }
  if (overBudget) {
    // Report AFTER real failures: a genuine red result found before the budget
    // ran out is the more useful answer, and must not be downgraded to a skip.
    console.error(`[smart-hooks] ${budgetMessage("Scoped vitest", budget)}`);
  }
  process.exit(0);
}

/**
 * Build a readable excerpt of a failed vitest run.
 *
 * A blind tail of stdout+stderr is useless here, and that is not hypothetical: the
 * first version of this hook did exactly that and the reported block contained 4000
 * characters of repeated `[repo-lock] refusing to acquire` stderr noise with the
 * "Test Files / Tests" summary and every FAIL line scrolled off. A hook whose output
 * doesn't say what failed is the #280 problem again in a new costume.
 *
 * So: pull the lines that carry signal (assertion/FAIL markers and the count summary)
 * and only then fall back to a tail of STDOUT, where vitest writes its report.
 */
function summarizeVitestOutput(stdout, stderr, maxChars = 3000) {
  const signalRe = /(^\s*(FAIL|✗|×|→)\s|^\s*Test Files\s|^\s*Tests\s|AssertionError|Unhandled Error|^\s*❯\s)/;
  const signalLines = [...stdout.split("\n"), ...stderr.split("\n")]
    .filter((line) => signalRe.test(line))
    // Repeated identical noise adds nothing.
    .filter((line, i, all) => all.indexOf(line) === i);

  if (signalLines.length > 0) {
    const joined = signalLines.join("\n");
    return joined.length <= maxChars ? joined : `${joined.slice(0, maxChars)}\n… (truncated)`;
  }

  const text = stdout.trim() || stderr.trim();
  if (text.length <= maxChars) return text;
  return `… (truncated ${text.length - maxChars} chars)\n${text.slice(-maxChars)}`;
}

main();
