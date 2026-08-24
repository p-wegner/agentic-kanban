import { isNotNull } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { workspaceProvisioning, workspaces } from "../schema/index.js";
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

/**
 * Every workspace row — WHATEVER its status — that names `workingDir` (#859).
 *
 * The orphaned-worktree reconciler's own rule (`classifyWorktree`) has always been "a row
 * that still names the path owns it, whatever its status", but the shared guard only asked
 * the LIVE-row question — so the guard could approve a removal the reconciler's project-
 * scoped pre-filter would have refused, whenever the row was outside that project scope or
 * landed between the two reads. Path comparison is `samePath` (Windows case/separator safe).
 */
export async function findWorkspaceRowsNamingPath(
  database: WorktreeClaimDb,
  workingDir: string,
  opts: { excludeWorkspaceId?: string } = {},
): Promise<WorkingDirClaim[]> {
  const claims = await selectWorkingDirClaims(database);
  return claims.filter((c) => c.id !== opts.excludeWorkspaceId && samePath(c.workingDir, workingDir));
}

/** One in-flight workspace-create marker (#630) that claims a path or branch. */
export interface ProvisioningClaim {
  id: string;
  issueId: string;
  phase: string;
  branch: string | null;
  worktreePath: string | null;
  serverPid: number;
}

/** Is the process behind a provisioning marker still alive? Fail toward "alive" is NOT
 * wanted here: a dead pid's marker must stay removable, or the startup orphan sweep could
 * never clean up after a crashed create (`reconcileAbandonedProvisioning` depends on it). */
function provisioningPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * In-flight workspace creates (#630 markers, LIVE process only) that claim `workingDir` —
 * by the marker's recorded worktree path, or by its intended branch when the caller knows
 * the worktree's branch (#859).
 *
 * This is the claim NO workspace-row read can see: for the whole provisioning window
 * (measured 48s to 8+ minutes) the worktree exists on disk and in `git worktree list`
 * while the workspace row does not exist yet — the exact gap through which the orphan
 * reconciler deleted a worktree the create was still standing up. A marker whose owning
 * pid is dead is deliberately NOT a claim: the startup sweep must stay able to remove a
 * crashed create's debris before `reconcileAbandonedProvisioning` reports it.
 */
export async function findInFlightProvisioningClaims(
  database: WorktreeClaimDb,
  workingDir: string,
  opts: { branch?: string } = {},
): Promise<ProvisioningClaim[]> {
  const rows = await database
    .select({
      id: workspaceProvisioning.id,
      issueId: workspaceProvisioning.issueId,
      phase: workspaceProvisioning.phase,
      branch: workspaceProvisioning.branch,
      worktreePath: workspaceProvisioning.worktreePath,
      serverPid: workspaceProvisioning.serverPid,
    })
    .from(workspaceProvisioning)
    .where(isNotNull(workspaceProvisioning.serverPid));
  const branch = opts.branch?.trim();
  return rows.filter((r) => {
    if (!provisioningPidAlive(r.serverPid)) return false;
    const pathMatch =
      typeof r.worktreePath === "string" && r.worktreePath.length > 0 && samePath(r.worktreePath, workingDir);
    const branchMatch = !!branch && typeof r.branch === "string" && r.branch === branch;
    return pathMatch || branchMatch;
  });
}

/** One workspace row that holds a branch. */
export interface BranchClaim {
  id: string;
  status: string;
  branch: string;
}

/**
 * The live workspaces (other than `excludeWorkspaceId`) whose BRANCH is `branch`.
 *
 * Absorbed from `orphaned-worktree-reconciler.ts` in #735. That reconciler's own claim
 * analysis was STRONGER than this module's on exactly one point, and it is the unrecoverable
 * direction: finishing a merge NULLS `workspaces.working_dir`
 * (`finalizeMergeCleanup` → `clearWorkspaceWorkingDir`), so a live workspace can hold a
 * worktree that no row names by path. `findLiveWorktreeSharers` sees no claim there and
 * would wave the delete through; a branch-keyed lookup still recognises it.
 *
 * Deliberately UNSCOPED by project, like `selectWorkingDirClaims`: a branch name that
 * collides across projects makes this refuse, which is the cheap direction.
 *
 * An empty/whitespace branch matches nothing — a detached-HEAD worktree must not be
 * "claimed" by every row whose branch column is empty (the reconciler's own
 * `does not let an empty branch string match an empty claim branch` case).
 *
 * Throws on a DB failure — callers route through `removeWorktreeUnlessShared`, which turns
 * that into a refusal.
 */
export async function findLiveBranchHolders(
  database: WorktreeClaimDb,
  branch: string,
  opts: { excludeWorkspaceId?: string } = {},
): Promise<BranchClaim[]> {
  if (!branch.trim()) return [];
  const rows = await database
    .select({ id: workspaces.id, status: workspaces.status, branch: workspaces.branch })
    .from(workspaces)
    .where(isNotNull(workspaces.branch));
  return rows.flatMap((r) =>
    typeof r.branch === "string"
    && r.branch === branch
    && r.id !== opts.excludeWorkspaceId
    && holdsLiveResources(r.status)
      ? [{ id: r.id, status: r.status, branch: r.branch }]
      : [],
  );
}

export type WorktreeRemovalOutcome =
  /** The removal ran and reported success. */
  | { removed: true }
  /** Another live workspace shares the directory — nothing was touched. */
  | { removed: false; reason: "shared"; sharers: WorkingDirClaim[]; message: string }
  /**
   * A live workspace holds the worktree's BRANCH even though no row names its path
   * (a merge nulls `working_dir`) — nothing was touched. Only reachable when the caller
   * supplies `branch`.
   */
  | { removed: false; reason: "branch-claimed"; holders: BranchClaim[]; message: string }
  /**
   * An in-flight workspace create (#630 marker, live process) claims the path or branch —
   * the worktree is being provisioned RIGHT NOW and has no workspace row yet (#859).
   */
  | { removed: false; reason: "provisioning"; provisioning: ProvisioningClaim[]; message: string }
  /**
   * A workspace row in SOME state (possibly terminal) still names the path, and the caller
   * asked for the strict any-row rule (`treatAnyRowAsClaim`, #859). Nothing was touched.
   */
  | { removed: false; reason: "named-by-row"; namers: WorkingDirClaim[]; message: string }
  /** The sharer check itself failed, so the removal was refused rather than guessed. */
  | { removed: false; reason: "claim-check-failed"; message: string; error: unknown }
  /** The guard passed; the removal itself threw. */
  | { removed: false; reason: "remove-failed"; message: string; error: unknown };

/**
 * THE guarded worktree removal. Every path that deletes a workspace's `workingDir` goes
 * through here — delete-workspace, stale-worktree cleanup, post-merge cleanup, the merge
 * prevalidation's already-merged resolution, the already-merged reconciler, mcp
 * `close_workspace`, and (since #735) the project worktree-panel prune, the startup
 * stale-worktree sweep and the orphaned-worktree reconciler.
 *
 * The claim question is answered in up to two ways, both fail-closed: by PATH always
 * (`findLiveWorktreeSharers`), and by BRANCH when the caller supplies one
 * (`findLiveBranchHolders`) — the second is what sees a live workspace whose `working_dir`
 * a completed merge already nulled.
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
  /**
   * The branch this worktree is checked out on, when the caller knows it (#735).
   *
   * Optional and additive: supplying it adds the branch-keyed claim check
   * (`findLiveBranchHolders`) on top of the path-keyed one, which is the only way to see a
   * live workspace whose `working_dir` a completed merge already nulled. Callers that
   * delete a directory their OWN row still names (delete-workspace, stale-worktree
   * cleanup, post-merge) do not pass it and are unaffected.
   */
  branch?: string;
  /**
   * #859: treat ANY workspace row naming the path — whatever its status, terminal
   * included — as a claim. This is the orphaned-worktree reconciler's own rule
   * (`classifyWorktree` leaves such a directory to `pruneStaleWorktrees`), enforced at
   * the removal itself so a row the caller's own claim set missed (out of project scope,
   * or committed between the two reads) still stops the delete. Callers that remove a
   * directory their OWN (closed) row still names must NOT set this without passing
   * `workspaceId`, or they would refuse themselves.
   */
  treatAnyRowAsClaim?: boolean;
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

  if (args.treatAnyRowAsClaim) {
    let namers: WorkingDirClaim[];
    try {
      namers = await findWorkspaceRowsNamingPath(args.database, args.workingDir, {
        excludeWorkspaceId: args.workspaceId,
      });
    } catch (err) {
      const message =
        `[${args.label}] refusing to remove worktree ${args.workingDir}: could not determine `
        + `whether a workspace row still names it (${errorMessage(err)})`;
      console.warn(`[worktree-claim] ${message}`);
      return { removed: false, reason: "claim-check-failed", message, error: err };
    }
    if (namers.length > 0) {
      const message =
        `Worktree ${args.workingDir} is still NAMED by ${namers.length} workspace row(s) `
        + `(${namers.map((n) => `${n.id}:${n.status}`).join(", ")}) — it is claimed, skipping removal [${args.label}] (#859)`;
      console.log(`[worktree-claim] ${message}`);
      return { removed: false, reason: "named-by-row", namers, message };
    }
  }

  if (args.branch) {
    let holders: BranchClaim[];
    try {
      holders = await findLiveBranchHolders(args.database, args.branch, {
        excludeWorkspaceId: args.workspaceId,
      });
    } catch (err) {
      const message =
        `[${args.label}] refusing to remove worktree ${args.workingDir}: could not determine `
        + `whether a live workspace holds branch ${args.branch} (${errorMessage(err)})`;
      console.warn(`[worktree-claim] ${message}`);
      return { removed: false, reason: "claim-check-failed", message, error: err };
    }
    if (holders.length > 0) {
      const message =
        `Worktree ${args.workingDir} sits on branch ${args.branch}, which ${holders.length} live `
        + `workspace(s) still hold — skipping removal [${args.label}]`;
      console.log(`[worktree-claim] ${message}`);
      return { removed: false, reason: "branch-claimed", holders, message };
    }
  }

  // #859: an in-flight create (a live #630 marker) claims the directory for the whole
  // provisioning window in which NO workspace row exists yet — measured 48s to 8+ minutes
  // between `git worktree add` and the row's commit. Checked for every caller: deleting a
  // directory a concurrent create is standing up is wrong for all of them.
  let provisioning: ProvisioningClaim[];
  try {
    provisioning = await findInFlightProvisioningClaims(args.database, args.workingDir, {
      branch: args.branch,
    });
  } catch (err) {
    const message =
      `[${args.label}] refusing to remove worktree ${args.workingDir}: could not determine `
      + `whether an in-flight workspace create claims it (${errorMessage(err)})`;
    console.warn(`[worktree-claim] ${message}`);
    return { removed: false, reason: "claim-check-failed", message, error: err };
  }
  if (provisioning.length > 0) {
    const message =
      `Worktree ${args.workingDir} is claimed by ${provisioning.length} in-flight workspace `
      + `create(s) (${provisioning.map((p) => `${p.id} phase=${p.phase}`).join(", ")}) — provisioning is `
      + `still running, skipping removal [${args.label}] (#859)`;
    console.log(`[worktree-claim] ${message}`);
    return { removed: false, reason: "provisioning", provisioning, message };
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
