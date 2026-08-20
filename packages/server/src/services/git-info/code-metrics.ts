// Source-tree LOC metrics: path classification, the per-file tally, and the two
// repo walks (sync + bounded async) behind `GET /api/projects/:id/stats`.
//
// Split out of git-info.service.ts (#340): that module holds git-history scanning,
// repo detection AND this walk, and had grown past the cohesion gate's top-level
// declaration ceiling. Nothing here spawns git or touches the cache — it is pure
// filesystem + arithmetic, which also makes the walk bounds directly unit-testable.
// git-info.service.ts re-exports what its history parsing still needs.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import type { ProjectStatsResponse } from "@agentic-kanban/shared";

export const MAX_SOURCE_FILES = 6000;
export const MAX_SOURCE_BYTES = 750_000;
// Bounds on the async source walk (#340). The walk is latency-bound on the libuv
// thread pool, so a modest amount of parallelism collapses minutes into seconds;
// the wall-clock budget is the backstop that guarantees a stats request can never
// again occupy the process for 500s. Files are queued across directories and
// flushed once the queue is deep enough to actually saturate WALK_CONCURRENCY.
export const WALK_CONCURRENCY = 12;
export const WALK_QUEUE_FLUSH_AT = 96;
export const WALK_BUDGET_MS = 10_000;

const SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vite",
  ".worktrees",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);
const SOURCE_FILE_RE = /\.(c|cc|cpp|cs|css|go|h|hpp|html|java|js|jsx|kt|mjs|py|rb|rs|scss|sh|sql|svelte|swift|ts|tsx|vue)$/;
const TEST_PATH_RE = /(^|\/)(__tests__|__mocks__|test|tests|spec|e2e|playwright)(\/|$)|\.(test|spec)\.[^./]+$/;

export function emptyCodeMetrics(): ProjectStatsResponse["codeMetrics"] {
  return {
    generatedAt: new Date().toISOString(),
    productionLoc: 0,
    testLoc: 0,
    totalLoc: 0,
    testRatio: 0,
    productionFiles: 0,
    testFiles: 0,
    sourceFilesScanned: 0,
  };
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function isSourceFile(path: string): boolean {
  const normalized = normalizePath(path);
  return SOURCE_FILE_RE.test(normalized) && !normalized.endsWith(".d.ts");
}

export function isTestPath(path: string): boolean {
  return TEST_PATH_RE.test(normalizePath(path));
}

function countLoc(text: string): number {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

function tallySourceFile(codeMetrics: ProjectStatsResponse["codeMetrics"], relPath: string, loc: number): void {
  codeMetrics.sourceFilesScanned++;
  codeMetrics.totalLoc += loc;
  if (isTestPath(relPath)) {
    codeMetrics.testLoc += loc;
    codeMetrics.testFiles++;
  } else {
    codeMetrics.productionLoc += loc;
    codeMetrics.productionFiles++;
  }
}

function finalizeCodeMetrics(codeMetrics: ProjectStatsResponse["codeMetrics"]): ProjectStatsResponse["codeMetrics"] {
  codeMetrics.testRatio = codeMetrics.totalLoc > 0
    ? Number(((codeMetrics.testLoc / codeMetrics.totalLoc) * 100).toFixed(1))
    : 0;
  return codeMetrics;
}

export function collectCurrentCodeMetrics(repoPath: string): ProjectStatsResponse["codeMetrics"] {
  const codeMetrics = emptyCodeMetrics();
  const stack = [repoPath];

  while (stack.length > 0 && codeMetrics.sourceFilesScanned < MAX_SOURCE_FILES) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(path);
        continue;
      }
      if (!entry.isFile() || !isSourceFile(path)) continue;

      try {
        if (statSync(path).size > MAX_SOURCE_BYTES) continue;
        const rel = normalizePath(relative(repoPath, path));
        const loc = countLoc(readFileSync(path, "utf8"));
        tallySourceFile(codeMetrics, rel, loc);
      } catch {
        // Ignore unreadable generated or transient files.
      }
    }
  }

  return finalizeCodeMetrics(codeMetrics);
}

/**
 * Async twin of collectCurrentCodeMetrics — same walk and same limits, but never
 * blocks the event loop AND is bounded in both time and I/O shape (#340).
 *
 * The original version awaited one stat() + one readFile() per file, strictly
 * serially, for up to MAX_SOURCE_FILES files. Every fs.promises op goes through the
 * 4-thread libuv pool, which on a busy board is shared with dozens of agent
 * output-file watchers polling every 500ms; under that contention each file costs
 * tens of ms and the walk measured 75-509s server-side (and, with several requests
 * piling up, stalled every other endpoint).
 *
 * Two bounds fix that:
 *  - **Bounded parallelism.** The walk is latency-bound, not CPU-bound, so files are
 *    tallied WALK_CONCURRENCY at a time. Files are queued across directories rather
 *    than batched per-directory, so a repo of many small directories still gets full
 *    parallelism.
 *  - **A wall-clock budget.** On expiry the walk stops and returns what it scanned.
 *    sourceFilesScanned reflects the truth, so a partial result is visibly partial
 *    rather than silently wrong, and an unbounded recompute can never again monopolise
 *    the single Node thread for minutes.
 */
export async function collectCurrentCodeMetricsAsync(
  repoPath: string,
  budgetMs = WALK_BUDGET_MS,
): Promise<ProjectStatsResponse["codeMetrics"]> {
  const codeMetrics = emptyCodeMetrics();
  const deadline = Date.now() + budgetMs;
  const stack = [repoPath];
  const pending: string[] = [];

  const outOfBudget = (): boolean =>
    Date.now() >= deadline || codeMetrics.sourceFilesScanned >= MAX_SOURCE_FILES;

  /** Tally `pending` with at most WALK_CONCURRENCY reads in flight, then clear it. */
  const drainPending = async (): Promise<void> => {
    while (pending.length > 0 && !outOfBudget()) {
      const batch = pending.splice(0, WALK_CONCURRENCY);
      const tallies = await Promise.all(batch.map(async (path) => {
        try {
          if ((await stat(path)).size > MAX_SOURCE_BYTES) return null;
          return { rel: normalizePath(relative(repoPath, path)), loc: countLoc(await readFile(path, "utf8")) };
        } catch {
          return null; // Ignore unreadable generated or transient files.
        }
      }));
      for (const tally of tallies) {
        if (tally) tallySourceFile(codeMetrics, tally.rel, tally.loc);
      }
    }
    pending.length = 0;
  };

  while (stack.length > 0 && !outOfBudget()) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(path);
        continue;
      }
      if (!entry.isFile() || !isSourceFile(path)) continue;
      pending.push(path);
    }

    if (pending.length >= WALK_QUEUE_FLUSH_AT) await drainPending();
  }

  await drainPending();

  return finalizeCodeMetrics(codeMetrics);
}
