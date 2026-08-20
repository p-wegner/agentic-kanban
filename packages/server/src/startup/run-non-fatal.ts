import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * Run one non-fatal startup entry, swallowing its failure (#564).
 *
 * The startup audit tail is idempotent convergence work, every entry of which has a periodic
 * counterpart in BACKGROUND_SERVICES — so one entry failing must never stop the ones after it,
 * and must never fail startup. `name` is reported in the warning so a failed entry is
 * identifiable in a long startup log.
 *
 * Its own module because `startup-tasks.ts` sits at the god-module gate's cohesion ceiling
 * (#889); one more top-level function there fails the gate.
 */
export async function runNonFatal(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.warn(`[startup] ${name} failed (non-fatal):`, errorMessage(err));
  }
}
