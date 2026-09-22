/**
 * Startup wiring for {@link reapStaleBaseHealthProbeStamps} (#1223).
 *
 * Its own module because `startup-tasks.ts` sits at the god-module gate's 1000-line ceiling
 * (#889) — the same reason `run-non-fatal.ts` was split out. This file only logs; the decision
 * and the DB write live in `services/base-branch-health-reprobe.service.ts`, beside the stamp
 * they clear.
 */
import { reapStaleBaseHealthProbeStamps } from "../services/base-branch-health-reprobe.service.js";

/**
 * A base-health probe's "started" stamp is persisted so a restart mid-probe does not forget it,
 * but a freshly-booted process cannot possibly own a probe that was already running before it
 * started. A stamp still on disk at this point belongs to a process that was killed mid-run;
 * left alone it wedges every reprobe (and `pnpm promote`) for up to 65 minutes with no
 * operator-visible sign that nothing is actually running. Same reap shape as
 * `cleanupStaleSessions`.
 */
export async function reapStaleBaseHealthProbeStampsLogged(): Promise<void> {
  const cleared = await reapStaleBaseHealthProbeStamps();
  if (cleared.length > 0) {
    console.log(`[startup] cleared ${cleared.length} stale base-health probe stamp(s): ${cleared.join(", ")}`);
  }
}
