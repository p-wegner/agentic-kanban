import { DEFAULT_SETUP_SCRIPT_TIMEOUT_MS, runSetupScript } from "@agentic-kanban/shared/lib/setup-script";
import type { Database } from "../db/index.js";
import { getProjectSetupScript } from "../repositories/stack-profile.repository.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * Rebuild a worktree's generated build artifacts after its history moved under it (#275).
 *
 * A worktree's build outputs are gitignored and produced once, by the setup script, at
 * creation time. `update-base` then rewrites the worktree's SOURCE without rebuilding
 * anything — so a branch that was far behind comes back with fresh `src` and months-old
 * generated output. On this board that is `packages/shared/dist`: after a clean rebase of a
 * ~500-commit-stale branch (#218), the very next verify gate failed with
 * `Property 'mergeGateBranchSha' does not exist` / `isLeading does not exist on repos` —
 * type errors from the STALE dist, not from the branch. A manual
 * `pnpm --filter @agentic-kanban/shared build` fixed it and the merge went through.
 *
 * Without this, every stale branch that update-base rescues then reliably fails its gate
 * whenever the shared schema/types have moved — which, after any migration-bearing day, is
 * always. And the failure costs a full verify run (20-40 min) to produce.
 *
 * The repair is the project's OWN setup script rather than anything board-specific: that is
 * already the command that produced the artifacts (`pnpm install -r`, whose prepare script
 * builds dist; `cargo fetch`; `uv sync`; …), so this stays correct for any stack.
 *
 * Deliberately cheap and deliberately quiet:
 *  - skipped entirely when HEAD did not actually move (a no-op rebase rebuilds nothing);
 *  - skipped when the project has no setup script (nothing to re-run);
 *  - never throws — a failed refresh must not fail an otherwise successful update-base. The
 *    verify gate is still there to catch whatever the refresh could not fix, and its own
 *    missing-deps auto-retry (#169) remains the backstop.
 */
export async function refreshWorkspaceBuildArtifacts(args: {
  workingDir: string;
  projectId: string | null;
  database: Database;
  /** Worktree HEAD before the rebase/merge, if it could be resolved. */
  headShaBefore: string | null;
  /** Worktree HEAD after. Equal to `headShaBefore` means nothing changed. */
  headShaAfter: string | null;
  runScript?: typeof runSetupScript;
}): Promise<"refreshed" | "skipped-unchanged" | "skipped-no-script" | "failed"> {
  const { workingDir, projectId, database, headShaBefore, headShaAfter } = args;
  const runScript = args.runScript ?? runSetupScript;

  // Both resolved AND equal means the history genuinely did not move. An unresolvable tip
  // is not proof of that, so it falls through and refreshes — the cheap, safe direction.
  if (headShaBefore && headShaAfter && headShaBefore === headShaAfter) return "skipped-unchanged";
  if (!projectId) return "skipped-no-script";

  const setupScript = await getProjectSetupScript(projectId, database).catch(() => null);
  if (!setupScript || !setupScript.trim()) return "skipped-no-script";

  console.log(`[update-base] rebuilding generated artifacts in ${workingDir} — history moved and the worktree's build outputs predate it (#275)`);
  try {
    const result = await runScript(workingDir, setupScript, { timeoutMs: DEFAULT_SETUP_SCRIPT_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      console.warn(
        `[update-base] artifact rebuild exited ${result.exitCode} in ${workingDir} (non-fatal — the verify gate still guards the merge)`,
      );
      return "failed";
    }
    return "refreshed";
  } catch (err) {
    console.warn(
      `[update-base] artifact rebuild failed in ${workingDir} (non-fatal):`,
      errorMessage(err),
    );
    return "failed";
  }
}
