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

import { isNonJiraKey } from "./outbox-producer.mjs";
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

/** The plugin slug the board's `/api/plugins/:id` routes accept in place of the row id. */
export const PLUGIN_SLUG = "jira-sync";

/** How the agent reaches the resolve endpoint (#1697): real values where the board gave them, no `<...>` to guess. */
function resolveInstructions(board, key) {
  const base = board?.boardUrl ? board.boardUrl.replace(/\/+$/, "") : null;
  const projectId = board?.projectId ?? null;
  const endpoint = base ? `${base}/api/plugins/${PLUGIN_SLUG}/sync/resolve` : `/api/plugins/${PLUGIN_SLUG}/sync/resolve (on the board your board tools use)`;
  const show = projectId ? JSON.stringify({ projectId, key }) : `{ "projectId": "(this ticket's project id)", "key": "${key}" }`;
  return (
    `Call \`POST ${endpoint}\` with a JSON body (the board holds the Jira credentials, you do not):\n\n` +
    `- Read the live values, with when and by whom each differing field last changed on each side: \`${show}\` (no \`keep\` = show).\n` +
    `- Board wins: add \`"keep": "board"\`. Jira wins: add \`"keep": "jira"\`.\n` +
    `- Per field: \`"keep": {"title": "board", "priority": "jira"}\` moves only those fields.\n` +
    `- Cannot tell: \`"keep": "needs-human", "reason": "why"\` writes NOTHING to Jira or the board.\n` +
    `- Every \`keep\` needs a \`"reason"\` (it goes into the record and the audit comment) and \`"ticket": {{issueNumber}}\` (the audit comment names it).\n` +
    `- Check the \`owner\` of each differing field in the show output: the owner's side is the default winner. ` +
    `A keep against the owner is refused unless the body also has \`"override": true\` and a reason that says why.\n` +
    localhostNote(base) +
    "\n"
  );
}

/** A host-only address is useless to an agent on a fleet worker (#1709): say where the reachable one is. */
function localhostNote(base) {
  if (!base || !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(base)) return "";
  return `- That address is the board's own host. If you run on another machine, use the board address your board MCP server is configured with (see \`.mcp-kanban.json\`) and keep the path.\n`;
}

function conflictUnit(entry, board) {
  const table = fieldTableMarkdown(entry.fields);
  const handedOff = entry.needsHuman
    ? `**An earlier round marked this conflict needs-human** (${entry.needsHumanReason ?? "no reason recorded"}). ` +
      `Do not decide it again: leave Jira and the board untouched, write the table to ` +
      `\`docs/jira-sync/conflicts/${entry.id}.md\`, commit it, and finish so a human can look.\n\n`
    : "";
  const owned = (entry.fields ?? []).filter((f) => f.differs && (f.owner === "jira" || f.owner === "board"));
  const ownership = owned.length
    ? owned.map((f) => `${f.owner === "jira" ? "Jira" : "The board"} owns ${f.field} here: the default is keep ${f.owner === "jira" ? "jira" : "board"}.`).join(" ") + "\n\n"
    : "";
  return {
    id: `conflict:${entry.id}:r${entry.round}`,
    title: `Resolve sync conflict: ${entry.id}`,
    description:
      `The board issue linked to Jira issue ${entry.id} changed locally after the last pull, so ` +
      `the inbound sync left it alone instead of overwriting it. ${entry.reason ?? ""}\n\n` +
      (table
        ? `What each side holds, per field (as of the pull that found the conflict):\n\n${table}\n\n`
        : `(No field values were recorded for this conflict; read them live with the "show" call below.)\n\n`) +
      handedOff +
      ownership +
      `Decide which side should win (per field when each side changed different fields), or that nobody can tell. ` +
      `\`node tools/sync/*.mjs\` will not run for you; go through the board:\n\n` +
      resolveInstructions(board, entry.id) +
      `Then write the returned \`artifact\` to \`docs/jira-sync/conflicts/${entry.id}.md\` and commit it.\n\n` +
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
export function buildLoopPlan({ cursor, conflictRegister, failureRegister, board = null }) {
  if (!cursor?.lastPullAt) {
    return { units: [], converged: false, note: "no successful pull has run yet; nothing to plan" };
  }

  const conflicts = outstandingEntries(conflictRegister);
  // A loop ticket's own key is not a Jira issue (#1718): never plan a failed push for it.
  const failures = outstandingEntries(failureRegister).filter((e) => e.id.startsWith("board:") || !isNonJiraKey(e.id));
  // #1709: a needs-human conflict is waiting for a person; another agent round would only re-commit the same record.
  const waiting = conflicts.filter((e) => e.needsHuman);
  const units = [
    ...conflicts.filter((e) => !e.needsHuman).map((e) => conflictUnit(e, board)),
    ...failures.map(failureUnit),
  ];
  const needsHuman = waiting.length;
  // Held, not resolved (#1718): the board must not close an open ticket of a waiting unit as "Resolved by sync".
  const held = waiting.map((e) => `conflict:${e.id}:r${e.round}`);

  if (units.length === 0 && needsHuman > 0) {
    return {
      units: [],
      converged: false,
      held,
      note: `${conflicts.length} conflict(s) outstanding, ${needsHuman} needs-human (no agent ticket: ${waiting.map((e) => e.id).join(", ")} wait for a human decision)`,
    };
  }

  if (units.length === 0) {
    return { units: [], converged: true, note: "no outstanding sync conflicts or failed pushes" };
  }

  return {
    units,
    converged: false,
    ...(held.length ? { held } : {}),
    note: `${conflicts.length} conflict(s)${needsHuman ? ` (${needsHuman} needs-human)` : ""}, ${failures.length} failed push(es) outstanding`,
  };
}
