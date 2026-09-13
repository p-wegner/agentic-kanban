// The deterministic core behind the manifest's `loops[].plan` command (#1080). Pure
// function over the plugin's own persisted state — no Jira/board I/O here, so it can
// be unit-tested directly and never throws (loop rule 3: the planner runs on every
// advance, including the very first, and must report preconditions as a note rather
// than blow up).
//
// Turns c3 (inbound-pull conflicts, sync-engine.mjs's `conflicted` details) and c4
// (outbound-push failures, push-plan.mjs's `failed` entries) into loop units instead
// of leaving them as print-and-forget CLI diagnostics. The board's own loop engine
// (packages/server/src/services/plugin/loop-unit-tickets.ts) turns each unit into a
// ticket against whichever project the loop is advancing for — this plugin never
// picks a projectId itself.
//
// "Loop state carried by the tickets, not a private run log" (the ticket's own
// framing): this module holds no round-tracking of its OWN — the round comes from
// conflict-register.mjs, which is a snapshot of what's currently outstanding, not an
// append-only log of what ran. A resolved-then-recurring conflict/failure gets a
// fresh round (and therefore a fresh unit id) from the register; this module just
// renders whatever the register currently says into the plan shape.

import { outstandingEntries } from "./conflict-register.mjs";

function conflictUnit(entry) {
  return {
    id: `conflict:${entry.id}:r${entry.round}`,
    title: `Resolve sync conflict: ${entry.id}`,
    description:
      `The board issue linked to Jira issue ${entry.id} changed locally after the last pull, so ` +
      `the inbound sync left it alone instead of overwriting it. ${entry.reason ?? ""}\n\n` +
      `Decide which side should win (the board edit or the Jira update), reconcile the two ` +
      `manually, then re-run \`node tools/sync/pull.mjs\` — this ticket is generated straight from ` +
      `the conflict register (${entry.id} round ${entry.round}) and closing it is what marks the ` +
      `conflict resolved for the next pull.`,
  };
}

function failureUnit(entry) {
  return {
    id: `push-failed:${entry.id}:r${entry.round}`,
    title: `Fix failed push: ${entry.id}`,
    description:
      `Pushing a queued change for ${entry.id} back to Jira failed and was left in the outbox. ${entry.reason ?? ""}\n\n` +
      `Fix the underlying problem (e.g. a missing transition, a stale Jira issue), then re-run ` +
      `\`node tools/sync/push.mjs\` — this ticket is generated from the failure register (${entry.id} ` +
      `round ${entry.round}) and closing it is what marks the failure resolved for the next push.`,
  };
}

/**
 * @param {{
 *   cursor: { lastPullAt: string | null, lastPushAt: string | null },
 *   conflictRegister: { entries: Record<string, object> },
 *   failureRegister: { entries: Record<string, object> },
 * }} state
 * @returns {{ units: Array<{id:string,title:string,description:string}>, converged: boolean, note?: string }}
 */
export function buildLoopPlan({ cursor, conflictRegister, failureRegister }) {
  if (!cursor?.lastPullAt) {
    return { units: [], converged: false, note: "no successful pull has run yet; nothing to plan" };
  }

  const conflicts = outstandingEntries(conflictRegister);
  const failures = outstandingEntries(failureRegister);
  const units = [...conflicts.map(conflictUnit), ...failures.map(failureUnit)];

  if (units.length === 0) {
    return { units: [], converged: true, note: "no outstanding sync conflicts or failed pushes" };
  }

  return {
    units,
    converged: false,
    note: `${conflicts.length} conflict(s), ${failures.length} failed push(es) outstanding`,
  };
}
