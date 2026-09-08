// Shared bootstrap for every CLI entry point: resolve credentials (real or
// fixture), build a JiraClient, and read the project/JQL config the same way
// everywhere. Centralized so `--self-test` behaves identically across
// bootstrap/plan/pull/push instead of drifting per script.

import { resolveCredentialsFromEnv } from "./auth.mjs";
import { JiraClient } from "./jira-client.mjs";
import { createDefaultFixtureFetch } from "./fixtures.mjs";

export function isSelfTest(argv = process.argv) {
  return argv.includes("--self-test") || process.env.JIRA_SYNC_SELF_TEST === "1";
}

export function isDryRun(argv = process.argv) {
  return argv.includes("--dry-run") || process.env.JIRA_SYNC_DRY_RUN === "1";
}

const FIXTURE_CREDENTIALS = {
  siteUrl: "https://fixture.atlassian.net",
  email: "fixture@example.com",
  apiToken: "fixture-token",
};

/** @returns {{ client: import("./jira-client.mjs").JiraClient, credentials: object, projectKey: string, jql: string, selfTest: boolean }} */
export function buildClientFromEnv({ argv = process.argv, env = process.env } = {}) {
  const selfTest = isSelfTest(argv);
  const credentials = selfTest ? FIXTURE_CREDENTIALS : resolveCredentialsFromEnv(env);
  const client = new JiraClient({
    ...credentials,
    fetchImpl: selfTest ? createDefaultFixtureFetch() : undefined,
  });
  const projectKey = env.JIRA_PROJECT_KEY ?? (selfTest ? "ENG" : undefined);
  const jql = env.JIRA_JQL || undefined;
  return { client, credentials, projectKey, jql, selfTest };
}

export function printResult(result) {
  console.log(JSON.stringify(result, null, 2));
}
