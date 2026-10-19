#!/usr/bin/env node
// The manifest's `sync.pull` command. Fetches what JQL matches, maps each issue
// through the declared field map, and idempotently creates/updates board issues keyed
// by `externalKey` (see sync-engine.mjs). Deletions/moves out of JQL scope are
// REPORTED, never applied. `--dry-run` performs every read (Jira + board) with no
// board writes, and returns the summary that would result.

import { checkProfile } from "../lib/profile.mjs";
import { buildClientFromEnv, printResult, isDryRun } from "../lib/cli-client.mjs";
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
import { applyWritebacks } from "../lib/writebacks.mjs";
import { statusNameOf } from "../lib/outbox-producer.mjs";
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
      pendingWritebackKeys: new Set(Object.values(writebacks.keys)),
      deletedStatusName: process.env.JIRA_SYNC_DELETED_STATUS || undefined,
    });
  } catch (err) {
    return { ok: false, step: "sync", reason: err.message, code: err.code ?? null, retryable: err.retryable ?? false };
  }

  if (!dryRun) {
    writeJsonFile(pullStatePath(stateDir), result.nextState);

    const conflicts = result.details
      .filter((d) => d.action === "conflict")
      .map((d) => ({ id: d.key, reason: d.reason }));
    const nextRegister = updateRegister(readConflictRegister(stateDir), conflicts);
    writeJsonFile(conflictRegisterPath(stateDir), nextRegister);

    // What pull wrote to the board came FROM Jira: re-baseline those statuses in push's
    // snapshot so the next push does not echo them back as board-originated transitions.
    const snapshot = readBoardSnapshot(stateDir);
    if (snapshot) {
      try {
        const statuses = await boardClient.listStatuses(boardConfig.projectId);
        const statusNameById = new Map(statuses.map((s) => [s.id, s.name]));
        const touched = new Set(result.details.filter((d) => d.action === "create" || d.action === "update").map((d) => d.key));
        for (const issue of await boardClient.listIssues(boardConfig.projectId)) {
          if (!touched.has(issue.externalKey)) continue;
          const prev = snapshot.issues[issue.id];
          snapshot.issues[issue.id] = { ...prev, status: statusNameOf(issue, statusNameById) };
        }
        writeJsonFile(boardSnapshotPath(stateDir), snapshot);
      } catch {
        // best effort: worst case push attempts one redundant (failing, reported) transition
      }
    }

    const cursor = readCursor(stateDir);
    writeJsonFile(cursorPath(stateDir), { ...cursor, lastPullAt: new Date().toISOString(), jql });
  }

  const { nextState: _nextState, ...summary } = result;
  return { ok: true, step: "pull", dryRun, applied: !dryRun, ...summary };
}

const result = await main();
printResult(result);
process.exit(result.ok ? 0 : 1);
