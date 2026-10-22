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
import { buildClientFromEnv, printResult, isDryRun, checkAuth } from "../lib/cli-client.mjs";
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
  readPullState,
  pullStatePath,
} from "../lib/state.mjs";
import { BoardClient, BoardConfigError, resolveBoardConfigFromEnv } from "../lib/board-client.mjs";
import { createDefaultBoardFixtureFetch } from "../lib/board-fixtures.mjs";
import { loadBoardState, refreshPullStateAfterPush } from "../lib/state-sync.mjs";
import { resolveSyncDirections } from "../lib/sync-direction.mjs";
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

  const authFailure = await checkAuth(ctx.client);
  if (authFailure) return authFailure;

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
  const directions = resolveSyncDirections(env);
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
  let baselined = 0; // issues recorded as the baseline on a first run: nothing is sent for them
  let plannedEntries = [];
  let supersede = new Set(); // keys whose queued `fields` entry the freshly planned one replaces (#1672)
  const issueNumberByKey = new Map(); // Jira key -> board issue number
  const issueNumberById = new Map(); // board issue id -> board issue number
  let pendingWritebacks = readWritebacks(stateDir);
  if (boardClient) {
    try {
      const wb = await applyWritebacks(boardClient, pendingWritebacks, { siteUrl: ctx.credentials.siteUrl, dryRun });
      writebackFailures = wb.failed;
      pendingWritebacks = { keys: wb.keys };
      if (!dryRun && wb.applied.length > 0) writeJsonFile(writebacksPath(stateDir), pendingWritebacks);

      const boardState = await loadBoardState(boardClient, boardProjectId);
      for (const i of boardState.issues) {
        issueNumberById.set(i.id, i.issueNumber);
        if (i.externalKey) issueNumberByKey.set(i.externalKey, i.issueNumber);
      }
      const priorSnapshot = readBoardSnapshot(stateDir);
      baselined = priorSnapshot == null ? boardState.issues.length : 0;
      const planned = planOutbox({
        ...boardState,
        snapshot: priorSnapshot,
        outboxEntries: readOutbox(stateDir).entries,
        pendingWritebackIds: new Set(Object.keys(pendingWritebacks.keys)),
        createEnabled,
        directions,
      });
      enqueued = planned.entries.length;
      plannedEntries = planned.entries;
      supersede = new Set(planned.supersedeKeys);
      if (!dryRun) {
        const kept = readOutbox(stateDir).entries.filter((e) => !(e.kind === "fields" && supersede.has(e.key)));
        writeJsonFile(outboxPath(stateDir), { entries: [...kept, ...planned.entries] });
        writeJsonFile(boardSnapshotPath(stateDir), planned.nextSnapshot);
      }
    } catch (err) {
      return { ok: false, step: "enqueue", reason: err.message };
    }
  }

  const outbox = readOutbox(stateDir);
  // dry-run does not persist the enqueued entries, so report them as if queued.
  const entries = dryRun
    ? [...outbox.entries.filter((e) => !(e.kind === "fields" && supersede.has(e.key))), ...plannedEntries]
    : outbox.entries;
  const pushResult = await runPush(ctx.client, entries, pushOptions);
  const { remaining, writebacks } = pushResult;
  const withNumber = (row) => ({
    ...row,
    localIssueNumber: issueNumberById.get(row.boardIssueId) ?? issueNumberByKey.get(row.key) ?? (row.key == null ? undefined : issueNumberById.get(row.key)),
  });
  const applied = pushResult.applied.map(withNumber);
  const failed = pushResult.failed.map(withNumber);

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

    if (boardClient) {
      try {
        const refreshed = await refreshPullStateAfterPush({
          client: ctx.client,
          boardClient,
          projectId: boardProjectId,
          pullState: readPullState(stateDir),
          applied,
        });
        writeJsonFile(pullStatePath(stateDir), refreshed);
      } catch {
        // best effort: a missed refresh shows up as a reported conflict on the next pull
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
    syncDirection: directions.default,
    baselined,
    ...(baselined > 0 ? { note: `baselined ${baselined} issues, nothing sent` } : {}),
    writebackFailures,
    appliedCount: applied.length,
    failedCount: failed.length,
    applied,
    failed,
  };
}

const result = await main();
printResult(result);
// Not process.exit(): on Windows/Node 24 exiting while undici's sockets are still closing
// aborts with a libuv assertion (0xC0000409) even after a successful run (#1625).
process.exitCode = result.ok ? 0 : 1;
