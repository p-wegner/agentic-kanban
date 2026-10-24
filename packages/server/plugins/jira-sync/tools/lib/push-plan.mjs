// The deterministic core of a push: for each outbox entry, resolve what
// applying it means (a transition id via the transition graph, an
// attributed comment body, a create payload) and either report it
// (--dry-run) or apply it. Shared so dry-run and real runs can never
// disagree about what an entry means — only about whether the write
// actually happens. Entry kinds:
//   { kind: "transition", key, targetStatus }
//   { kind: "comment", key, comment: { body, boardCommentId, origin? } }
//   { kind: "create", boardIssueId, fields }
//   { kind: "link", action: "add"|"remove", linkKey, linkType: "blocks"|"relates", from, to }   (#1700)
//   { kind: "assignee", key, boardIssueId, name }   (#1702; name "" unassigns; the accountId comes from assigneeMap)
//   { kind: "fields", key, boardIssueId, fields: { title?, description?, priority?, type?, labels? } }
// A comment entry with `comment.origin === "jira"` is an import echo of a
// Jira comment reflected onto the board — pushing it back would loop, so it
// is always skipped, dry-run or not.

import { resolveTransitionId, TransitionNotFoundError } from "./transitions.mjs";
import { attributeComment } from "./comment-marker.mjs";
import { markdownToAdf } from "./adf.mjs";
import { stripAttachmentFooter } from "./jira-context.mjs";
import { BOARD_PRIORITY_TO_JIRA, accountIdForAssignee, mapBoardTypeToJira } from "./field-map.mjs";
import { jiraLinksOf, linkKey } from "./link-sync.mjs";

/**
 * A create entry rarely knows the Jira project; inject the configured project key and
 * default issue type unless the entry names its own (#1623).
 */
export function prepareCreateFields(fields = {}, { projectKey, defaultIssueType } = {}) {
  const out = { ...fields };
  if (!out.project && projectKey) out.project = { key: projectKey };
  if (!out.issuetype && defaultIssueType) out.issuetype = { name: defaultIssueType };
  if (typeof out.description === "string") out.description = stripAttachmentFooter(out.description);
  if (typeof out.description === "string") out.description = out.description ? markdownToAdf(out.description) : undefined;
  if (out.description === undefined) delete out.description;
  if (Array.isArray(out.labels) && out.labels.length === 0) delete out.labels;
  return out;
}

/** Board-side field values -> a Jira `fields` payload (summary, ADF description, priority name, issue type, labels). */
export function prepareFieldUpdate(fields = {}, { defaultIssueType } = {}) {
  const out = {};
  if ("title" in fields) out.summary = fields.title;
  if ("description" in fields) {
    const body = stripAttachmentFooter(fields.description);
    out.description = body ? markdownToAdf(body) : null;
  }
  if ("priority" in fields) {
    const name = BOARD_PRIORITY_TO_JIRA[String(fields.priority ?? "").toLowerCase()];
    if (name) out.priority = { name };
  }
  if ("type" in fields) {
    const name = mapBoardTypeToJira(fields.type) ?? defaultIssueType;
    if (name) out.issuetype = { name };
  }
  if ("labels" in fields) out.labels = fields.labels ?? [];
  return out;
}

const JIRA_FIELD_TO_BOARD = { summary: "title", description: "description", priority: "priority", issuetype: "type", labels: "labels" };

/** Applies a field update; a 400 naming fields Jira's screen rejects retries without them. */
async function applyFieldUpdate(client, key, payload) {
  const rejected = {};
  let current = payload;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (Object.keys(current).length === 0) break;
    try {
      await client.updateIssueFields(key, current);
      return { sent: current, rejected };
    } catch (err) {
      const errors = err?.status === 400 && err.body?.errors && typeof err.body.errors === "object" ? err.body.errors : null;
      const bad = errors ? Object.keys(errors).filter((f) => f in current) : [];
      if (bad.length === 0) throw err;
      const next = { ...current };
      for (const f of bad) {
        rejected[f] = String(errors[f]);
        delete next[f];
      }
      current = next;
    }
  }
  return { sent: current, rejected };
}

async function describeAndMaybeApply(client, entry, { dryRun, projectKey, defaultIssueType, statusMap, assigneeMap }) {
  if (entry.kind === "transition") {
    const transitions = await client.listTransitions(entry.key);
    let transitionId;
    try {
      transitionId = resolveTransitionId(transitions, entry.targetStatus, { overrides: statusMap });
    } catch (err) {
      if (!(err instanceof TransitionNotFoundError)) throw err;
      return { ok: false, failed: { key: entry.key, kind: "transition", reason: err.message } };
    }
    const description = { key: entry.key, kind: "transition", targetStatus: entry.targetStatus, transitionId };
    if (dryRun) return { ok: true, applied: { ...description, wouldApply: true } };
    await client.transitionIssue(entry.key, transitionId);
    return { ok: true, applied: description };
  }

  if (entry.kind === "comment") {
    if (entry.comment?.origin === "jira") {
      return { ok: true, applied: { key: entry.key, kind: "comment", skipped: "echo-suppressed" } };
    }
    const body = attributeComment(entry.comment.body, { boardCommentId: entry.comment.boardCommentId });
    if (dryRun) return { ok: true, applied: { key: entry.key, kind: "comment", wouldApply: true, preview: body } };
    await client.addComment(entry.key, body);
    return { ok: true, applied: { key: entry.key, kind: "comment" } };
  }

  if (entry.kind === "fields") {
    const payload = prepareFieldUpdate(entry.fields, { defaultIssueType });
    const description = { key: entry.key, boardIssueId: entry.boardIssueId, kind: "fields", fields: Object.keys(payload).map((f) => JIRA_FIELD_TO_BOARD[f] ?? f) };
    if (dryRun) return { ok: true, applied: { ...description, wouldApply: true, payload } };
    const { sent, rejected } = await applyFieldUpdate(client, entry.key, payload);
    const rejectedNames = Object.keys(rejected).map((f) => JIRA_FIELD_TO_BOARD[f] ?? f);
    const applied = { ...description, fields: Object.keys(sent).map((f) => JIRA_FIELD_TO_BOARD[f] ?? f) };
    if (rejectedNames.length === 0) return { ok: true, applied };
    // The entry is consumed (not retried forever): what Jira accepted was written, and the
    // refused fields land in the failed-push register by name.
    return {
      ok: true,
      applied: Object.keys(sent).length > 0 ? applied : undefined,
      failedFields: {
        key: entry.key,
        boardIssueId: entry.boardIssueId,
        kind: "fields",
        reason: `Jira refused field(s) ${rejectedNames.join(", ")}: ${Object.entries(rejected).map(([f, m]) => `${f}: ${m}`).join("; ")}`,
      },
    };
  }

  if (entry.kind === "link") {
    const typeName = entry.linkType === "relates" ? "Relates" : "Blocks";
    const description = { key: entry.from, kind: "link", action: entry.action, linkType: entry.linkType, from: entry.from, to: entry.to };
    // Read the live links first: an add is idempotent and a remove needs the Jira link id.
    const issue = await client.getIssue(entry.from, { fields: ["issuelinks"] });
    const existing = jiraLinksOf(issue).filter((l) => l.kind === entry.linkType && linkKey(l.kind, l.from, l.to) === entry.linkKey);
    if (entry.action === "add") {
      if (existing.length > 0) return { ok: true, applied: { ...description, skipped: "already linked in Jira" } };
      if (dryRun) return { ok: true, applied: { ...description, wouldApply: true } };
      await client.createIssueLink({ typeName, inwardKey: entry.to, outwardKey: entry.from });
      return { ok: true, applied: description };
    }
    if (existing.length === 0) return { ok: true, applied: { ...description, skipped: "no such link in Jira" } };
    if (dryRun) return { ok: true, applied: { ...description, wouldApply: true } };
    for (const l of existing) await client.deleteIssueLink(l.id);
    return { ok: true, applied: description };
  }

  if (entry.kind === "assignee") {
    const name = String(entry.name ?? "").trim();
    // Never guess via user search: a name without a map entry is a failure, and nothing is written.
    const accountId = name === "" ? null : accountIdForAssignee(name, assigneeMap);
    if (name !== "" && !accountId) {
      return { ok: false, failed: { key: entry.key, boardIssueId: entry.boardIssueId, kind: "assignee", reason: `assignee ${name} has no accountId in assigneeMap` } };
    }
    const description = { key: entry.key, boardIssueId: entry.boardIssueId, kind: "assignee", accountId };
    if (dryRun) return { ok: true, applied: { ...description, wouldApply: true } };
    await client.assignIssue(entry.key, accountId);
    return { ok: true, applied: description };
  }

  if (entry.kind === "create") {
    const fields = prepareCreateFields(entry.fields, { projectKey, defaultIssueType });
    const description = { boardIssueId: entry.boardIssueId, kind: "create", fields };
    if (dryRun) return { ok: true, applied: { ...description, wouldApply: true } };
    const created = await client.createIssue(fields);
    return {
      ok: true,
      applied: { ...description, key: created.key },
      writeback: { boardIssueId: entry.boardIssueId, key: created.key },
    };
  }

  return { ok: false, failed: { key: entry.key ?? null, kind: entry.kind ?? "unknown", reason: `unknown entry kind "${entry.kind}"` } };
}

/**
 * Runs every outbox entry against `client`. A per-entry failure never
 * throws — it lands in `failed` (and the entry stays in `remaining`) so one
 * bad entry can't block the rest. With `dryRun: true`, every READ needed to
 * report an accurate outcome still runs (e.g. resolving the transition
 * graph) but no WRITE (`transitionIssue`/`addComment`/`createIssue`) does.
 */
export async function runPush(client, entries, { dryRun = false, projectKey, defaultIssueType, statusMap = {}, assigneeMap = {} } = {}) {
  const applied = [];
  const failed = [];
  const remaining = [];
  const writebacks = [];

  for (const entry of entries) {
    let outcome;
    try {
      outcome = await describeAndMaybeApply(client, entry, { dryRun, projectKey, defaultIssueType, statusMap, assigneeMap });
    } catch (err) {
      failed.push({ key: entry.key ?? entry.boardIssueId ?? null, kind: entry.kind ?? "unknown", reason: err.message, code: err.code ?? null });
      remaining.push(entry);
      continue;
    }

    if (!outcome.ok) {
      failed.push(outcome.failed);
      remaining.push(entry);
      continue;
    }

    if (outcome.applied) applied.push(outcome.applied);
    if (outcome.failedFields) failed.push(outcome.failedFields);
    if (outcome.writeback) writebacks.push(outcome.writeback);
  }

  return { applied, failed, remaining, writebacks };
}
