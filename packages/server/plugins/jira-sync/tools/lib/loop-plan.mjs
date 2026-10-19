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

const cell = (v) => String(v ?? "(none)").replace(/\s*\n\s*/g, " / ").replace(/\|/g, "\\|") || "(empty)";

/** The three-way field table (board now / last sync / Jira now); empty when the register holds no fields. */
export function fieldTableMarkdown(fields) {
  if (!Array.isArray(fields) || fields.length === 0) return "";
  const rows = fields.map(
    (f) => `| ${f.field}${f.differs ? " **(differs)**" : ""} | ${cell(f.board)} | ${cell(f.lastSync)} | ${cell(f.jira)} |`,
  );
  return ["| Field | Board now | Last sync | Jira now |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

function conflictUnit(entry) {
  const table = fieldTableMarkdown(entry.fields);
  return {
    id: `conflict:${entry.id}:r${entry.round}`,
    title: `Resolve sync conflict: ${entry.id}`,
    description:
      `The board issue linked to Jira issue ${entry.id} changed locally after the last pull, so ` +
      `the inbound sync left it alone instead of overwriting it. ${entry.reason ?? ""}\n\n` +
      (table
        ? `What each side holds, per field (as of the pull that found the conflict):\n\n${table}\n\n`
        : `(No field values were recorded for this conflict; read them live with the "show" call below.)\n\n`) +
      `Decide which side should win, then apply the decision through the board. You have no Jira ` +
      `credentials and \`node tools/sync/*.mjs\` will not run for you:\n\n` +
      `- Read the live three-way values: \`POST /api/plugins/<jira-sync plugin id>/sync/resolve\` ` +
      `\`{ "projectId": "<this project>", "key": "${entry.id}" }\` (no \`keep\` = show).\n` +
      `- Board wins: same call with \`"keep": "board"\`. It pushes the board's mapped fields to Jira once.\n` +
      `- Jira wins: same call with \`"keep": "jira"\`. It overwrites the board issue from Jira.\n\n` +
      `Do not decide "the board wins" without looking at the Jira column: Jira may have been changed on purpose. ` +
      `Closing this ticket does NOT resolve the conflict by itself; only the sync does, once the two sides agree ` +
      `(${entry.id} round ${entry.round}). If it is still outstanding after this ticket closes, the loop opens the next round.`,
  };
}

function failureUnit(entry) {
  return {
    id: `push-failed:${entry.id}:r${entry.round}`,
    title: `Fix failed push: ${entry.id}`,
    description:
      `Pushing a queued change for ${entry.id} back to Jira failed and was left in the outbox. ${entry.reason ?? ""}\n\n` +
      `Fix the underlying problem (e.g. a missing transition, a stale Jira issue), then let the next push ` +
      `run (the board or a human triggers it; you have no Jira access) — this ticket is generated from the failure register (${entry.id} ` +
      `round ${entry.round}). Closing this ticket does not resolve the failure by itself; the next push does, once the cause is gone, ` +
      `and the board then closes this ticket if it is still open.`,
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
