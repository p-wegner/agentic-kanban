import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAuthHeader, resolveCredentialsFromEnv, JiraAuthError } from "../tools/lib/auth.mjs";

test("buildAuthHeader: email + token produces Basic base64(email:token)", () => {
  const header = buildAuthHeader({ email: "a@b.com", apiToken: "secret-token" });
  assert.equal(header, `Basic ${Buffer.from("a@b.com:secret-token", "utf8").toString("base64")}`);
});

test("buildAuthHeader: token only (PAT) produces Bearer token", () => {
  assert.equal(buildAuthHeader({ apiToken: "pat-123" }), "Bearer pat-123");
});

test("buildAuthHeader: no apiToken throws JiraAuthError", () => {
  assert.throws(() => buildAuthHeader({ email: "a@b.com" }), JiraAuthError);
});

test("resolveCredentialsFromEnv: reads and trims a trailing slash off siteUrl", () => {
  const creds = resolveCredentialsFromEnv({
    JIRA_SITE_URL: "https://team.atlassian.net/",
    JIRA_EMAIL: "a@b.com",
    JIRA_API_TOKEN: "tok",
  });
  assert.deepEqual(creds, { siteUrl: "https://team.atlassian.net", email: "a@b.com", apiToken: "tok" });
});

test("resolveCredentialsFromEnv: email is optional (PAT auth)", () => {
  const creds = resolveCredentialsFromEnv({ JIRA_SITE_URL: "https://team.atlassian.net", JIRA_API_TOKEN: "tok" });
  assert.equal(creds.email, null);
});

test("resolveCredentialsFromEnv: missing JIRA_SITE_URL throws", () => {
  assert.throws(() => resolveCredentialsFromEnv({ JIRA_API_TOKEN: "tok" }), JiraAuthError);
});

test("resolveCredentialsFromEnv: missing JIRA_API_TOKEN throws", () => {
  assert.throws(() => resolveCredentialsFromEnv({ JIRA_SITE_URL: "https://team.atlassian.net" }), JiraAuthError);
});
