import { isNotNull } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { workspaces } from "../schema/index.js";
import type * as schema from "../schema/index.js";
import { samePath } from "./path-key.js";
import { holdsLiveResources } from "./workspace-liveness.js";
import { errorMessage } from "./error-message.js";

/**
 * ONE place that answers "does a live workspace still claim this working directory?" —
 * and the ONE guarded worktree removal built on top of that answer (#713).
 *
 * Why this module exists at all: three separate fixes in the 2026-08-20/21 wave each
 * landed the same check at ONE call site of N.
 *  - #699 added `createWorktree`'s `isPathClaimed` escape hatch and wired 1 of 8 callers;
 *    everywhere else the predicate defaulted to "not claimed" and the recursive delete was
 *    guarded by git alone — the authority #699 itself calls fail-open.
 *  - #673 added the co-residency sharer check to 1 of 5 worktree-delete paths, so merging
 *    one co-resident workspace still deleted a LIVE sharer's checkout.
 *  - `a2efe48691` corrected the closed-sharer filter in 1 of 2 copies, and both spelled the
 *    terminal status as the literal "closed" instead of using `workspace-liveness`.
 * Repeating a guard N times is what produced all three, so the guard now lives here and
 * every caller routes through it. `worktree-workingdir-delete-ratchet.test.ts` keeps the
 * raw, unguarded call sites shrink-only.
 *
 * It lives in `packages/shared` (not the server) for the same reason
 * `workspace-git-state.ts` does: mcp-server's `close_workspace` deletes the very same
 * directory and cannot reach the server's services or repositories.
 *
 * NODE-ONLY — it value-imports drizzle and the schema. Never re-export it from
 * `shared/src/index.ts`; import it by the deep path
 * `@agentic-kanban/shared/lib/worktree-claim`.
 *
 * FAIL-CLOSED, everywhere. A wrong "claimed" answer costs a refused cleanup, which a
 * human or the next cleanup pass can redo. A wrong "not claimed" answer recursively
 * deletes a worktree an agent is working in, which is unrecoverable. So every error path
 * here — a DB hiccup, an unreadable status, a thrown query — reports "claimed" / "do not
 * remove", never "safe to delete".
 */
type WorktreeClaimDb =
  | LibSQLDatabase<typeof schema>
  | Parameters<Parameters<LibSQLDatabase<typeof schema>["transaction"]>[0]>[0];

/** One workspace row that names a working directory. */
export interface WorkingDirClaim {
  id: string;
  status: string;
  workingDir: string;
}

/**
 * Every workspace row that names a working directory, live or terminal.
 *
 * Read UNFILTERED and filter in memory on purpose:
 *  - liveness is decided by `holdsLiveResources` (the shared vocabulary) rather than by a
 *    `status !== "closed"` predicate hand-spelled per call site — that literal is what made
 *    an `error`-status workspace and a hypothetical `merged` one disagree about their own
 *    liveness depending on which copy of the check you hit;
 *  - path comparison uses `samePath`, so a row stored with different separators or casing
 *    (Windows) still matches. An `eq(workingDir, ...)` query silently misses those, and a
 *    miss here is the unrecoverable direction.
 * The table is small (one row per workspace ever created), so this is not a hot path.
 */
async function selectWorkingDirClaims(database: WorktreeClaimDb): Promise<WorkingDirClaim[]> {
  const rows = await database
    .select({ id: workspaces.id, status: workspaces.status, workingDir: workspaces.workingDir })
    .from(workspaces)
    .where(isNotNull(workspaces.workingDir));
  return rows.flatMap((r) =>
    typeof r.workingDir === "string" && r.workingDir.length > 0
      ? [{ id: r.id, status: r.status, workingDir: r.workingDir }]
      : [],
  );
}

/** The subset of `createWorktree`'s options this module supplies. */
export interface WorktreeClaimOptions {
  isPathClaimed: (candidate: string) => boolean;
}

/**
 * Build the `isPathClaimed` predicate for `createWorktree`'s leftover-cleanup.
 *
 * Snapshotted once per call (the predicate `createWorktree` takes is synchronous). That is
 * the right granularity: the answer is consumed within the same provisioning step.
 *
 * On a failed read the returned predicate answers `true` for EVERY path. `createWorktree`
 * then declines to delete the existing directory and falls through to its numeric-suffix
 * alternative path — a slightly uglier leaf instead of a destroyed worktree. The previous
 * shape (`.catch(() => [])`) turned exactly this hiccup into a green light for the delete.
 */
export async function resolveWorktreeClaims(
  database: WorktreeClaimDb,
  opts: { label?: string } = {},
): Promise<WorktreeClaimOptions> {
  let claims: WorkingDirClaim[];
  try {
    claims = await selectWorkingDirClaims(database);
  } catch (err) {
    console.warn(
      `[worktree-claim] could not read live working dirs${opts.label ? ` (${opts.label})` : ""} — `
        + `treating every path as CLAIMED so leftover-cleanup refuses to delete: ${errorMessage(err)}`,
    );
    return { isPathClaimed: () => true };
  }
  const live = claims.filter((c) => holdsLiveResources(c.status));
  return {
    isPathClaimed: (candidate) => {
      if (!candidate) return true;
      try {
        return live.some((c) => samePath(c.workingDir, candidate));
      } catch {
        // A path that cannot even be normalised is not a path we are willing to rm -rf.
        return true;
      }
    },
  };
}

/**
 * The live workspaces (other than `excludeWorkspaceId`) that share `workingDir`.
 *
 * Co-residency is a SUPPORTED state (#394): a shared-worktree fork child reuses its
 * parent's `workingDir`, so a non-empty result means removing the directory would pull the
 * rug out from under a running agent.
 *
 * Throws on a DB failure — callers should route through `removeWorktreeUnlessShared`,
 * which turns that into a refusal.
 */
export async function findLiveWorktreeSharers(
  database: WorktreeClaimDb,
  workingDir: string,
  opts: { excludeWorkspaceId?: string } = {},
): Promise<WorkingDirClaim[]> {
  const claims = await selectWorkingDirClaims(database);
  return claims.filter(
    (c) =>
      c.id !== opts.excludeWorkspaceId
      && holdsLiveResources(c.status)
      && samePath(c.workingDir, workingDir),
  );
}

export type WorktreeRemovalOutcome =
  /** The removal ran and reported success. */
  | { removed: true }
  /** Another live workspace shares the directory — nothing was touched. */
  | { removed: false; reason: "shared"; sharers: WorkingDirClaim[]; message: string }
  /** The sharer check itself failed, so the removal was refused rather than guessed. */
  | { removed: false; reason: "claim-check-failed"; message: string; error: unknown }
  /** The guard passed; the removal itself threw. */
  | { removed: false; reason: "remove-failed"; message: string; error: unknown };

/**
 * THE guarded worktree removal. Every path that deletes a workspace's `workingDir` goes
 * through here — delete-workspace, stale-worktree cleanup, post-merge cleanup, the merge
 * prevalidation's already-merged resolution, the already-merged reconciler, and mcp
 * `close_workspace`.
 *
 * Never throws: callers report the outcome in their own idiom (a `{success:false}` result,
 * a recoverable merge warning, a persisted cleanup warning, a log line), which is the only
 * thing that differed between the five hand-written copies of this check.
 */
export async function removeWorktreeUnlessShared(args: {
  database: WorktreeClaimDb;
  workingDir: string;
  /** The workspace on whose behalf the removal runs — never counts as its own sharer. */
  workspaceId?: string;
  /** Short tag for the log line, e.g. `"merge:post-merge"`. */
  label: string;
  /** The actual removal. Injected so this module stays free of the git service. */
  removeWorktree: () => Promise<void>;
}): Promise<WorktreeRemovalOutcome> {
  let sharers: WorkingDirClaim[];
  try {
    sharers = await findLiveWorktreeSharers(args.database, args.workingDir, {
      excludeWorkspaceId: args.workspaceId,
    });
  } catch (err) {
    const message =
      `[${args.label}] refusing to remove worktree ${args.workingDir}: could not determine `
      + `whether another live workspace shares it (${errorMessage(err)})`;
    console.warn(`[worktree-claim] ${message}`);
    return { removed: false, reason: "claim-check-failed", message, error: err };
  }

  if (sharers.length > 0) {
    const message =
      `Worktree ${args.workingDir} is still referenced by ${sharers.length} other live `
      + `workspace(s) — skipping removal [${args.label}]`;
    console.log(`[worktree-claim] ${message}`);
    return { removed: false, reason: "shared", sharers, message };
  }

  try {
    await args.removeWorktree();
    return { removed: true };
  } catch (err) {
    return {
      removed: false,
      reason: "remove-failed",
      message: `[${args.label}] failed to remove worktree ${args.workingDir}: ${errorMessage(err)}`,
      error: err,
    };
  }
}
