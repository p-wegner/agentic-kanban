import { test } from "node:test";
import assert from "node:assert/strict";
import { JiraClient } from "../tools/lib/jira-client.mjs";
import { createScriptedFetch } from "../tools/lib/fixtures.mjs";

test("backoffDelayMs: honors Retry-After (seconds) when present", () => {
  assert.equal(JiraClient.backoffDelayMs({ attempt: 0, retryAfterHeader: "2", baseMs: 250 }), 2000);
  assert.equal(JiraClient.backoffDelayMs({ attempt: 3, retryAfterHeader: "1", baseMs: 250 }), 1000);
});

test("backoffDelayMs: falls back to exponential backoff with no Retry-After", () => {
  assert.equal(JiraClient.backoffDelayMs({ attempt: 0, retryAfterHeader: null, baseMs: 250 }), 250);
  assert.equal(JiraClient.backoffDelayMs({ attempt: 1, retryAfterHeader: null, baseMs: 250 }), 500);
  assert.equal(JiraClient.backoffDelayMs({ attempt: 2, retryAfterHeader: null, baseMs: 250 }), 1000);
});

test("backoffDelayMs: ignores a non-numeric Retry-After and falls back to exponential", () => {
  assert.equal(JiraClient.backoffDelayMs({ attempt: 1, retryAfterHeader: "not-a-number", baseMs: 250 }), 500);
});

test("request: retries a 429 with the Retry-After delay, then succeeds", async () => {
  const sleeps = [];
  const fetchImpl = createScriptedFetch([
    {
      match: (url) => url.endsWith("/rest/api/3/issue/ENG-1"),
      respond: (_url, _init, callCount) =>
        callCount === 0
          ? { status: 429, body: {}, headers: { "retry-after": "3" } }
          : { status: 200, body: { key: "ENG-1" } },
    },
  ]);
  const client = new JiraClient({
    siteUrl: "https://fixture.atlassian.net",
    apiToken: "x",
    fetchImpl,
    sleepImpl: async (ms) => sleeps.push(ms),
  });
  const issue = await client.getIssue("ENG-1");
  assert.equal(issue.key, "ENG-1");
  assert.deepEqual(sleeps, [3000]);
});

test("request: retries a 5xx with exponential backoff when no Retry-After is sent", async () => {
  const sleeps = [];
  let calls = 0;
  const fetchImpl = createScriptedFetch([
    {
      match: (url) => url.endsWith("/rest/api/3/issue/ENG-1"),
      respond: () => {
        calls += 1;
        return calls <= 2 ? { status: 503, body: {} } : { status: 200, body: { key: "ENG-1" } };
      },
    },
  ]);
  const client = new JiraClient({
    siteUrl: "https://fixture.atlassian.net",
    apiToken: "x",
    fetchImpl,
    retryBaseMs: 100,
    sleepImpl: async (ms) => sleeps.push(ms),
  });
  const issue = await client.getIssue("ENG-1");
  assert.equal(issue.key, "ENG-1");
  assert.deepEqual(sleeps, [100, 200]);
});

test("request: gives up after maxRetries and throws the normalized error", async () => {
  const fetchImpl = createScriptedFetch([
    { match: (url) => url.endsWith("/rest/api/3/issue/ENG-1"), respond: () => ({ status: 429, body: {} }) },
  ]);
  const client = new JiraClient({
    siteUrl: "https://fixture.atlassian.net",
    apiToken: "x",
    fetchImpl,
    maxRetries: 2,
    sleepImpl: async () => {},
  });
  await assert.rejects(() => client.getIssue("ENG-1"), (err) => {
    assert.equal(err.name, "JiraApiError");
    assert.equal(err.status, 429);
    return true;
  });
});

test("request: a non-retryable error (400) throws immediately with no sleep", async () => {
  const sleeps = [];
  const fetchImpl = createScriptedFetch([
    { match: (url) => url.endsWith("/rest/api/3/issue/ENG-1"), respond: () => ({ status: 400, body: {} }) },
  ]);
  const client = new JiraClient({
    siteUrl: "https://fixture.atlassian.net",
    apiToken: "x",
    fetchImpl,
    sleepImpl: async (ms) => sleeps.push(ms),
  });
  await assert.rejects(() => client.getIssue("ENG-1"));
  assert.deepEqual(sleeps, []);
});
