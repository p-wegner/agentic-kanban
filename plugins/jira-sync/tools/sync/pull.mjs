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
import { readPullState, writeJsonFile, pullStatePath } from "../lib/state.mjs";
import { JiraAuthError } from "../lib/auth.mjs";
import { BoardClient, BoardConfigError, resolveBoardConfigFromEnv } from "../lib/board-client.mjs";
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

  let result;
  try {
    result = await runInboundSync(ctx.client, boardClient, {
      jql,
      siteUrl: ctx.credentials.siteUrl,
      projectId: boardConfig.projectId,
      knownState,
      dryRun,
    });
  } catch (err) {
    return { ok: false, step: "sync", reason: err.message, code: err.code ?? null, retryable: err.retryable ?? false };
  }

  if (!dryRun) {
    writeJsonFile(pullStatePath(stateDir), result.nextState);
  }

  const { nextState: _nextState, ...summary } = result;
  return { ok: true, step: "pull", dryRun, applied: !dryRun, ...summary };
}

const result = await main();
printResult(result);
process.exit(result.ok ? 0 : 1);
