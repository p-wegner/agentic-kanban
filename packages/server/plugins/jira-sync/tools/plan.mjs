#!/usr/bin/env node
// Prints what a pull would import/update, without writing anything. Always a
// dry run — see tools/sync/pull.mjs for the command that actually applies it.
// `--self-test` runs the exact same code path against recorded fixtures.

import { checkProfile } from "./lib/profile.mjs";
import { buildClientFromEnv, printResult } from "./lib/cli-client.mjs";
import { defaultJql, buildPullPlan } from "./lib/pull-plan.mjs";
import { readPullState } from "./lib/state.mjs";
import { JiraAuthError } from "./lib/auth.mjs";

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
  const knownState = stateDir ? readPullState(stateDir) : { issues: {} };

  try {
    const plan = await buildPullPlan(ctx.client, { jql, knownState });
    return { ok: true, step: "plan", dryRun: true, ...plan };
  } catch (err) {
    return { ok: false, step: "search", reason: err.message, code: err.code ?? null, retryable: err.retryable ?? false };
  }
}

const result = await main();
printResult(result);
process.exit(result.ok ? 0 : 1);
