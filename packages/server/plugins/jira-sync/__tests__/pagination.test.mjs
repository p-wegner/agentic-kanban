import { test } from "node:test";
import assert from "node:assert/strict";
import { JiraClient } from "../tools/lib/jira-client.mjs";
import { createDefaultFixtureFetch, createScriptedFetch } from "../tools/lib/fixtures.mjs";

function client(fetchImpl) {
  return new JiraClient({ siteUrl: "https://fixture.atlassian.net", apiToken: "x", fetchImpl });
}

const SEARCH_JQL = (url, init) => init?.method === "POST" && url.includes("/rest/api/3/search/jql");

test("searchAll: paginates across pages via nextPageToken until isLast", async () => {
  const c = client(createDefaultFixtureFetch());
  const keys = [];
  for await (const issue of c.searchAll("project = ENG", { pageSize: 2 })) keys.push(issue.key);
  assert.deepEqual(keys, ["ENG-1", "ENG-2", "ENG-3"]);
});

test("searchAll: first request carries no token, the next carries the token the previous page returned", async () => {
  const seenTokens = [];
  const fetchImpl = createScriptedFetch([
    {
      match: SEARCH_JQL,
      respond: (_url, init) => {
        const body = JSON.parse(init.body);
        seenTokens.push(body.nextPageToken);
        assert.equal("startAt" in body, false);
        if (!body.nextPageToken) return { status: 200, body: { issues: [{ key: "A-1", fields: {} }], nextPageToken: "t2", isLast: false } };
        if (body.nextPageToken === "t2") return { status: 200, body: { issues: [{ key: "A-2", fields: {} }], nextPageToken: "t3", isLast: false } };
        return { status: 200, body: { issues: [{ key: "A-3", fields: {} }], isLast: true } };
      },
    },
  ]);
  const keys = [];
  for await (const issue of client(fetchImpl).searchAll("x", { pageSize: 1 })) keys.push(issue.key);
  assert.deepEqual(seenTokens, [undefined, "t2", "t3"]);
  assert.deepEqual(keys, ["A-1", "A-2", "A-3"]);
});

test("searchAll: stops immediately on an empty first page", async () => {
  const fetchImpl = createScriptedFetch([
    { match: SEARCH_JQL, respond: () => ({ status: 200, body: { issues: [], isLast: true } }) },
  ]);
  const keys = [];
  for await (const issue of client(fetchImpl).searchAll("x")) keys.push(issue.key);
  assert.deepEqual(keys, []);
});

test("searchIssues: a single page passes jql/fields/maxResults/nextPageToken through as the request body", async () => {
  let capturedBody;
  const fetchImpl = createScriptedFetch([
    {
      match: SEARCH_JQL,
      respond: (_url, init) => {
        capturedBody = JSON.parse(init.body);
        return { status: 200, body: { issues: [], isLast: true } };
      },
    },
  ]);
  await client(fetchImpl).searchIssues("project = ENG", { fields: ["summary"], nextPageToken: "abc", maxResults: 25 });
  assert.deepEqual(capturedBody, { jql: "project = ENG", fields: ["summary"], maxResults: 25, nextPageToken: "abc" });
});

test("Cloud search never calls the removed /rest/api/3/search endpoint", async () => {
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push(new URL(url).pathname);
    return createDefaultFixtureFetch()(url, init);
  };
  const c = client(fetchImpl);
  await c.searchIssues("x");
  for await (const _ of c.searchAll("x", { pageSize: 2 })) { /* drain */ }
  assert.ok(urls.length >= 3);
  for (const path of urls) assert.notEqual(path, "/rest/api/3/search");
  assert.ok(urls.every((p) => p === "/rest/api/3/search/jql"));
});

test("Server/DC deployment keeps /rest/api/2/search with startAt paging", async () => {
  const seen = [];
  const fetchImpl = createScriptedFetch([
    {
      match: (url, init) => init?.method === "POST" && new URL(url).pathname === "/rest/api/2/search",
      respond: (_url, init) => {
        const body = JSON.parse(init.body);
        seen.push(body.startAt);
        return body.startAt === 0
          ? { status: 200, body: { startAt: 0, total: 2, issues: [{ key: "A-1", fields: {} }] } }
          : { status: 200, body: { startAt: 1, total: 2, issues: [{ key: "A-2", fields: {} }] } };
      },
    },
  ]);
  const c = new JiraClient({ siteUrl: "https://jira.example.com", apiToken: "x", fetchImpl, deployment: "server" });
  const keys = [];
  for await (const issue of c.searchAll("x", { pageSize: 1 })) keys.push(issue.key);
  assert.deepEqual(seen, [0, 1]);
  assert.deepEqual(keys, ["A-1", "A-2"]);
});
