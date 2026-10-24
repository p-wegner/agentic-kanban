// `sync resolve` (#1643): settle ONE diverged issue on purpose, from a context that has no Jira
// credentials of its own (an agent working a "Resolve sync conflict" ticket). The board runs this
// with the credentials injected; the agent only names the key and the decision.
//
//   show              read-only: board now / last sync / Jira now, per mapped field, with the
//                     evidence (when each side last changed the field, and who) for differing rows
//   keep jira         force-pull that one issue: Jira overwrites the board issue
//   keep board        push the board's mapped fields to Jira once. Field edits are never pushed by
//                     the regular push (it sends transitions, comments and creates), so this is the
//                     one sanctioned field write, and only ever for the key it was asked about.
//   keep {...}        per field ({"title":"board","priority":"jira"}): only the named fields move
//   keep needs-human  the evidence does not decide: nothing is written anywhere (#1697)
//
// Every overwrite posts a comment on the LOSING side naming each replaced value and the deciding
// ticket, and the result carries a markdown record for docs/jira-sync/conflicts/<key>.md.
//
// Pure over injected clients and state, like the rest of lib/, so it is testable without a CLI.

import { FIELDS, BOARD_PRIORITY_TO_JIRA, mapJiraIssueToBoardFields, mapBoardTypeToJira, resolveBoardStatusId } from "./field-map.mjs";
import { markdownToAdf } from "./adf.mjs";
import { attributeComment } from "./comment-marker.mjs";
import { boardFieldsOf, fieldTable, incomingFieldsOf } from "./field-snapshot.mjs";
import { runInboundSync } from "./sync-engine.mjs";
import { DIRECTION_FIELDS, withOwners } from "./sync-direction.mjs";

/** No ownership known (a caller that did not pass the board's directions): every field is shared, nothing is refused. */
const SHARED_DIRECTIONS = Object.freeze({ fields: Object.freeze(Object.fromEntries(DIRECTION_FIELDS.map((f) => [f, "both"]))) });

export const KEEP_SIDES = ["board", "jira"];
export const NEEDS_HUMAN = "needs-human";
/** Fields a per-field keep may name. Status is a push transition, never part of a resolve. */
export const KEEP_FIELDS = ["title", "description", "priority", "type"];

const JIRA_CHANGELOG_FIELD = { title: "summary", description: "description", priority: "priority", type: "issuetype", status: "status" };

/** Per mapped field: when Jira last changed it and who did it, from the issue's changelog (`expand=changelog`). */
export function jiraFieldEvidence(jiraIssue) {
  const histories = jiraIssue?.changelog?.histories ?? [];
  const out = {};
  for (const [field, jiraName] of Object.entries(JIRA_CHANGELOG_FIELD)) {
    let best = null;
    for (const h of histories) {
      if (!(h.items ?? []).some((i) => String(i.field ?? "").toLowerCase() === jiraName)) continue;
      if (!best || String(h.created ?? "") > String(best.created ?? "")) best = h;
    }
    if (best) out[field] = { at: best.created ?? null, by: best.author?.displayName ?? best.author?.emailAddress ?? null };
  }
  return out;
}

function addEvidence(rows, jiraIssue, boardIssue) {
  const jira = jiraFieldEvidence(jiraIssue);
  const fallback = { at: jiraIssue?.fields?.updated ?? null, by: null, approximate: true };
  const board = { at: boardIssue.updatedAt ?? null, by: boardIssue.updatedBy ?? boardIssue.lastEditor ?? null, approximate: true };
  return rows.map((r) => (r.differs ? { ...r, evidence: { board, jira: jira[r.field] ?? fallback } } : r));
}

async function loadSides({ client, boardClient, projectId, siteUrl, key }) {
  const jiraIssue = await client.getIssue(key, { fields: FIELDS, expand: "changelog" });
  const boardIssue = (await boardClient.listExternallyTrackedIssues(projectId)).get(key);
  if (!boardIssue) return { error: `no board issue is linked to ${key}` };
  const boardStatuses = await boardClient.listStatuses(projectId);
  return { jiraIssue, boardIssue, boardStatuses, mapped: mapJiraIssueToBoardFields(jiraIssue, { siteUrl }) };
}

/** Normalises `keep` to { kind: "board"|"jira"|"human"|"fields", ... } or { error }. */
function parseKeep(keep) {
  if (keep === "board" || keep === "jira") return { kind: keep };
  if (keep === NEEDS_HUMAN) return { kind: "human" };
  if (keep && typeof keep === "object" && !Array.isArray(keep)) {
    const entries = Object.entries(keep);
    if (entries.length === 0) return { error: "a per-field keep needs at least one field" };
    for (const [field, side] of entries) {
      if (!KEEP_FIELDS.includes(field)) return { error: `unknown field "${field}" in "keep" (use ${KEEP_FIELDS.join(", ")})` };
      if (!KEEP_SIDES.includes(side)) return { error: `"keep.${field}" must be "board" or "jira" (got "${side}")` };
    }
    return { kind: "fields", map: keep };
  }
  return { error: `"keep" must be "board", "jira", "needs-human" or a per-field map (got ${JSON.stringify(keep)})` };
}

const show = (v) => (v == null || v === "" ? "(empty)" : JSON.stringify(String(v).length > 200 ? `${String(v).slice(0, 200)}...` : String(v)));
const who = (e) => (e ? `${e.at ?? "?"}${e.by ? ` by ${e.by}` : ""}${e.approximate ? " (issue-level)" : ""}` : "unknown");
const ticketRef = (ticket) => `#${String(ticket).replace(/^#/, "")}`;

/** One bullet per overwritten field: what the LOSING side held, and what replaced it. */
function overwriteLines(rows, loser, fields) {
  const winner = loser === "jira" ? "board" : "jira";
  return rows.filter((r) => r.differs && fields.includes(r.field)).map((r) => `- ${r.field}: was ${show(r[loser])}, now ${show(r[winner])}`);
}

/** "kept from the board: priority / kept from Jira: title" (#1709): which fields came from which side. */
function keptSummary({ fromBoard, fromJira }) {
  return [
    ...(fromBoard.length ? [`kept from the board: ${fromBoard.join(", ")}`] : []),
    ...(fromJira.length ? [`kept from Jira: ${fromJira.join(", ")}`] : []),
  ].join(" / ");
}

function auditText({ key, ticket, kept, reason, lines }) {
  const by = ticket != null ? `ticket ${ticketRef(ticket)}` : "a sync-conflicts loop ticket";
  return `**Sync conflict on ${key} resolved by ${by}: ${kept}.**\n\n${reason ? `Reason: ${reason}\n\n` : ""}Overwritten here (restore by hand if this was wrong):\n${lines.join("\n")}`;
}

function conflictRecord({ key, ticket, rows, decision, reason, audit }) {
  const table = rows.map((r) => `| ${r.field}${r.differs ? " **(differs)**" : ""} | ${show(r.board)} | ${show(r.lastSync)} | ${show(r.jira)} |`);
  const evidence = rows.filter((r) => r.evidence).map((r) => `- ${r.field}: board changed ${who(r.evidence.board)}; Jira changed ${who(r.evidence.jira)}`);
  return [
    `# Sync conflict ${key}`,
    "",
    ...(ticket != null ? [`Decided in ticket ${ticketRef(ticket)}.`, ""] : []),
    "| Field | Board now | Last sync | Jira now |",
    "| --- | --- | --- | --- |",
    ...table,
    "",
    "## Evidence",
    "",
    ...(evidence.length ? evidence : ["(no differing fields)"]),
    "",
    "## Decision",
    "",
    decision,
    ...(reason ? ["", `Reason: ${reason}`] : []),
    ...(audit ? ["", "## Overwritten values", "", audit] : []),
    "",
  ].join("\n");
}

async function postJiraAudit(client, key, lines, { ticket, kept, reason }) {
  if (lines.length === 0) return { posted: false, reason: "nothing overwritten" };
  try {
    await client.addComment(key, attributeComment(auditText({ key, ticket, kept, reason, lines }), { boardCommentId: "sync-resolve" }));
    return { posted: true };
  } catch (err) {
    return { posted: false, error: err.message };
  }
}

async function postBoardAudit(boardClient, issueId, lines, { key, ticket, kept, reason }) {
  if (lines.length === 0) return { posted: false, reason: "nothing overwritten" };
  try {
    await boardClient.addComment(issueId, {
      kind: "note",
      author: "system",
      body: auditText({ key, ticket, kept, reason, lines }),
      // origin "jira" keeps push from echoing this audit note back into Jira.
      payload: { origin: "jira", syncResolve: true },
    });
    return { posted: true };
  } catch (err) {
    return { posted: false, error: err.message };
  }
}

/**
 * @returns {Promise<{ ok: boolean, mode: "show"|"keep", key: string, keep?: unknown, fields?: object[], nextState?: object, needsHuman?: boolean, artifact?: { path: string, content: string }, reason?: string }>}
 */
export async function resolveIssue({ client, boardClient, projectId, siteUrl, key, keep, ticket, reason, knownState, directions = SHARED_DIRECTIONS, override = false, now = new Date().toISOString() }) {
  if (!key) return { ok: false, mode: keep ? "keep" : "show", key, reason: "an issue key is required" };
  const decision = keep != null ? parseKeep(keep) : null;
  if (decision?.error) return { ok: false, mode: "keep", key, reason: decision.error };
  // Every decision records WHY (#1709): the record and the audit comment are all a later reader has.
  if (decision && !String(reason ?? "").trim()) return { ok: false, mode: "keep", key, reason: '"reason" is required for every keep: say why this side wins (or why nobody can tell)' };
  const sides = await loadSides({ client, boardClient, projectId, siteUrl, key });
  if (sides.error) return { ok: false, mode: keep ? "keep" : "show", key, reason: sides.error };
  const { jiraIssue, boardIssue, boardStatuses, mapped } = sides;
  const known = knownState.issues[key];
  const statusName = (id) => boardStatuses.find((st) => st.id === id)?.name ?? id;
  const rows = withOwners(addEvidence(
    fieldTable(
      boardFieldsOf(boardIssue),
      known?.fields ?? null,
      incomingFieldsOf(mapped, resolveBoardStatusId(mapped.statusCategoryKey, boardStatuses)),
      { statusName },
    ),
    jiraIssue,
    boardIssue,
  ), directions);
  const artifactPath = `docs/jira-sync/conflicts/${key}.md`;

  if (keep == null) return { ok: true, mode: "show", key, fields: rows };

  const finish = (extra) => ({ ok: true, mode: "keep", key, keep, fields: rows, ...extra });

  if (decision.kind === "human") {
    const why = reason || "the evidence does not decide";
    return finish({
      needsHuman: true,
      reason: why,
      applied: "nothing written: handed to a human",
      artifact: { path: artifactPath, content: conflictRecord({ key, ticket, rows, decision: "Needs a human: nothing was written to Jira or the board.", reason: why }) },
    });
  }

  // Ownership (#1709): a keep that writes against the owner of a differing field needs an explicit override.
  const against = (winner) => (f) => rows.find((r) => r.field === f)?.owner === (winner === "board" ? "jira" : "board");
  const differing = (f) => rows.find((r) => r.field === f)?.differs === true;
  const sideFor = (f) => (decision.kind === "fields" ? decision.map[f] : decision.kind);
  const violations = decision.kind === "human" ? [] : KEEP_FIELDS.filter((f) => differing(f) && sideFor(f) && against(sideFor(f))(f));
  if (violations.length && override !== true) {
    return {
      ok: false,
      mode: "keep",
      key,
      fields: rows,
      reason: `${violations.map((f) => `${f} is owned by ${rows.find((r) => r.field === f).owner} (${rows.find((r) => r.field === f).owner === "jira" ? "jira-to-board" : "board-to-jira"})`).join(", ")}: keeping ${[...new Set(violations.map(sideFor))].join("/")} writes against the owner. Keep the owner's side, or repeat the call with "override": true and a reason that says why.`,
    };
  }
  const overrideNote = violations.length ? ` (override: ${violations.join(", ")} written against the owner)` : "";

  if (decision.kind === "jira") {
    // A one-issue pull. The engine classifies every KNOWN key missing from the search as deleted
    // or out of scope, so it is handed only this key's state, and the result merged back.
    const result = await runInboundSync(client, boardClient, {
      jql: `key = "${key}"`,
      siteUrl,
      projectId,
      knownState: { issues: known ? { [key]: known } : {} },
      forceKeys: new Set([key]),
      now,
    });
    const nextState = { issues: { ...knownState.issues, ...(result.nextState.issues[key] ? { [key]: result.nextState.issues[key] } : {}) } };
    const lines = overwriteLines(rows, "board", KEEP_FIELDS);
    const kept = keptSummary({ fromBoard: [], fromJira: rows.filter((r) => r.differs && KEEP_FIELDS.includes(r.field)).map((r) => r.field) });
    const auditComment = { board: await postBoardAudit(boardClient, boardIssue.id, lines, { key, ticket, kept, reason }) };
    return finish({
      nextState,
      applied: "board overwritten from Jira",
      auditComment,
      artifact: { path: artifactPath, content: conflictRecord({ key, ticket, rows, decision: `Kept Jira: the board issue was overwritten from Jira${overrideNote}.`, reason, audit: lines.join("\n") }) },
    });
  }

  // keep board (whole issue) or per field
  const sideOf = decision.kind === "board" ? Object.fromEntries(KEEP_FIELDS.map((f) => [f, "board"])) : decision.map;
  const differs = (f) => rows.find((r) => r.field === f)?.differs === true;
  const boardFields = KEEP_FIELDS.filter((f) => sideOf[f] === "board" && (decision.kind === "board" || differs(f)));
  const jiraFields = KEEP_FIELDS.filter((f) => sideOf[f] === "jira" && differs(f));

  const jiraPatch = {};
  if (boardFields.includes("title")) jiraPatch.summary = boardIssue.title;
  if (boardFields.includes("description") && boardIssue.description != null) jiraPatch.description = markdownToAdf(boardIssue.description);
  const priority = BOARD_PRIORITY_TO_JIRA[String(boardIssue.priority ?? "").toLowerCase()];
  if (boardFields.includes("priority") && priority) jiraPatch.priority = { name: priority };
  const issueType = mapBoardTypeToJira(boardIssue.issueType);
  if (boardFields.includes("type") && issueType) jiraPatch.issuetype = { name: issueType };
  if (Object.keys(jiraPatch).length) await client.updateIssueFields(key, jiraPatch);

  let finalBoard = boardIssue;
  if (jiraFields.length) {
    const boardPatch = {};
    if (jiraFields.includes("title")) boardPatch.title = mapped.title;
    if (jiraFields.includes("description")) boardPatch.description = mapped.description;
    if (jiraFields.includes("priority")) boardPatch.priority = mapped.priority;
    if (jiraFields.includes("type")) boardPatch.issueType = mapped.type;
    finalBoard = { ...boardIssue, ...boardPatch, ...((await boardClient.updateIssue(boardIssue.id, boardPatch)) ?? {}) };
  }

  const jiraLines = overwriteLines(rows, "jira", boardFields);
  const boardLines = overwriteLines(rows, "board", jiraFields);
  const auditComment = {};
  const kept = keptSummary({ fromBoard: boardFields.filter((f) => differing(f)), fromJira: jiraFields });
  if (jiraLines.length) auditComment.jira = await postJiraAudit(client, key, jiraLines, { ticket, kept, reason });
  if (boardLines.length) auditComment.board = await postBoardAudit(boardClient, boardIssue.id, boardLines, { key, ticket, kept, reason });
  const audit = [...jiraLines.map((l) => `Jira ${l}`), ...boardLines.map((l) => `Board ${l}`)].join("\n");

  // Re-baseline against what Jira holds NOW (after the audit comment, which bumps `updated`), so the
  // next pull sees "unchanged", not a conflict.
  const after = await client.getIssue(key, { fields: FIELDS });
  const nextState = {
    issues: {
      ...knownState.issues,
      [key]: {
        ...known,
        updated: mapJiraIssueToBoardFields(after, { siteUrl }).jiraUpdated,
        boardIssueId: boardIssue.id,
        boardUpdatedAt: finalBoard.updatedAt ?? boardIssue.updatedAt,
        fields: boardFieldsOf(finalBoard),
      },
    },
  };
  const summary = decision.kind === "board"
    ? `Kept the board: Jira was updated from the board${overrideNote}.`
    : `Per field: ${Object.entries(decision.map).map(([f, side]) => `${f} from ${side}`).join(", ")}${overrideNote}.`;
  return finish({
    nextState,
    auditComment,
    applied: `Jira updated from the board (${Object.keys(jiraPatch).join(", ") || "nothing"})${jiraFields.length ? `; board updated from Jira (${jiraFields.join(", ")})` : ""}; status is not written here, push handles transitions`,
    artifact: { path: artifactPath, content: conflictRecord({ key, ticket, rows, decision: summary, reason, audit }) },
  });
}
