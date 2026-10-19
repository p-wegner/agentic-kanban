#!/usr/bin/env node
// The manifest's `sync.push` command. Applies queued local changes (status
// transitions resolved via the transition graph, attributed comments, and
// issue creation for board issues with no `external_key` yet) to Jira, one
// entry at a time, and reports exactly which entries succeeded/failed.
// --dry-run reports the exact intended mutations without sending any of
// them. The outbox is plain JSON at `${JIRA_SYNC_STATE_DIR}/outbox.json`;
// Before applying, board-side changes (status moves, new comments, opt-in
// creates) are diffed against the last snapshot and enqueued (#1623, see
// ../lib/outbox-producer.mjs), and create writebacks are landed on the board
// issue. The deterministic per-entry logic lives in ../lib/push-plan.mjs so it
// can be tested with no CLI/env.

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
  readBoardSnapshot,
  boardSnapshotPath,
} from "../lib/state.mjs";
import { BoardClient, BoardConfigError, resolveBoardConfigFromEnv } from "../lib/board-client.mjs";
import { createDefaultBoardFixtureFetch } from "../lib/board-fixtures.mjs";
import { planOutbox } from "../lib/outbox-producer.mjs";
import { applyWritebacks } from "../lib/writebacks.mjs";
import { runPush } from "../lib/push-plan.mjs";
import { updateRegister, pushFailureIdentity } from "../lib/conflict-register.mjs";
import { JiraAuthError } from "../lib/auth.mjs";

function parseStatusMap(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
  const env = process.env;
  const statusMap = parseStatusMap(env.SYNC_CONFIG_STATUSMAP ?? env.JIRA_SYNC_STATUS_MAP);
  if (statusMap === null) return { ok: false, step: "config", reason: "statusMap must be a JSON object of board status -> Jira status name" };
  const pushOptions = {
    dryRun,
    projectKey: ctx.projectKey,
    defaultIssueType: env.SYNC_CONFIG_DEFAULTISSUETYPE || env.JIRA_DEFAULT_ISSUE_TYPE || "Task",
    statusMap,
  };
  const createEnabled = /^(1|true|yes|on)$/i.test(env.SYNC_CONFIG_PUSHCREATE ?? env.JIRA_SYNC_PUSH_CREATE ?? "");

  // Board access is optional for a bare outbox push (standalone use), required to enqueue.
  let boardClient = null;
  let boardProjectId = null;
  try {
    const boardConfig = ctx.selfTest
      ? { boardUrl: "https://fixture.board.local", projectId: "fixture-project" }
      : resolveBoardConfigFromEnv();
    boardProjectId = boardConfig.projectId;
    boardClient = new BoardClient({
      boardUrl: boardConfig.boardUrl,
      fetchImpl: ctx.selfTest ? createDefaultBoardFixtureFetch() : undefined,
    });
  } catch (err) {
    if (!(err instanceof BoardConfigError)) throw err;
  }

  let writebackFailures = [];
  let enqueued = 0;
  let plannedEntries = [];
  let pendingWritebacks = readWritebacks(stateDir);
  if (boardClient) {
    try {
      const wb = await applyWritebacks(boardClient, pendingWritebacks, { siteUrl: ctx.credentials.siteUrl, dryRun });
      writebackFailures = wb.failed;
      pendingWritebacks = { keys: wb.keys };
      if (!dryRun && wb.applied.length > 0) writeJsonFile(writebacksPath(stateDir), pendingWritebacks);

      const statuses = await boardClient.listStatuses(boardProjectId);
      const issues = await boardClient.listIssues(boardProjectId);
      const commentsByIssueId = {};
      for (const issue of issues) {
        if (issue.externalKey) commentsByIssueId[issue.id] = await boardClient.listComments(issue.id);
      }
      const planned = planOutbox({
        issues,
        statusNameById: new Map(statuses.map((st) => [st.id, st.name])),
        commentsByIssueId,
        snapshot: readBoardSnapshot(stateDir),
        outboxEntries: readOutbox(stateDir).entries,
        pendingWritebackIds: new Set(Object.keys(pendingWritebacks.keys)),
        createEnabled,
      });
      enqueued = planned.entries.length;
      plannedEntries = planned.entries;
      if (!dryRun) {
        writeJsonFile(outboxPath(stateDir), { entries: [...readOutbox(stateDir).entries, ...planned.entries] });
        writeJsonFile(boardSnapshotPath(stateDir), planned.nextSnapshot);
      }
    } catch (err) {
      return { ok: false, step: "enqueue", reason: err.message };
    }
  }

  const outbox = readOutbox(stateDir);
  // dry-run does not persist the enqueued entries, so report them as if queued.
  const entries = dryRun ? [...outbox.entries, ...plannedEntries] : outbox.entries;
  const { applied, failed, remaining, writebacks } = await runPush(ctx.client, entries, pushOptions);

  if (!dryRun) {
    writeJsonFile(outboxPath(stateDir), { entries: remaining });
    if (writebacks.length > 0) {
      const existing = readWritebacks(stateDir);
      for (const wb of writebacks) existing.keys[wb.boardIssueId] = wb.key;
      writeJsonFile(writebacksPath(stateDir), existing);
      // Land the new keys on the board issues NOW, before any pull can import them again.
      if (boardClient) {
        const landed = await applyWritebacks(boardClient, existing, { siteUrl: ctx.credentials.siteUrl });
        writebackFailures = landed.failed;
        writeJsonFile(writebacksPath(stateDir), { keys: landed.keys });
      }
    }

    const failures = failed.map((f) => ({ id: pushFailureIdentity(f), reason: f.reason }));
    const nextRegister = updateRegister(readFailureRegister(stateDir), failures);
    writeJsonFile(failureRegisterPath(stateDir), nextRegister);

    const cursor = readCursor(stateDir);
    writeJsonFile(cursorPath(stateDir), { ...cursor, lastPushAt: new Date().toISOString() });
  }

  return {
    ok: failed.length === 0 && writebackFailures.length === 0,
    step: "push",
    dryRun,
    total: entries.length,
    enqueued,
    writebackFailures,
    appliedCount: applied.length,
    failedCount: failed.length,
    applied,
    failed,
  };
}

const result = await main();
printResult(result);
process.exit(result.ok ? 0 : 1);
