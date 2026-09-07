import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { getCommitSummariesBetween } from "@agentic-kanban/shared/lib/git-service";

/** A single commit ahead of the pinned stable tag. */
export interface StableSkewCommit {
  sha: string;
  message: string;
  /** `fix(#123): ...` / `feat(#123): ...` — a ticket-referencing commit, not incidental churn. */
  isFixShaped: boolean;
}

export interface StableSkew {
  /** Newest `stable-*` tag in the repo — what the operating (stable) board is pinned to. */
  stableTag: string;
  /** Total commits reachable from `headRef` but not yet from `stableTag`. */
  aheadCount: number;
  /** Up to `STABLE_SKEW_COMMIT_LIMIT` of those commits, newest first. */
  commits: StableSkewCommit[];
  /** How many of `commits` look fix/feat-shaped — the ones worth flagging as "not live yet". */
  fixShapedCount: number;
}

const STABLE_TAG_RE = /^stable-(\d{8})(?:-(\d+))?$/;
const FIX_SHAPED_RE = /^(fix|feat)\(#?\d+\)/i;
const STABLE_SKEW_COMMIT_LIMIT = 20;

/**
 * Mirrors `scripts/promote-plan.mjs`'s `parseStableTag`/`sortStableTags` (newest-first: by
 * date, then by same-day ordinal). Duplicated rather than imported: that module is scripts-tier
 * (`.mjs`, not part of the published `packages/server` — see its own header on this split) while
 * this needs to run from server code that ships in the npm package.
 */
function sortStableTags(tags: string[]): string[] {
  return tags
    .map((tag) => {
      const m = STABLE_TAG_RE.exec(tag.trim());
      return m ? { tag: tag.trim(), date: m[1], ordinal: m[2] ? Number(m[2]) : 1 } : null;
    })
    .filter((t): t is { tag: string; date: string; ordinal: number } => t !== null)
    .sort((a, b) => (a.date === b.date ? b.ordinal - a.ordinal : b.date.localeCompare(a.date)))
    .map((t) => t.tag);
}

/**
 * How far `headRef` (the project's default branch) has drifted ahead of the newest `stable-*`
 * promotion tag — the sha the operating (stable) board is actually running (`docs/two-boards.md`,
 * `pnpm promote`). A "Done" ticket whose fix landed on the branch but not yet on this tag is not
 * live: #1039 sat "Done" for a full day while the stable board kept running the pre-fix code, with
 * nothing surfacing that gap. This is that surface.
 *
 * Returns `null` when the repo carries no `stable-*` tag (not run under the two-board promote
 * flow, or nothing promoted yet) or when `headRef` is not ahead of it at all — callers should
 * OMIT the field in that case rather than render a confusing zero-risk entry.
 */
export async function computeStableSkew(
  repoPath: string,
  headRef = "master",
): Promise<StableSkew | null> {
  const tagList = await gitExec(["tag", "--list", "stable-*"], { cwd: repoPath });
  if (tagList.error) return null;
  const tags = tagList.stdout.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
  const stableTag = sortStableTags(tags)[0];
  if (!stableTag) return null;

  const summaries = await getCommitSummariesBetween(repoPath, stableTag, headRef);
  if (summaries.length === 0) return null;

  const commits: StableSkewCommit[] = summaries.slice(0, STABLE_SKEW_COMMIT_LIMIT).map((c) => ({
    sha: c.sha,
    message: c.message,
    isFixShaped: FIX_SHAPED_RE.test(c.message),
  }));

  return {
    stableTag,
    aheadCount: summaries.length,
    commits,
    fixShapedCount: commits.filter((c) => c.isFixShaped).length,
  };
}
