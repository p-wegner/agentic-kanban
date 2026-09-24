import type { SmokeCheck, StackProfile } from "@agentic-kanban/shared";
import { buildSmokeCheck } from "./stack-profile.service.js";
import { resolveDevServerPlan } from "./dev-server.service.js";

/**
 * Moved out of `pre-merge-gate.service.ts` verbatim when #1231 pushed that file to the
 * god-module line ceiling (1000, `max-file-size.test.ts`); the service re-exports it, so no
 * importer had to move. A cohesive unit on its own terms: the ONE answer to "does this project
 * have a merge gate at all" (#546), which the monitor, the merge queue and the breaker all ask.
 */
/**
 * Does a project have an automatic pre-merge gate, and what does it consist of (#546)?
 *
 * "Has a gate" was derived THREE ways and all three disagreed with the gate itself:
 *   - `projectHasMergeGate` (monitor-cycle): `verify_script` OR `profile.isWeb`,
 *   - the merge-queue orchestrator: a regex sweep over prefMap, also `verify_script` OR `isWeb`,
 *   - the real gate: `verify_script` OR `buildSmokeCheck(...) !== null`, which additionally
 *     needs a dev command AND a resolvable health URL.
 *
 * The consequence of the over-approximation is not cosmetic: for an `isWeb` project with no
 * dev command, both callers classified it as GATED and therefore suppressed
 * `auto_merge_in_review` — waiting for a gate verdict that `buildSmokeCheck` returns `null`
 * for, i.e. one that never runs.
 *
 * So the question is answered ONCE, by asking the same builders the gate asks. `plan` is the
 * pure dev-server plan, so the answer accounts for the `dev_command`/`health_url` overrides
 * that can create a smoke gate a profile alone would not have.
 */
export interface MergeGateConfig {
  /** The configured verify command, or null when the project has none. */
  verifyScript: string | null;
  /** The smoke check that would run, or null when this project has none. */
  smoke: SmokeCheck | null;
  /** True when at least one half of the gate applies. */
  hasGate: boolean;
}

export function resolveMergeGateConfig(input: {
  verifyScript: string | null | undefined;
  profile: StackProfile | null;
  devCommandOverride?: string | null;
  healthUrlOverride?: string | null;
}): MergeGateConfig {
  const verifyScript = input.verifyScript?.trim() ? input.verifyScript : null;
  const plan = resolveDevServerPlan({
    profile: input.profile,
    devCommandOverride: input.devCommandOverride,
    healthUrlOverride: input.healthUrlOverride,
    // No workingDir here: the worktree-port convention is a property of a specific
    // checkout, and this question is about the PROJECT.
    isSelfProject: false,
  });
  const smoke = buildSmokeCheck(input.profile, plan);
  return { verifyScript, smoke, hasGate: Boolean(verifyScript) || smoke !== null };
}
