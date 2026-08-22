/**
 * Clean-clone buildability of a branch, at review exit (#700 extraction).
 *
 * Two steps of ONE concern — "would a fresh clone of this branch install and build?" — which the
 * worktree cannot answer on its own, because it runs against a warm pnpm store and (historically)
 * dependency symlinks into the main checkout:
 *
 *  1. `applyBuildApprovalRepair` (#812) — REPAIR. Commit the manifest fix (approved native build
 *     scripts, a pinned package manager) that makes a clean clone installable at all.
 *  2. `runColdCloneGate` (#792) — VERIFY. Opt-in per project: actually clone the branch cold and
 *     build it, and withhold `readyForMerge` if that fails.
 *
 * They are ordered and paired on purpose: the repair must land on the branch BEFORE the verify
 * build so the fix is what merges, and the cold clone must run AFTER it so it picks the fix up.
 * Keeping them in one module keeps that ordering visible instead of implied by two adjacent call
 * sites in a 1000-line handler.
 *
 * Neither reaches for the `db` singleton nor writes raw drizzle: the connection is injected and
 * the one read it needs goes through the canonical `getProjectRepoPath` accessor (#957).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { getProjectRepoPath } from "../../repositories/project.repository.js";
import { emitButlerSystemEvent } from "../../services/butler-event-feed.js";
import { ensureBuildableFromClean } from "../../services/project-scaffold.js";
import { runUnderBuildSemaphore } from "../../services/jvm-build-semaphore.js";
import { isColdCloneCheckEnabled, runColdCloneBuildCheckForProject } from "../../services/cold-clone-build-check.service.js";
import type { ColdCloneCheckResult } from "../../services/cold-clone-build-check.service.js";
import type { Database } from "../../db/index.js";
import type { createBoardEvents } from "../../services/board-events.js";
import type { GitService } from "../../services/workspace-internals.js";
import type { ExitContext } from "./exit-context.js";

/**
 * The complete set of files the build-approval repair can ever touch (any stack). We stage and
 * revert only the ones that actually exist, so a non-pnpm project (no pnpm-workspace.yaml) or a
 * non-Node project (no package.json) is a clean no-op rather than a failure on a missing pathspec.
 */
const BUILD_APPROVAL_REPAIR_PATHS = ["package.json", "pnpm-workspace.yaml"];

export interface CleanCloneCheckDeps {
  database: Database;
  gitService: GitService;
  boardEvents: ReturnType<typeof createBoardEvents>;
}

export interface CleanCloneChecks {
  applyBuildApprovalRepair: (ctx: ExitContext) => Promise<void>;
  runColdCloneGate: (ctx: ExitContext) => Promise<boolean>;
}

export function createCleanCloneChecks({ database: db, gitService, boardEvents }: CleanCloneCheckDeps): CleanCloneChecks {
  /**
   * #812 build-approval repair. NOT a gate — a repair run BEFORE the shared verify/smoke gate.
   *
   * A builder that created the build manifest may not have approved native build scripts or pinned
   * a package-manager version that honors the approval, so a FRESH clone of master can fail to
   * install even though the warm-store worktree builds. `ensureBuildableFromClean` dispatches per
   * stack (pnpm to onlyBuiltDependencies, bun to trustedDependencies, npm/yarn pin only, and
   * cargo/go/python/java a clean no-op). We commit that fix onto the branch BEFORE the verify
   * build (which runs inside the shared `runPreMergeGate`) so the fix merges to master and clones
   * build clean. Only meaningful when a verify_script is configured and a worktree exists; a
   * repair failure never blocks the merge — it reverts and returns.
   *
   * (arch-review 1.2: the verify/smoke DECISION itself is not duplicated here — it lives in the
   * single owner `runPreMergeGate`, which the review-exit path calls, exactly like the
   * manual/monitor merge paths. This function is ONLY the repair that must precede that build.)
   */
  async function applyBuildApprovalRepair(ctx: ExitContext): Promise<void> {
    const { workspace, projectId, prefMap } = ctx;
    const workspaceId = workspace.id;
    const verifyScript = prefMap.get(`verify_script_${projectId}`);
    if (!verifyScript || !verifyScript.trim() || !workspace.workingDir) return;
    const workingDir = workspace.workingDir;
    try {
      const approvalChanged = ensureBuildableFromClean(workingDir);
      if (approvalChanged) {
        const candidatePaths = BUILD_APPROVAL_REPAIR_PATHS.filter((p) => existsSync(join(workingDir, p)));
        const committed = candidatePaths.length
          ? await gitService.commitPaths(
              workingDir,
              candidatePaths,
              "chore: make project buildable from a clean clone (verify gate #812)",
            )
          : false;
        if (committed) console.log(`[workflow] committed build-approval repair for workspace ${workspaceId} (#812)`);
      }
    } catch (e) {
      // Never let a repair failure leave the worktree dirty — an uncommitted manifest change would
      // block the auto-merge (silent merge loss). Revert and continue.
      console.warn(`[workflow] build-approval repair failed for workspace ${workspaceId}: ${errorMessage(e)}`);
      const revertPaths = BUILD_APPROVAL_REPAIR_PATHS.filter((p) => existsSync(join(workingDir, p)));
      if (revertPaths.length) {
        try {
          await gitExec(["checkout", "--", ...revertPaths], { cwd: workingDir });
        } catch { /* best-effort cleanup */ }
      }
    }
  }

  /**
   * #792 cold-clone build gate. Opt-in per project; verifies a FRESH clone of the branch builds.
   * Returns false to WITHHOLD readyForMerge.
   *
   * The in-worktree verify gate runs against a warm pnpm store, so it can pass even when a fresh
   * clone of the branch would not build (the #783 class: unapproved native build scripts, an
   * unpinned package manager, an uncommitted generated file). Opt in via
   * `cold_clone_check_<projectId>` — a pure no-op when unset. Runs AFTER the verify block so it
   * picks up any approval repair just committed onto the branch, and a non-zero clean-build exit
   * withholds readyForMerge so the #783 class is caught at review, not after merge.
   */
  async function runColdCloneGate(ctx: ExitContext): Promise<boolean> {
    const { workspace, projectId } = ctx;
    const workspaceId = workspace.id;
    if (!(await isColdCloneCheckEnabled(projectId, db))) return true;
    const repoPath = await getProjectRepoPath(projectId, db);
    if (!repoPath || !workspace.branch) return true;

    const coldResult: ColdCloneCheckResult = await runUnderBuildSemaphore(() =>
      runColdCloneBuildCheckForProject(
        projectId,
        { repoPath, branch: workspace.branch },
        db,
      ).catch((e) => ({ ok: false, reason: "build-failed" as const, output: errorMessage(e) })),
    );
    if (!coldResult.ok) {
      const detail = coldResult.failedCommand ? `${coldResult.failedCommand} (exit ${coldResult.exitCode})` : coldResult.reason;
      console.log(`[workflow] cold-clone build check failed (${coldResult.reason}) for workspace ${workspaceId} — withholding readyForMerge (#792)`);
      boardEvents.broadcast(projectId, "workflow_error");
      emitButlerSystemEvent({ projectId, kind: "session_failed", workspaceId, text: `Cold-clone build check failed for workspace ${workspaceId}: ${detail}. Builds in the worktree but not on a fresh clone (the #783 class); not approved for merge. ${(coldResult.output || "").slice(0, 300)}` });
      return false;
    }
    console.log(`[workflow] cold-clone build check passed for workspace ${workspaceId} (#792)`);
    return true;
  }

  return { applyBuildApprovalRepair, runColdCloneGate };
}
