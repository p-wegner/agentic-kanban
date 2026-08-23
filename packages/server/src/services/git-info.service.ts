/**
 * Facade over the two halves of "git info" (#728), keeping one import specifier for the
 * eight modules that already used it — the same compat-shim shape as
 * `services/git.service.ts`. Edit the halves, not this file.
 *
 * - `git-info/repo-detect.ts` — stateless repo DETECTION (which repo, which default
 *   branch, does a branch exist). Cheap, and called while a user waits.
 * - `git-info/project-stats.ts` — the STATS engine: commit counts, 12-week churn,
 *   hotspots, and the HEAD-keyed cache those three share.
 */

export type { RepoInfo } from "./git-info/repo-detect.js";
export { branchExists, detectDefaultBranch, detectRepoInfo } from "./git-info/repo-detect.js";

export type { ProjectGitStats } from "./git-info/project-stats.js";
export {
  getProjectGitStatsAsync,
  hotspotLogArgs,
  __seedMetricsCacheForTests,
  STALE_METRICS_BOUNDS_FOR_TEST,
  HOTSPOT_FALLBACK_COMMIT_LIMIT_FOR_TEST,
  collectCurrentCodeMetricsAsyncForTest,
  WALK_QUEUE_FLUSH_AT_FOR_TEST,
} from "./git-info/project-stats.js";
