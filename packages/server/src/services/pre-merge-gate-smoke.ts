// The #791 boot/render smoke stage of the pre-merge gate, split out of pre-merge-gate.service.ts (#1605).
import { runSmokeCheck } from "@agentic-kanban/shared/lib/smoke-check";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { Database } from "../db/index.js";
import type { PreMergeGateResult, PreMergeGateWorkspace } from "./pre-merge-gate.types.js";
import { buildSmokeCheck, getStackProfile } from "./stack-profile.service.js";
import { resolveProjectDevServerPlan } from "./dev-server.service.js";
import { runUnderBuildSemaphore } from "./jvm-build-semaphore.js";
import { runUnderVerifyChainSemaphore } from "./verify-chain-semaphore.js";
import { noteMergeGatePhase } from "./merge-job.service.js";
import { createSmokeIsolation } from "../lib/smoke-isolation.js";

export interface SmokeStageOutcome {
  /** Smoke actually ran (not skipped for a docs-only diff or an absent check). */
  applies: boolean;
  /** Set when the stage errored out rather than reaching a verdict (#644). */
  inconclusive: string | null;
  /** A red verdict to return from the gate as-is. */
  failure?: PreMergeGateResult;
}

export async function runSmokeStage(args: {
  workspace: PreMergeGateWorkspace;
  projectId: string;
  database: Database;
  isSelfRepo: boolean;
  docsOnly: boolean;
}): Promise<SmokeStageOutcome> {
  const { workspace, projectId, database, isSelfRepo, docsOnly } = args;
  // ---- #791 boot/render smoke gate ---------------------------------------------------------
  // Profile load needs no worktree, so detect "gate applies" before checking workingDir.
  let smokeApplies = false;
  // #644: set when the smoke block errored out rather than reaching a verdict. The whole block
  // used to sit inside ONE catch that logged a warning and fell through to `passed: true`, and
  // the final message then reported the verify tier as if nothing had been skipped — so an
  // infrastructure failure in the boot check was indistinguishable from a clean pass. Still
  // non-fatal (a harness error must not withhold an otherwise-green merge), but no longer
  // silent: the gate says "smoke inconclusive" and names why.
  let smokeInconclusive: string | null = null;
  try {
    const profile = await getStackProfile(projectId, database);
    // #657: resolve the same dev-server plan the Diagnostics tab and the dev-server skill
    // use, so an operator's `health_url_<projectId>` / `dev_command_<projectId>` reaches the
    // merge gate too. It also supplies the port for a project whose dev ports are computed at
    // RUNTIME — this repo's own 3001+N/5173+N worktree math, which no static package.json read
    // can know, and which left `devPort: null` and the smoke gate permanently inert.
    const plan = await resolveProjectDevServerPlan(projectId, database, {
      profile,
      workingDir: workspace.workingDir,
      isSelfProject: isSelfRepo,
    }).catch((err: unknown) => {
      // Non-fatal on purpose: a failed plan read degrades to the profile-only smoke check
      // that existed before, rather than turning the whole gate inconclusive.
      console.warn(`[pre-merge-gate] dev-server plan unavailable for project ${projectId}:`, errorMessage(err));
      return null;
    });
    const smokeCheck = buildSmokeCheck(profile, plan);
    if (smokeCheck) {
      if (!workspace.workingDir) {
        // Fail-closed: smoke (UI) gate applies but can't run without a worktree (#826).
        return { applies: smokeApplies, inconclusive: smokeInconclusive, failure: { passed: false, skipped: false, stage: "smoke", message: "smoke/UI gate applies (web project) but workspace has no worktree — cannot verify" } };
      }
      // #198: a docs-only diff can never change boot/render behavior, so skip the (expensive,
      // cold-JVM-hostile) smoke boot entirely rather than pay for a check whose outcome can't
      // have changed. `docsOnly` is computed once at the top of the gate from the same diff
      // read — it is false whenever we could not SEE the diff, so an unknown diff still runs
      // the smoke check exactly as before.
      if (docsOnly) {
        console.log(`[pre-merge-gate] skipping smoke check for workspace ${workspace.id} — diff touches only docs (#198)`);
      } else {
        smokeApplies = true;
        noteMergeGatePhase(workspace.id, "smoke", "boot + render check");
        // #1095: the smoke boot starts a SECOND full board process next to the live one, and
        // without isolation it inherits the live board's KANBAN_DB_URL/listener pins (or, absent
        // those, still resolves the operated `~/.agentic-kanban/kanban.db` home-fallback) — so it
        // reattached a live agent session and ran its own monitor cycle (auto-merge selection,
        // auto-start) against the OPERATED database. Same isolation the verify half already gets
        // (#231, see createSmokeIsolation below): a throwaway AGENTIC_KANBAN_DIR plus the
        // neutralized DB-location/listener env, and — since even a throwaway DB should not run a
        // monitor loop — background services skipped outright for this boot.
        const smokeIsolation = createSmokeIsolation();
        try {
          // #949: the chain semaphore, not just the build semaphore. This boots a real dev server
          // and polls a health URL; under the build semaphore alone (derived width up to 8) it ran
          // freely alongside ANOTHER gate's verify chain, which is the contention #903 set out to
          // remove and only removed for the verify half.
          const smoke = await runUnderVerifyChainSemaphore(
            () => runUnderBuildSemaphore(() => runSmokeCheck(workspace.workingDir!, smokeCheck, { env: smokeIsolation.env })),
            `smoke check for workspace ${workspace.id}`,
          );
          if (!smoke.passed) {
            return { applies: smokeApplies, inconclusive: smokeInconclusive, failure: { passed: false, skipped: false, stage: "smoke", message: `smoke check failed: ${smoke.message}` } };
          }
        } finally {
          smokeIsolation.disposeAndWarn(`workspace ${workspace.id}`);
        }
      }
    }
  } catch (smokeErr) {
    // NON-FATAL: a harness error (not a failed boot) must not block an otherwise-passing merge.
    // But it must not be invisible either (#644) — record it so the gate message says so.
    smokeInconclusive = errorMessage(smokeErr);
    console.warn(`[pre-merge-gate] smoke check errored (non-fatal) for workspace ${workspace.id}:`, smokeInconclusive);
  }
  return { applies: smokeApplies, inconclusive: smokeInconclusive };
}
