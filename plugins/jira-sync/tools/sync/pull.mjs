#!/usr/bin/env node
// The manifest's `sync.pull` command. Deterministic, no judgment calls: fetch
// what JQL matches, diff it against the last-seen state, and (unless
// --dry-run) persist the new state. Nothing here talks to the board's
// database — wiring a pull into board issues is separate, later work (see
// docs/plugin-development.md's `sync` "Known gaps" note, #1076).

import { checkProfile } from "../lib/profile.mjs";
import { buildClientFromEnv, printResult, isDryRun } from "../lib/cli-client.mjs";
import { defaultJql, buildPullPlan, applyPlanToState } from "../lib/pull-plan.mjs";
import { readPullState, writeJsonFile, pullStatePath } from "../lib/state.mjs";
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

  let jql;
  try {
    jql = defaultJql({ projectKey: ctx.projectKey, jql: ctx.jql });
  } catch (err) {
    return { ok: false, step: "config", reason: err.message };
  }

  const stateDir = process.env.JIRA_SYNC_STATE_DIR;
  if (!stateDir) return { ok: false, step: "config", reason: "JIRA_SYNC_STATE_DIR is not set" };

  const dryRun = isDryRun();
  const knownState = readPullState(stateDir);

  let plan;
  try {
    plan = await buildPullPlan(ctx.client, { jql, knownState });
  } catch (err) {
    return { ok: false, step: "search", reason: err.message, code: err.code ?? null, retryable: err.retryable ?? false };
  }

  if (!dryRun) {
    writeJsonFile(pullStatePath(stateDir), applyPlanToState(plan, knownState));
  }

  return { ok: true, step: "pull", dryRun, applied: !dryRun, ...plan };
}

const result = await main();
printResult(result);
process.exit(result.ok ? 0 : 1);
