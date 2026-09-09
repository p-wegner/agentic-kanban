// The deterministic core of a push: for each outbox entry, resolve what
// applying it means (a transition id via the transition graph, an
// attributed comment body, a create payload) and either report it
// (--dry-run) or apply it. Shared so dry-run and real runs can never
// disagree about what an entry means — only about whether the write
// actually happens. Entry kinds:
//   { kind: "transition", key, targetStatus }
//   { kind: "comment", key, comment: { body, boardCommentId, origin? } }
//   { kind: "create", boardIssueId, fields }
// A comment entry with `comment.origin === "jira"` is an import echo of a
// Jira comment reflected onto the board — pushing it back would loop, so it
// is always skipped, dry-run or not.

import { resolveTransitionId, TransitionNotFoundError } from "./transitions.mjs";
import { attributeComment } from "./comment-marker.mjs";

async function describeAndMaybeApply(client, entry, { dryRun }) {
  if (entry.kind === "transition") {
    const transitions = await client.listTransitions(entry.key);
    let transitionId;
    try {
      transitionId = resolveTransitionId(transitions, entry.targetStatus);
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

  if (entry.kind === "create") {
    const description = { boardIssueId: entry.boardIssueId, kind: "create", fields: entry.fields };
    if (dryRun) return { ok: true, applied: { ...description, wouldApply: true } };
    const created = await client.createIssue(entry.fields);
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
export async function runPush(client, entries, { dryRun = false } = {}) {
  const applied = [];
  const failed = [];
  const remaining = [];
  const writebacks = [];

  for (const entry of entries) {
    let outcome;
    try {
      outcome = await describeAndMaybeApply(client, entry, { dryRun });
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

    applied.push(outcome.applied);
    if (outcome.writeback) writebacks.push(outcome.writeback);
  }

  return { applied, failed, remaining, writebacks };
}
