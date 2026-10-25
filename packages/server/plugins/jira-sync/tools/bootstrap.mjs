#!/usr/bin/env node
// Read-only: validates Jira credentials, site reachability and the local
// profile, without changing anything. Deterministic, never throws — every
// outcome is reported as structured JSON on stdout, with a matching exit code.

import { checkProfile } from "./lib/profile.mjs";
import { buildClientFromEnv, printResult, isSelfTest, checkAuth } from "./lib/cli-client.mjs";
import { parseAssigneeMap } from "./lib/field-map.mjs";
import { defaultJql } from "./lib/pull-plan.mjs";
import { resolveJiraContext } from "./lib/sync-engine.mjs";
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

  const authFailure = await checkAuth(ctx.client);
  if (authFailure) return authFailure;

  try {
    await resolveJiraContext(ctx.client, process.env.SYNC_CONFIG_CUSTOMFIELDMAP ?? "");
  } catch (err) {
    if (err?.code === "BAD_CONFIG") return { ok: false, step: "config", reason: err.message };
  }

  try {
    const page = await ctx.client.searchIssues(jql, { maxResults: 1 });
    // assigneeMap (#1702): every mapped accountId must exist in Jira; the bad rows are reported by name.
    const { map, problems } = parseAssigneeMap(process.env.SYNC_CONFIG_ASSIGNEEMAP);
    const badRows = problems.map((p) => ({ problem: p }));
    for (const [accountId, name] of Object.entries(map)) {
      try {
        await ctx.client.getUser(accountId);
      } catch (err) {
        badRows.push({ accountId, name, problem: err?.status === 404 || err?.status === 400 ? "no such accountId in Jira" : err.message });
      }
    }
    if (badRows.length > 0) {
      return { ok: false, step: "assigneeMap", reason: `${badRows.length} assigneeMap row(s) are not usable`, badRows };
    }
    return {
      ok: true,
      step: "connection",
      assigneeMapRows: Object.keys(map).length,
      selfTest: isSelfTest(),
      siteUrl: ctx.credentials.siteUrl,
      jql,
      issuesVisible: page?.issues?.length ?? 0,
      moreAvailable: page?.isLast === false,
    };
  } catch (err) {
    return { ok: false, step: "connection", reason: err.message, code: err.code ?? null, retryable: err.retryable ?? false };
  }
}

const result = await main();
printResult(result);
// Not process.exit(): on Windows/Node 24 exiting while undici's sockets are still closing
// aborts with a libuv assertion (0xC0000409) even after a successful run (#1625).
process.exitCode = result.ok ? 0 : 1;
