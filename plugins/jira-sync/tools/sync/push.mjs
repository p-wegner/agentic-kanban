#!/usr/bin/env node
// The manifest's `sync.push` command. Applies queued local changes (status
// transitions, comments) to Jira, one entry at a time, and reports exactly
// which entries succeeded/failed. --dry-run reports what would be sent
// without sending it. The outbox is plain JSON at
// `${JIRA_SYNC_STATE_DIR}/outbox.json`; nothing here decides ITS contents —
// wiring board-side edits into that file is separate, later work (#1076).

import { checkProfile } from "../lib/profile.mjs";
import { buildClientFromEnv, printResult, isDryRun } from "../lib/cli-client.mjs";
import { readOutbox, writeJsonFile, outboxPath } from "../lib/state.mjs";
import { JiraAuthError } from "../lib/auth.mjs";

async function applyEntry(client, entry) {
  if (entry.transitionId) await client.transitionIssue(entry.key, entry.transitionId);
  if (entry.comment) await client.addComment(entry.key, entry.comment);
}

async function main() {
  const profile = checkProfile(process.env.JIRA_SYNC_PROFILE_PATH);
  if (!profile.ok) return { ok: false, step: "profile", reason: profile.reason };

  let ctx;
  try {
    ctx = buildClientFromEnv();
  } catch (err) {
    if (err instanceof JiraAuthError) return { ok: false, step: "credentials", reason: err.message };
    throw err;
  }

  const stateDir = process.env.JIRA_SYNC_STATE_DIR;
  if (!stateDir) return { ok: false, step: "config", reason: "JIRA_SYNC_STATE_DIR is not set" };

  const dryRun = isDryRun();
  const outbox = readOutbox(stateDir);
  const applied = [];
  const failed = [];
  const remaining = [];

  for (const entry of outbox.entries) {
    if (dryRun) {
      applied.push({ key: entry.key, wouldApply: true });
      continue;
    }
    try {
      await applyEntry(ctx.client, entry);
      applied.push({ key: entry.key });
    } catch (err) {
      failed.push({ key: entry.key, reason: err.message, code: err.code ?? null });
      remaining.push(entry);
    }
  }

  if (!dryRun) writeJsonFile(outboxPath(stateDir), { entries: remaining });

  return {
    ok: failed.length === 0,
    step: "push",
    dryRun,
    total: outbox.entries.length,
    appliedCount: applied.length,
    failedCount: failed.length,
    applied,
    failed,
  };
}

const result = await main();
printResult(result);
process.exit(result.ok ? 0 : 1);
