#!/usr/bin/env node
// The manifest's `sync.resolve` command (#1643): settle ONE diverged issue from a context without
// Jira credentials. The board starts this with the credentials injected; the caller passes only
// `SYNC_RESOLVE_KEY` and (to act) `SYNC_RESOLVE_KEEP=board|jira`. Without a KEEP it just shows the
// three-way field table. See ../lib/resolve.mjs for what each side does.

import { buildClientFromEnv, printResult, checkAuth } from "../lib/cli-client.mjs";
import { resolveIssue } from "../lib/resolve.mjs";
import {
  readPullState,
  writeJsonFile,
  pullStatePath,
  readBoardSnapshot,
  boardSnapshotPath,
  readConflictRegister,
  conflictRegisterPath,
} from "../lib/state.mjs";
import { snapshotAfterPull } from "../lib/state-sync.mjs";
import { outstandingEntries, updateRegister } from "../lib/conflict-register.mjs";
import { JiraAuthError } from "../lib/auth.mjs";
import { BoardClient, BoardConfigError, resolveBoardConfigFromEnv } from "../lib/board-client.mjs";
import { createDefaultBoardFixtureFetch } from "../lib/board-fixtures.mjs";

async function main() {
  let ctx;
  try {
    ctx = buildClientFromEnv();
  } catch (err) {
    if (err instanceof JiraAuthError) return { ok: false, step: "credentials", reason: err.message };
    throw err;
  }
  const authFailure = await checkAuth(ctx.client);
  if (authFailure) return authFailure;

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

  const key = process.env.SYNC_RESOLVE_KEY?.trim();
  let keep = process.env.SYNC_RESOLVE_KEEP?.trim() || undefined;
  if (keep?.startsWith("{")) {
    try {
      keep = JSON.parse(keep);
    } catch {
      return { ok: false, step: "resolve", reason: "SYNC_RESOLVE_KEEP is not valid JSON" };
    }
  }
  const ticket = process.env.SYNC_RESOLVE_TICKET?.trim() || undefined;
  const reason = process.env.SYNC_RESOLVE_REASON?.trim() || undefined;
  let result;
  try {
    result = await resolveIssue({
      client: ctx.client,
      boardClient,
      projectId: boardConfig.projectId,
      siteUrl: ctx.credentials.siteUrl,
      key,
      keep,
      ticket,
      reason,
      knownState: readPullState(stateDir),
    });
  } catch (err) {
    return { ok: false, step: "resolve", reason: err.message, code: err.code ?? null, retryable: err.retryable ?? false };
  }
  if (!result.ok) return { ...result, step: "resolve" };

  const { nextState, ...summary } = result;
  if (result.needsHuman) {
    // Nothing was written to either side. The entry stays outstanding, marked, so the loop shows it.
    const register = readConflictRegister(stateDir);
    const entry = register.entries[key];
    if (entry && !entry.resolved) {
      const marked = { ...entry, needsHuman: true, needsHumanReason: result.reason, needsHumanAt: new Date().toISOString(), ...(ticket ? { needsHumanTicket: ticket } : {}) };
      writeJsonFile(conflictRegisterPath(stateDir), { entries: { ...register.entries, [key]: marked } });
    }
  }
  if (nextState) {
    writeJsonFile(pullStatePath(stateDir), nextState);
    // The two sides agree now, so the conflict entry is settled without waiting for the next pull
    // (which would reach the same verdict); the loop converges as soon as it is advanced.
    const register = readConflictRegister(stateDir);
    const stillOutstanding = outstandingEntries(register).filter((e) => e.id !== key);
    writeJsonFile(conflictRegisterPath(stateDir), updateRegister(register, stillOutstanding));
    // Push's snapshot must see the settled fields as already agreed, or the next push echoes them (#1672).
    try {
      const snapshot = readBoardSnapshot(stateDir);
      if (snapshot) {
        writeJsonFile(
          boardSnapshotPath(stateDir),
          await snapshotAfterPull({ boardClient, projectId: boardConfig.projectId, snapshot, touchedKeys: new Set([key]) }),
        );
      }
    } catch {
      // best effort
    }
  }
  return { step: "resolve", ...summary };
}

const result = await main();
printResult(result);
process.exitCode = result.ok ? 0 : 1;
