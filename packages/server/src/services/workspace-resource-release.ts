/**
 * The end-of-life release of a workspace's per-workspace RUNTIME resources (#549):
 * its Docker compose stack, then its devcontainer and dependency volumes.
 *
 * Eight terminal paths hand-copied "parse the stored compose name → if present →
 * teardownWorkspaceServices → reap the container", and the GUARD drifted per copy
 * (`workingDir && !isDirect && repoPath` / `workingDir && !isDirect` / just
 * `workingDir` / none). The comments at those sites read as a history of the same
 * bug being re-fixed: a stack leaked from delete (#F1), then from
 * reconcile-already-merged (#F4), and five of the eight paths never reaped the
 * container at all until #576. Each new terminal path leaked until someone
 * remembered to paste the block again.
 *
 * One canonical guard, one order, one place — so the NEXT terminal path releases
 * both by construction.
 *
 * NOT in scope: worktree removal and branch cleanup (`teardownWorktree`,
 * `cleanupMergedWorktreeAndBranch`) have their own ordering constraints and stay
 * where they are. This runs BEFORE them: the container bind-mounts the worktree and
 * holds its dependency volumes, so the directory cannot go first.
 */
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { reapWorkspaceContainer } from "./devcontainer-workspace.service.js";
import { parseStoredComposeProjectName, workspaceServicesService } from "./workspace-services.service.js";

/** The workspace fields the release needs — a row, or anything shaped like one. */
export interface ReleasableWorkspace {
  id: string;
  workingDir: string | null;
  /** A direct workspace runs in the project checkout: it owns no worktree resources. */
  isDirect?: boolean | null;
  /** Persisted service state; the STORED compose project name is read from it, never recomputed (#F1). */
  serviceState?: string | null;
}

export interface ReleaseWorkspaceResourcesOptions {
  /**
   * Wrap each step (the close path bounds them with a timeout). Defaults to running
   * the step as-is. A step that throws is logged and never propagates — a docker
   * hiccup must not fail a merge, a delete, or a startup sweep; the startup reaper
   * is the backstop.
   */
  step?: <T>(name: string, run: () => Promise<T>) => Promise<T>;
  /** Names the terminal path in the best-effort warnings, e.g. "close" or "merge". */
  phase?: string;
}

export async function releaseWorkspaceResources(
  workspace: ReleasableWorkspace,
  options: ReleaseWorkspaceResourcesOptions = {},
): Promise<void> {
  const { workingDir, isDirect, id } = workspace;
  // The ONE guard: no worktree, or a direct workspace, means there is nothing
  // per-workspace to release. (`repoPath` appeared in some copies; it gates worktree
  // REMOVAL, not resource release, and a stack still leaks without it.)
  if (!workingDir || isDirect) return;

  const step = options.step ?? (<T>(_name: string, run: () => Promise<T>) => run());
  const where = options.phase ? `${options.phase}: ` : "";

  const composeProjectName = parseStoredComposeProjectName(workspace.serviceState);
  if (composeProjectName) {
    await step("teardown-service-stack", () =>
      workspaceServicesService.teardownWorkspaceServices({
        composeProjectName,
        composeWorktreePath: workingDir,
        releasedByWorkspaceId: id,
      }),
    ).catch((err) => {
      console.warn(`[workspaces] ${where}service-stack teardown failed/timed out for ${id} (best-effort): ${errorMessage(err)}`);
    });
  }

  // Then the devcontainer (#138/#576): it bind-mounts `workingDir` and holds the
  // dependency volumes, so it must go before the directory does. No-op when the
  // workspace was never containerized.
  await step("reap-devcontainer", () => reapWorkspaceContainer({ worktreePath: workingDir, workspaceId: id }))
    .catch((err) => {
      console.warn(`[workspaces] ${where}devcontainer reap failed/timed out for ${id} (best-effort): ${errorMessage(err)}`);
    });
}
