import { resolve as resolvePath } from "node:path";
import type { GitService } from "./workspace-internals.js";
import { emitButlerSystemEvent } from "./butler-event-feed.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * Say so, loudly, when the workingDir just assigned to a new workspace is NOT a git-registered
 * worktree (#673 defect 2).
 *
 * `setupWorktree`/`createWorktree` returns the ACTUAL path it provisioned — including any `-2`/
 * `-3` suffix fallback when the preferred directory was occupied — and that return value is what
 * flows into the DB row (never a pre-guessed path), so this should normally never fire. It exists
 * as a backstop: issue #670's DB record pointed at a directory `git worktree list` did not know
 * about, and the setup script that then ran in the wrong directory failed opaquely (exit 1) with
 * nothing pointing at the real cause. Best-effort and non-blocking — a failed check here must
 * never fail workspace creation over itself.
 */
export async function warnIfWorktreePathNotRegistered(
  gitService: GitService,
  repoPath: string,
  worktreePath: string,
  workspaceId: string,
  projectId: string,
): Promise<void> {
  try {
    const registered = await gitService.listWorktrees(repoPath);
    // `git worktree list` always includes at least the main checkout, so an empty result
    // means the check can't be trusted (e.g. a stubbed/mocked GitService in a test) rather
    // than a real "nothing registered" — skip instead of false-flagging every such create.
    if (registered.length === 0) return;
    const target = resolvePath(worktreePath);
    const found = registered.some((w) => resolvePath(w.path) === target);
    if (found) return;
    console.error(
      `[workspaces] RECONCILE: workspace ${workspaceId} was assigned workingDir "${worktreePath}", but ` +
      `'git worktree list' for ${repoPath} does not include it — the DB record does not match any ` +
      `registered git worktree, so anything run "in" it (setup script, agent) targets a directory git ` +
      `itself does not know about (#673).`,
    );
    emitButlerSystemEvent({
      projectId,
      kind: "workspace_error",
      workspaceId,
      text: `Workspace ${workspaceId}'s workingDir "${worktreePath}" is not a registered git worktree — reconcile needed (#673).`,
    });
  } catch (err) {
    console.warn(`[workspaces] worktree-registration check failed for ${workspaceId}: ${errorMessage(err)}`);
  }
}
