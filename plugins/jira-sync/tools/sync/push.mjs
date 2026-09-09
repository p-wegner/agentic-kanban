#!/usr/bin/env node
// The manifest's `sync.push` command. Applies queued local changes (status
// transitions resolved via the transition graph, attributed comments, and
// issue creation for board issues with no `external_key` yet) to Jira, one
// entry at a time, and reports exactly which entries succeeded/failed.
// --dry-run reports the exact intended mutations without sending any of
// them. The outbox is plain JSON at `${JIRA_SYNC_STATE_DIR}/outbox.json`;
// nothing here decides ITS contents — wiring board-side edits into that
// file is separate, later work (#1076). The deterministic per-entry logic
// lives in ../lib/push-plan.mjs so it can be tested with no CLI/env.

import { checkProfile } from "../lib/profile.mjs";
import { buildClientFromEnv, printResult, isDryRun } from "../lib/cli-client.mjs";
import {
  readOutbox,
  readWritebacks,
  writeJsonFile,
  outboxPath,
  writebacksPath,
  readFailureRegister,
  failureRegisterPath,
  readCursor,
  cursorPath,
} from "../lib/state.mjs";
import { runPush } from "../lib/push-plan.mjs";
import { updateRegister, pushFailureIdentity } from "../lib/conflict-register.mjs";
import { JiraAuthError } from "../lib/auth.mjs";

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
  const { applied, failed, remaining, writebacks } = await runPush(ctx.client, outbox.entries, { dryRun });

  if (!dryRun) {
    writeJsonFile(outboxPath(stateDir), { entries: remaining });
    if (writebacks.length > 0) {
      const existing = readWritebacks(stateDir);
      for (const wb of writebacks) existing.keys[wb.boardIssueId] = wb.key;
      writeJsonFile(writebacksPath(stateDir), existing);
    }

    const failures = failed.map((f) => ({ id: pushFailureIdentity(f), reason: f.reason }));
    const nextRegister = updateRegister(readFailureRegister(stateDir), failures);
    writeJsonFile(failureRegisterPath(stateDir), nextRegister);

    const cursor = readCursor(stateDir);
    writeJsonFile(cursorPath(stateDir), { ...cursor, lastPushAt: new Date().toISOString() });
  }

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
