#!/usr/bin/env node
// Exercises the whole client end-to-end against recorded fixtures — no
// network, no board. Marked `audience: developer`: an operator running a pull
// should never need to press this, it is here to prove the plugin still works
// after a change. See docs/plugin-development.md "Testing a plugin before it
// touches a board".

import { JiraClient } from "./lib/jira-client.mjs";
import { createDefaultFixtureFetch, createScriptedFetch, loadFixture } from "./lib/fixtures.mjs";
import { buildAuthHeader } from "./lib/auth.mjs";

const checks = [];

function check(name, fn) {
  checks.push({ name, fn });
}

check("auth header: basic (email + token)", () => {
  const header = buildAuthHeader({ email: "a@b.com", apiToken: "tok" });
  if (!header.startsWith("Basic ")) throw new Error(`expected Basic prefix, got ${header}`);
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  if (decoded !== "a@b.com:tok") throw new Error(`decoded auth mismatch: ${decoded}`);
});

check("auth header: bearer (token only, PAT)", () => {
  const header = buildAuthHeader({ apiToken: "tok" });
  if (header !== "Bearer tok") throw new Error(`expected "Bearer tok", got ${header}`);
});

check("search paginates across pages", async () => {
  const client = new JiraClient({ siteUrl: "https://fixture.atlassian.net", apiToken: "x", fetchImpl: createDefaultFixtureFetch() });
  const keys = [];
  for await (const issue of client.searchAll("project = ENG", { pageSize: 2 })) keys.push(issue.key);
  if (keys.length !== 3) throw new Error(`expected 3 issues across pages, got ${keys.length}`);
  if (keys.join(",") !== "ENG-1,ENG-2,ENG-3") throw new Error(`unexpected order: ${keys.join(",")}`);
});

check("getIssue / listTransitions / transitionIssue / addComment", async () => {
  const client = new JiraClient({ siteUrl: "https://fixture.atlassian.net", apiToken: "x", fetchImpl: createDefaultFixtureFetch() });
  const issue = await client.getIssue("ENG-1");
  if (issue.key !== "ENG-1") throw new Error("getIssue returned the wrong issue");
  const transitions = await client.listTransitions("ENG-1");
  if (transitions.length === 0) throw new Error("expected at least one transition");
  await client.transitionIssue("ENG-1", transitions[0].id);
  const comment = await client.addComment("ENG-1", "done via self-test");
  if (!comment?.id) throw new Error("addComment did not return a created comment");
});

check("429 triggers backoff then succeeds", async () => {
  const delays = [];
  const fetchImpl = createScriptedFetch([
    {
      match: (url) => url.endsWith("/rest/api/3/issue/ENG-1"),
      respond: (_url, _init, callCount) =>
        callCount === 0
          ? { status: 429, body: loadFixture("rate-limited"), headers: { "retry-after": "0" } }
          : { status: 200, body: loadFixture("issue-detail") },
    },
  ]);
  const client = new JiraClient({
    siteUrl: "https://fixture.atlassian.net",
    apiToken: "x",
    fetchImpl,
    sleepImpl: async (ms) => {
      delays.push(ms);
    },
  });
  const issue = await client.getIssue("ENG-1");
  if (issue.key !== "ENG-1") throw new Error("expected the retried call to succeed");
  if (delays.length !== 1) throw new Error(`expected exactly one backoff sleep, got ${delays.length}`);
});

check("error normalization: 404 surfaces a stable shape", async () => {
  const fetchImpl = createScriptedFetch([
    {
      match: (url) => url.endsWith("/rest/api/3/issue/MISSING-1"),
      respond: () => ({ status: 404, body: { errorMessages: ["Issue does not exist"], errors: {} } }),
    },
  ]);
  const client = new JiraClient({ siteUrl: "https://fixture.atlassian.net", apiToken: "x", fetchImpl });
  try {
    await client.getIssue("MISSING-1");
    throw new Error("expected getIssue to throw");
  } catch (err) {
    if (err.name !== "JiraApiError") throw new Error(`expected JiraApiError, got ${err.name}`);
    if (err.status !== 404 || err.code !== "not_found") throw new Error(`unexpected normalization: ${JSON.stringify(err)}`);
    if (err.retryable) throw new Error("a 404 must not be marked retryable");
  }
});

check("error normalization: 429/5xx are retryable, 4xx are not", async () => {
  const fetchImpl = createScriptedFetch([
    { match: (url) => url.endsWith("/A"), respond: () => ({ status: 429, body: {} }) },
    { match: (url) => url.endsWith("/B"), respond: () => ({ status: 503, body: {} }) },
    { match: (url) => url.endsWith("/C"), respond: () => ({ status: 400, body: {} }) },
  ]);
  const client = new JiraClient({ siteUrl: "https://fixture.atlassian.net", apiToken: "x", fetchImpl, maxRetries: 0 });
  for (const [path, expectRetryable] of [["/A", true], ["/B", true], ["/C", false]]) {
    try {
      await client.request(path);
      throw new Error(`expected ${path} to throw`);
    } catch (err) {
      if (err.retryable !== expectRetryable) throw new Error(`${path}: expected retryable=${expectRetryable}, got ${err.retryable}`);
    }
  }
});

async function main() {
  const results = [];
  for (const { name, fn } of checks) {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, error: err.message });
    }
  }
  const failed = results.filter((r) => !r.ok);
  return { ok: failed.length === 0, total: results.length, passed: results.length - failed.length, failed: failed.length, results };
}

const result = await main();
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
