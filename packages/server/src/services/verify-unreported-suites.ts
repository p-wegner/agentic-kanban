/**
 * The suites a crashed vitest worker took with it (#1309).
 *
 * When a fork worker dies mid-file (`[vitest-pool]: Worker forks emitted error` / `Worker exited
 * unexpectedly`), every test that DID run can pass and the run still exits 1. The file that was
 * running never reports, so there is no `FAIL` line for the flake retry (#1110) to re-run, and
 * the sweep recorded a red with nothing named (rc/20261004-6: 1025 + 1 skipped of 1027 server
 * files, `project-relocate.service.test.ts` missing, and passing 3/3 on its own).
 *
 * This recovers the missing files from the run itself: per `[test:mine] <pkg>:` section, the
 * files vitest reported, the `Test Files … (N)` total, and the files vitest itself says that
 * run included (`vitest list --filesOnly` with the section's own `--exclude` globs, so the
 * package config's include/exclude rules apply exactly). It answers only when the arithmetic closes
 * EXACTLY (the files found missing equal the count the summary says is missing); anything less
 * certain returns `[]`, so a crash it cannot attribute stays red rather than being retried on a
 * guess.
 */
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { type FailedSuite, MAX_RETRYABLE_SUITES } from "./verify-flake-retry.js";

// eslint-disable-next-line no-control-regex -- stripping real ANSI SGR sequences
const ANSI = /\x1b\[[0-9;]*m/g;
const PACKAGE_HEADER = /^\s*\[test:mine\]\s+([a-z0-9@/-]+):\s+node vitest run(.*)$/i;
const REPORTED_FILE = /^\s*(?:✓|↓|×|❯|✗)\s+([\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?)\b/;
const TEST_FILES_SUMMARY = /^\s*Test Files\b.*\((\d+)\)\s*$/;
/** Vitest's own words for a worker that died; deliberately NOT the app's `unhandled error` logs. */
export const VITEST_WORKER_EXIT = /\[vitest-pool\]: Worker \w+ emitted error|Worker exited unexpectedly/;

/** Lists the files one package's vitest run included, package-relative; `[]` when it cannot tell. */
export type PackageTestLister = (packageLabel: string, excludes: string[]) => string[];

/**
 * The suites a worker crash left unreported, or `[]` when there was no worker crash or the
 * missing files cannot be pinned down exactly.
 */
export function findUnreportedSuites(output: string, listTests: PackageTestLister): FailedSuite[] {
  const lines = output.replace(ANSI, "").split(/\r?\n/);
  if (!lines.some((l) => VITEST_WORKER_EXIT.test(l))) return [];

  const out: FailedSuite[] = [];
  let label: string | null = null;
  let excludes: string[] = [];
  let reported = new Set<string>();
  const closeSection = (total: number, summaryReported: number): boolean => {
    if (!label) return true;
    // The count comes from vitest's own summary, never from how many file lines we matched.
    const missingCount = total - summaryReported;
    if (missingCount <= 0) return true;
    // The per-file lines must account for every file the summary says reported: vitest does not
    // list passing files when its output is not a TTY-like stream, and an empty listing would
    // otherwise make "every included file" look unreported.
    if (reported.size !== summaryReported || missingCount > MAX_RETRYABLE_SUITES) return false;
    const missing = listTests(label, excludes).filter((f) => !reported.has(f));
    if (missing.length !== missingCount) return false; // cannot attribute exactly: no answer
    for (const file of missing) out.push({ packageLabel: label, file });
    return true;
  };

  for (const line of lines) {
    const header = PACKAGE_HEADER.exec(line);
    if (header) {
      label = header[1]!;
      excludes = [...header[2].matchAll(/--exclude\s+(\S+)/g)].map((m) => m[1]);
      reported = new Set();
      continue;
    }
    if (!label) continue;
    const file = REPORTED_FILE.exec(line);
    if (file) {
      reported.add(file[1].replace(/\\/g, "/"));
      continue;
    }
    const summary = TEST_FILES_SUMMARY.exec(line);
    if (summary) {
      const summaryReported = [...line.matchAll(/(\d+)\s+(?:passed|failed|skipped|todo)/gi)].reduce((n, m) => n + Number(m[1]), 0);
      if (!closeSection(Number(summary[1]), summaryReported)) return [];
      label = null;
    }
  }
  return out;
}

/**
 * `listTests` for an installed checkout: asks that package's own vitest
 * (`packages/<label>`, where `scripts/test-mine.mjs` runs it) which files the run included.
 */
export function checkoutTestLister(workingDir: string): PackageTestLister {
  return (packageLabel, excludes) => {
    const pkgDir = join(workingDir, "packages", packageLabel);
    const args = [join(pkgDir, "node_modules", "vitest", "vitest.mjs"), "list", "--filesOnly", "--json"];
    for (const glob of excludes) args.push("--exclude", glob);
    const run = spawnSync(process.execPath, args, { cwd: pkgDir, windowsHide: true, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
    if (run.status !== 0 || !run.stdout) return [];
    try {
      return (JSON.parse(run.stdout) as { file: string }[]).map((e) => relative(pkgDir, e.file).replace(/\\/g, "/"));
    } catch {
      return [];
    }
  };
}
