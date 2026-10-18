import { getDiffShortstat } from "./git.service.js";
import { resolveDiffRef } from "@agentic-kanban/shared/lib/git-service";

export interface WorkspaceDiffStatsInput {
  workingDir: string | null;
  baseBranch: string | null;
  isDirect: boolean;
  status: string;
}

export interface WorkspaceDiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/**
 * Per-worktree stats, kept briefly (#1614). The status console polls every few seconds; an idle
 * workspace's numbers do not move, and re-spawning `git diff` for 15 of them per poll is what
 * saturated the event loop. A sha-keyed cache would need its own rev-parse spawns, so this is a
 * TTL on (worktree, diff ref) instead. In-flight lookups are shared.
 */
const DIFF_STATS_TTL_MS = 30_000;
const diffStatsCache = new Map<string, { at: number; value: Promise<WorkspaceDiffStats | null> }>();

export function __resetDiffStatsCacheForTests(): void {
  diffStatsCache.clear();
}

export async function getWorkspaceDiffStats(
  workspace: WorkspaceDiffStatsInput,
  projectDefaultBranch: string | null,
  nowMs: number = Date.now(),
): Promise<WorkspaceDiffStats | null> {
  if (!workspace.workingDir || workspace.status === "closed") return null;

  const diffRef = resolveDiffRef(workspace, projectDefaultBranch);
  if (!diffRef) return null;

  const key = `${workspace.workingDir}\0${diffRef}`;
  const hit = diffStatsCache.get(key);
  if (hit && nowMs - hit.at < DIFF_STATS_TTL_MS) return hit.value;

  const value = getDiffShortstat(workspace.workingDir, diffRef);
  diffStatsCache.set(key, { at: nowMs, value });
  // Never cache a failure: the next poll should retry.
  value.catch(() => { if (diffStatsCache.get(key)?.value === value) diffStatsCache.delete(key); });
  return value;
}
