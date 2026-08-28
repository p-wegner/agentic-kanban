/**
 * #919 — the per-ISSUE record of why the monitor last declined to start a ticket.
 *
 * A repository (not inlined in `startup/monitor-auto-start.ts`) for the same reason
 * `start-scoring.repository.ts` is one: `startup/` reaching for drizzle itself is the
 * `startup-bypasses-repositories` rule `pnpm lint:arch` warns on, and keeping the write
 * behind a function is what lets the auto-start suites inject a recorder instead of a DB.
 */
import { issues } from "@agentic-kanban/shared/schema";
import { eq, inArray } from "drizzle-orm";
import type { Database } from "../db/index.js";

/**
 * Stamp one issue's most recent auto-start skip reason. Never throws — a skip reason is a
 * DECORATION on a decision the monitor has already made, so a write failure must not abort
 * the cycle; the error is RETURNED so the caller can warn in its own voice. Same contract as
 * `persistStartScore` (#917), and for the same reason.
 */
export async function persistAutoStartSkipReason(
  issueId: string,
  fields: { reason: string; at: string },
  database: Database,
): Promise<Error | null> {
  try {
    await database.update(issues)
      .set({ lastAutoStartSkipReason: fields.reason, lastAutoStartSkipAt: fields.at })
      .where(eq(issues.id, issueId));
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Clear the skip record for issues the monitor DID start this cycle. Without this a ticket
 * that was held for `wip_cap` last cycle and is running now would still answer "why is this
 * not running" with a stale reason — and the field exists precisely to answer that question
 * truthfully. Never throws, same contract as above.
 */
export async function clearAutoStartSkipReason(
  issueIds: readonly string[],
  database: Database,
): Promise<Error | null> {
  if (issueIds.length === 0) return null;
  try {
    await database.update(issues)
      .set({ lastAutoStartSkipReason: null, lastAutoStartSkipAt: null })
      .where(inArray(issues.id, [...issueIds]));
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}
