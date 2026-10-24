#!/usr/bin/env node
// The manifest's `sync.pull` command. Fetches what JQL matches, maps each issue
// through the declared field map, and idempotently creates/updates board issues keyed
// by `externalKey` (see sync-engine.mjs). Deletions/moves out of JQL scope are
// REPORTED, never applied. `--dry-run` performs every read (Jira + board) with no
// board writes, and returns the summary that would result.

import { checkProfile } from "../lib/profile.mjs";
import { buildClientFromEnv, printResult, isDryRun, checkAuth } from "../lib/cli-client.mjs";
import { defaultJql } from "../lib/pull-plan.mjs";
import { runInboundSync } from "../lib/sync-engine.mjs";
import {
  readPullState,
  writeJsonFile,
  pullStatePath,
  readConflictRegister,
  conflictRegisterPath,
  readCursor,
  cursorPath,
  readWritebacks,
  writebacksPath,
  readBoardSnapshot,
  boardSnapshotPath,
} from "../lib/state.mjs";
import { updateRegister } from "../lib/conflict-register.mjs";
import { JiraAuthError } from "../lib/auth.mjs";
import { BoardClient, BoardConfigError, resolveBoardConfigFromEnv } from "../lib/board-client.mjs";
import { resolveSyncDirections } from "../lib/sync-direction.mjs";
import { applyWritebacks } from "../lib/writebacks.mjs";
import { snapshotAfterPull } from "../lib/state-sync.mjs";
import { createDefaultBoardFixtureFetch } from "../lib/board-fixtures.mjs";

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

  const authFailure = await checkAuth(ctx.client);
  if (authFailure) return authFailure;

  let jql;
  try {
    jql = defaultJql({ projectKey: ctx.projectKey, jql: ctx.jql });
  } catch (err) {
    return { ok: false, step: "config", reason: err.message };
  }

  const stateDir = process.env.JIRA_SYNC_STATE_DIR;
  if (!stateDir) return { ok: false, step: "config", reason: "JIRA_SYNC_STATE_DIR is not set" };

  let boardConfig;
  try {
    boardConfig = ctx.selfTest
      ? { boardUrl: "https://fixture.board.local", projectId: "fixture-project" }
      : resolveBoardConfigFromEnv();
  } catch (err) {
    if (err instanceof BoardConfigError) return { ok: false, step: "board-config", reason: err.message };
    throw err;
  }
  const boardClient = new BoardClient({
    boardUrl: boardConfig.boardUrl,
    fetchImpl: ctx.selfTest ? createDefaultBoardFixtureFetch() : undefined,
  });

  const dryRun = isDryRun();
  const knownState = readPullState(stateDir);

  // Land any create writebacks first so their Jira keys resolve to the board issue that
  // spawned them; whatever cannot be applied stays pending and blocks an import below.
  let writebacks = readWritebacks(stateDir);
  if (!dryRun) {
    try {
      const wb = await applyWritebacks(boardClient, writebacks, { siteUrl: ctx.credentials.siteUrl });
      writebacks = { keys: wb.keys };
      if (wb.applied.length > 0) writeJsonFile(writebacksPath(stateDir), writebacks);
    } catch (err) {
      return { ok: false, step: "writebacks", reason: err.message };
    }
  }

  let result;
  try {
    result = await runInboundSync(ctx.client, boardClient, {
      jql,
      siteUrl: ctx.credentials.siteUrl,
      projectId: boardConfig.projectId,
      knownState,
      dryRun,
      directions: resolveSyncDirections(process.env),
      pendingWritebackKeys: new Set(Object.values(writebacks.keys)),
      deletedStatusName: process.env.JIRA_SYNC_DELETED_STATUS || undefined,
    });
  } catch (err) {
    return { ok: false, step: "sync", reason: err.message, code: err.code ?? null, retryable: err.retryable ?? false };
  }

  if (!dryRun) {
    writeJsonFile(pullStatePath(stateDir), result.nextState);

    const conflicts = [...result.details, ...result.links.details]
      .filter((d) => d.action === "conflict")
      .map((d) => ({ id: d.key, reason: d.reason, fields: d.fields }));
    const nextRegister = updateRegister(readConflictRegister(stateDir), conflicts);
    writeJsonFile(conflictRegisterPath(stateDir), nextRegister);

    // What pull wrote to the board came FROM Jira: re-baseline those statuses in push's
    // snapshot so the next push does not echo them back as board-originated transitions
    // (incl. a deleted issue moved to Cancelled). The first pull also takes the baseline.
    try {
      const touched = new Set([
        ...result.details.filter((d) => d.action === "create" || d.action === "update").map((d) => d.key),
        ...[...result.outOfScope, ...result.deleted].filter((o) => o.movedTo).map((o) => o.key),
      ]);
      const jiraValues = Object.fromEntries(result.details.filter((d) => d.jiraDiffers).map((d) => [d.key, d.jiraDiffers]));
      writeJsonFile(
        boardSnapshotPath(stateDir),
        await snapshotAfterPull({ boardClient, projectId: boardConfig.projectId, snapshot: readBoardSnapshot(stateDir), touchedKeys: touched, jiraValues, linkAdjust: result.linkSnapshotAdjust }),
      );
    } catch {
      // best effort: worst case push attempts one redundant (failing, reported) transition
    }

    const cursor = readCursor(stateDir);
    writeJsonFile(cursorPath(stateDir), { ...cursor, lastPullAt: new Date().toISOString(), jql });
  }

  const { nextState: _nextState, linkSnapshotAdjust: _linkAdjust, ...summary } = result;
  return { ok: true, step: "pull", syncDirection: resolveSyncDirections(process.env).default, dryRun, applied: !dryRun, ...summary };
}

const result = await main();
printResult(result);
// Not process.exit(): on Windows/Node 24 exiting while undici's sockets are still closing
// aborts with a libuv assertion (0xC0000409) even after a successful run (#1625).
process.exitCode = result.ok ? 0 : 1;
