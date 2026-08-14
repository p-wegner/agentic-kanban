import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { findLiveWorkspacesOnBranch } from "../repositories/workspace-reads.repository.js";

/**
 * Say so, loudly, when a create is about to land on a branch a LIVE workspace already holds (#394).
 *
 * `createWorktree` adopts an existing worktree for the same branch (git allows exactly one worktree
 * per branch), so two workspaces created for the same branch end up with the SAME `working_dir`.
 * MEASURED on eventhub: issue #92 had two workspaces 47s apart and #93 two 110s apart, each pair
 * sharing one worktree path, all four born `blocked`. The worktrees themselves existed and were
 * registered, so the failure was AFTER worktree creation — a create-retry colliding on an existing
 * worktree.
 *
 * #394 asked for a REFUSAL. It cannot be one: co-residency on a shared worktree is a SUPPORTED
 * state here — the service-stack adoption path exists precisely so a second workspace on an
 * occupied worktree adopts the senior co-resident's stack instead of racing it for
 * `.kanban/services.env`. From the rows alone a deliberate co-resident and an accidental retry
 * collision are identical, so refusing would break a working flow to catch a bug it cannot
 * distinguish. What was genuinely missing is any RECORD that the sharing happened at all — the
 * eventhub pairs looked like ordinary independent workspaces.
 *
 * Called BEFORE `setupWorktree` for a second reason: doing it later would sit inside the create
 * path's catch, whose `rollbackOrphanedWorktree` deletes the worktree — and here that worktree
 * belongs to the live workspace.
 */
export async function warnIfBranchHeldByLiveWorkspace(
  branch: string,
  database: Database = db,
): Promise<void> {
  if (!branch) return;
  const holders = await findLiveWorkspacesOnBranch(branch, database).catch(() => []);
  if (holders.length === 0) return;
  const held = holders.map((h) => `${h.id} (${h.status})`).join(", ");
  console.warn(
    `[workspaces] branch "${branch}" is already held by ${holders.length} live workspace(s): ${held}. `
    + `Git allows one worktree per branch, so this workspace will SHARE that directory rather than own it — `
    + `intended for a co-resident stack adoption, and a create-retry collision otherwise (#394).`,
  );
}
