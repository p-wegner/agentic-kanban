import { existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import type { ProjectStatsResponse } from "@agentic-kanban/shared";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
// The source-tree walk and path classification live in their own module (#340) — this
// one owns git history, repo detection and the metrics cache.
import {
  collectCurrentCodeMetricsAsync,
  emptyCodeMetrics,
  isSourceFile,
  isTestPath,
  normalizePath,
  WALK_QUEUE_FLUSH_AT,
} from "./git-info/code-metrics.js";
import { isMetricsEntryUsable, metricsCacheKey } from "../lib/metrics-cache-policy.js";

export interface RepoInfo {
  repoPath: string;
  repoName: string;
  defaultBranch: string | null;
  remoteUrl: string | null;
}

function execGit(args: string[], cwd: string): Promise<string> {
  return gitExecOrThrow(args, { cwd, maxBuffer: 1024 * 1024 }).then((stdout) => stdout.trim());
}

/** Async git exec with a timeout, mirroring the sync gitExecSync call options. Output is NOT trimmed. */
function execGitCapture(args: string[], cwd: string, timeout: number, maxBuffer = 1024 * 1024): Promise<string> {
  return gitExecOrThrow(args, { cwd, timeout, maxBuffer });
}

export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  const normalized = branch.trim();
  if (!normalized || normalized.startsWith("-")) return false;

  try {
    await execGit(["show-ref", "--verify", "--quiet", `refs/heads/${normalized}`], repoPath);
    return true;
  } catch {
    return false;
  }
}

async function detectDefaultBranch(repoPath: string): Promise<string | null> {
  for (const branch of ["main", "master"]) {
    if (await branchExists(repoPath, branch)) return branch;
  }
  return null;
}

/**
 * Detect git repo information from a local path.
 * Validates the path is a git repo and extracts branch/remote info.
 * Always resolves to the git repository root, so registering from a subdirectory
 * (e.g. packages/server) produces the same project as registering from the root.
 */
export async function detectRepoInfo(repoPath: string): Promise<RepoInfo> {
  const absPath = resolve(repoPath);

  // Resolve to the actual git root — prevents duplicate projects when a subdirectory
  // (e.g. packages/server) and the repo root both get registered separately.
  // Use resolve() to normalize the path (git outputs forward slashes on Windows).
  let gitRoot: string;
  try {
    gitRoot = resolve(await execGit(["rev-parse", "--show-toplevel"], absPath));
  } catch {
    throw new Error(`Not a git repository: ${absPath}`);
  }

  const defaultBranch = await detectDefaultBranch(gitRoot);

  // Get remote URL
  let remoteUrl: string | null = null;
  try {
    remoteUrl = await execGit(["remote", "get-url", "origin"], gitRoot);
  } catch {
    // No remote configured
  }

  const repoName = basename(gitRoot);

  return {
    repoPath: gitRoot,
    repoName,
    defaultBranch,
    remoteUrl,
  };
}

export interface ProjectGitStats {
  commitCount: number;
  recentCommits: { hash: string; message: string; date: string }[];
  detectedBranch: string | null;
  codeMetrics: ProjectStatsResponse["codeMetrics"];
  history: ProjectStatsResponse["history"];
  hotspots: ProjectStatsResponse["hotspots"];
}

const METRICS_CACHE_TTL_MS = 60_000;
// Generous enough that a loaded machine's git spawn doesn't blow this budget while the
// sibling (sync or async) call's spawn stays under it — an asymmetric timeout here used
// to make the two paths key the shared metrics cache under different HEAD values.
const HEAD_RESOLVE_TIMEOUT_MS = 5_000;
const HISTORY_WEEKS = 12;
const MAX_HOTSPOTS = 8;
// Per-commit `--numstat` is the expensive part of the history scan. On a very
// active repo (thousands of commits inside the HISTORY_WEEKS window) the full
// scan can run ~8s+, blowing a tight timeout — which silently emptied the
// hotspots / Crime Scene views. Give the windowed scan a generous (off-event-loop)
// budget, and cap the full-history fallback to a bounded, fast commit count so it
// always returns *something* even on repos whose windowed scan times out.
const HISTORY_LOG_TIMEOUT_MS = 15_000;
const HOTSPOT_FALLBACK_COMMIT_LIMIT = 1500;
const GIT_SEP = "\x1f";
type CachedMetrics = Pick<ProjectGitStats, "codeMetrics" | "history" | "hotspots">;
// Keyed on repo+branch; `head` is the sha the blob was computed at, used to invalidate
// rather than to identify the entry (see metricsCacheKey / isMetricsEntryUsable, #340).
const metricsCache = new Map<string, { timestamp: number; head: string | null; metrics: CachedMetrics }>();
// Dedupes concurrent cold computations: requests arriving while a compute for the same
// repo+head is in flight await the shared promise instead of each spawning the walk.
const inflightMetrics = new Map<string, Promise<CachedMetrics>>();

function emptyHistory(): ProjectStatsResponse["history"] {
  return { weeks: buildEmptyWeeks(), contributorCount: 0, topContributors: [] };
}

function weekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function buildEmptyWeeks(): ProjectStatsResponse["history"]["weeks"] {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (HISTORY_WEEKS - 1) * 7);
  const weeks: ProjectStatsResponse["history"]["weeks"] = [];
  for (let i = 0; i < HISTORY_WEEKS; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i * 7);
    weeks.push({ week: weekKey(d), commits: 0, insertions: 0, deletions: 0, net: 0, productionNet: 0, testNet: 0 });
  }
  return weeks;
}

/** Pure parser for `git log --format=commit<SEP>%aI<SEP>%an --numstat` output, shared by sync and async paths. */
function parseHistoryLog(
  weeks: ProjectStatsResponse["history"]["weeks"],
  logOut: string,
): Pick<ProjectGitStats, "history" | "hotspots"> {
  const weekMap = new Map(weeks.map((week) => [week.week, week]));
  const contributors = new Map<string, number>();
  const hotspots = new Map<string, { path: string; additions: number; deletions: number; changes: number }>();

  let currentWeek: string | null = null;
  for (const line of logOut.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith(`commit${GIT_SEP}`)) {
      const [, iso, author] = line.split(GIT_SEP);
      currentWeek = iso ? weekKey(new Date(iso)) : null;
      const week = currentWeek ? weekMap.get(currentWeek) : null;
      if (week) week.commits++;
      if (author) contributors.set(author, (contributors.get(author) ?? 0) + 1);
      continue;
    }

    if (!currentWeek) continue;
    const week = weekMap.get(currentWeek);
    if (!week) continue;
    const [addedRaw, deletedRaw, pathRaw] = line.split("\t");
    if (!pathRaw || addedRaw === "-" || deletedRaw === "-") continue;
    if (!isSourceFile(pathRaw)) continue;
    const additions = Number.parseInt(addedRaw, 10) || 0;
    const deletions = Number.parseInt(deletedRaw, 10) || 0;
    const net = additions - deletions;
    week.insertions += additions;
    week.deletions += deletions;
    week.net += net;
    if (isTestPath(pathRaw)) week.testNet += net;
    else week.productionNet += net;

    const path = normalizePath(pathRaw);
    const existing = hotspots.get(path) ?? { path, additions: 0, deletions: 0, changes: 0 };
    existing.additions += additions;
    existing.deletions += deletions;
    existing.changes += additions + deletions;
    hotspots.set(path, existing);
  }

  return {
    history: {
      weeks,
      contributorCount: contributors.size,
      topContributors: [...contributors.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, commits]) => ({ name, commits })),
    },
    hotspots: [...hotspots.values()].sort((a, b) => b.changes - a.changes).slice(0, MAX_HOTSPOTS),
  };
}

function historyLogArgs(since: string, branch: string): string[] {
  return ["log", branch, `--since=${since}`, `--format=commit${GIT_SEP}%aI${GIT_SEP}%an`, "--numstat", "--"];
}

/** Exported for tests: the commit cap that keeps the fallback hotspot scan bounded/fast. */
export const HOTSPOT_FALLBACK_COMMIT_LIMIT_FOR_TEST = HOTSPOT_FALLBACK_COMMIT_LIMIT;
/** Test hook for the bounded source walk (#340) — lets a test inject the wall-clock budget. */
export const collectCurrentCodeMetricsAsyncForTest = collectCurrentCodeMetricsAsync;
export const WALK_QUEUE_FLUSH_AT_FOR_TEST = WALK_QUEUE_FLUSH_AT;

/**
 * Full-history (capped) variant used to populate hotspots for dormant repos.
 * The windowed weekly chart still drives off `historyLogArgs`, but a project whose
 * latest commit is older than HISTORY_WEEKS would otherwise yield zero hotspots —
 * leaving the Crime Scene / Hot Files views empty even though there's churn to show.
 */
export function hotspotLogArgs(branch: string): string[] {
  return ["log", branch, `--max-count=${HOTSPOT_FALLBACK_COMMIT_LIMIT}`, `--format=commit${GIT_SEP}%aI${GIT_SEP}%an`, "--numstat", "--"];
}

/**
 * Parse `--numstat` log output into ranked hotspots only, ignoring week binning.
 * Used as a fallback when the windowed parse found no source churn in the recent window.
 */
function parseHotspotsLog(logOut: string): ProjectGitStats["hotspots"] {
  const hotspots = new Map<string, { path: string; additions: number; deletions: number; changes: number }>();

  for (const line of logOut.split(/\r?\n/)) {
    if (!line || line.startsWith(`commit${GIT_SEP}`)) continue;
    const [addedRaw, deletedRaw, pathRaw] = line.split("\t");
    if (!pathRaw || addedRaw === "-" || deletedRaw === "-") continue;
    if (!isSourceFile(pathRaw)) continue;
    const additions = Number.parseInt(addedRaw, 10) || 0;
    const deletions = Number.parseInt(deletedRaw, 10) || 0;
    const path = normalizePath(pathRaw);
    const existing = hotspots.get(path) ?? { path, additions: 0, deletions: 0, changes: 0 };
    existing.additions += additions;
    existing.deletions += deletions;
    existing.changes += additions + deletions;
    hotspots.set(path, existing);
  }

  return [...hotspots.values()].sort((a, b) => b.changes - a.changes).slice(0, MAX_HOTSPOTS);
}

/** Collect windowed history + hotspots without blocking — same git invocation and parsing as the retired sync twin (#401). */
async function collectHistoryMetricsAsync(repoPath: string, branch: string): Promise<Pick<ProjectGitStats, "history" | "hotspots">> {
  const weeks = buildEmptyWeeks();
  let logOut = "";

  try {
    logOut = await execGitCapture(historyLogArgs(weeks[0].week, branch), repoPath, HISTORY_LOG_TIMEOUT_MS, 4 * 1024 * 1024);
  } catch {
    // Git history is best-effort. Current LOC still makes the metrics view useful.
  }

  const result = parseHistoryLog(weeks, logOut);
  if (result.hotspots.length === 0) {
    try {
      const fullOut = await execGitCapture(hotspotLogArgs(branch), repoPath, HISTORY_LOG_TIMEOUT_MS, 4 * 1024 * 1024);
      result.hotspots = parseHotspotsLog(fullOut);
    } catch {
      // Fallback is best-effort; an empty hotspot list is acceptable.
    }
  }
  return result;
}

/**
 * Compute (or serve cached) code metrics + history for a repo. Shares the 60s cache; concurrent
 * cold computes for the same key share one in-flight promise instead of each spawning
 * the full source walk + git history scan.
 *
 * Stale-while-revalidate (#340): an EXPIRED entry is served immediately (last known
 * good) while a background refresh replaces it — the same philosophy the board summary
 * cache already uses. Only a true first sighting, with nothing cached at all, waits for
 * the walk. This is what keeps a poll-path request off the walk entirely in steady
 * state; values may be one refresh cycle behind.
 */
async function collectProjectCodeAndHistoryAsync(repoPath: string, branch: string): Promise<CachedMetrics> {
  let head: string | null;
  try {
    head = (await execGitCapture(["rev-parse", branch], repoPath, HEAD_RESOLVE_TIMEOUT_MS)).trim();
  } catch {
    head = null;
  }
  const cacheKey = metricsCacheKey(repoPath, branch);
  const cached = metricsCache.get(cacheKey);
  if (isMetricsEntryUsable(cached, head, METRICS_CACHE_TTL_MS, Date.now())) return cached!.metrics;

  const inflight = inflightMetrics.get(cacheKey);
  if (inflight) return cached ? cached.metrics : inflight;

  const compute = (async () => {
    const codeMetrics = await collectCurrentCodeMetricsAsync(repoPath);
    const { history, hotspots } = await collectHistoryMetricsAsync(repoPath, branch);
    const metrics = { codeMetrics, history, hotspots };
    metricsCache.set(cacheKey, { timestamp: Date.now(), head, metrics });
    return metrics;
  })();
  // Clear the in-flight slot regardless of outcome; the cache write above is the success path.
  const tracked = compute.finally(() => {
    inflightMetrics.delete(cacheKey);
  });
  inflightMetrics.set(cacheKey, tracked);
  if (cached) {
    // Serve last-known-good now; the refresh above lands in the cache for the next caller.
    // Its rejection must not surface as an unhandled rejection on this detached path.
    void tracked.catch(() => {});
    return cached.metrics;
  }
  return tracked;
}

function parseRecentCommits(logOut: string): { hash: string; message: string; date: string }[] {
  return logOut.split("\n").filter(Boolean).map((line) => {
    const parts = line.split(GIT_SEP);
    return { hash: (parts[0] ?? "").slice(0, 7), message: parts[1] ?? "", date: parts[2] ?? "" };
  });
}

/**
 * Project git stats — all git/filesystem work runs off the event loop (promisified
 * execFile + fs.promises), so a cold metrics compute never blocks concurrent requests.
 * The sync twin (`getProjectGitStats` + its `collectHistoryMetrics` /
 * `collectProjectCodeAndHistory` helpers, `gitExecSync`-based) was removed in #401 —
 * it had no production caller left and blocked the loop for up to 15s.
 */
export async function getProjectGitStatsAsync(repoPath: string, defaultBranch: string | null): Promise<ProjectGitStats> {
  let commitCount = 0;
  let recentCommits: { hash: string; message: string; date: string }[] = [];

  let branch = defaultBranch;
  if (!branch) {
    branch = await detectDefaultBranch(repoPath);
  }

  if (!branch) return {
    commitCount,
    recentCommits,
    detectedBranch: null,
    codeMetrics: emptyCodeMetrics(),
    history: emptyHistory(),
    hotspots: [],
  };

  try {
    const countOut = (await execGitCapture(["rev-list", "--count", branch], repoPath, 5000)).trim();
    commitCount = parseInt(countOut, 10) || 0;
    // Use ASCII unit separator (\x1f) to avoid conflicts with commit message content
    const logOut = (await execGitCapture(["log", branch, `--format=%H${GIT_SEP}%s${GIT_SEP}%cr`, "-10"], repoPath, 5000)).trim();
    recentCommits = parseRecentCommits(logOut);
  } catch { /* git unavailable or no commits */ }

  const metrics = existsSync(repoPath)
    ? await collectProjectCodeAndHistoryAsync(repoPath, branch)
    : { codeMetrics: emptyCodeMetrics(), history: emptyHistory(), hotspots: [] };
  return { commitCount, recentCommits, detectedBranch: branch, ...metrics };
}
