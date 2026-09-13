import { test } from "node:test";
import assert from "node:assert/strict";
import { JiraClient } from "../tools/lib/jira-client.mjs";
import { createDefaultFixtureFetch, createScriptedFetch } from "../tools/lib/fixtures.mjs";

function client(fetchImpl) {
  return new JiraClient({ siteUrl: "https://fixture.atlassian.net", apiToken: "x", fetchImpl });
}

test("searchAll: paginates across pages until total is reached", async () => {
  const c = client(createDefaultFixtureFetch());
  const keys = [];
  for await (const issue of c.searchAll("project = ENG", { pageSize: 2 })) keys.push(issue.key);
  assert.deepEqual(keys, ["ENG-1", "ENG-2", "ENG-3"]);
});

test("searchAll: requests startAt=0 first, then startAt advanced by the page size actually returned", async () => {
  const seenStartAt = [];
  const fetchImpl = createScriptedFetch([
    {
      match: (url, init) => init?.method === "POST" && url.includes("/rest/api/3/search"),
      respond: (_url, init) => {
        const body = JSON.parse(init.body);
        seenStartAt.push(body.startAt);
        if (body.startAt === 0) return { status: 200, body: { startAt: 0, total: 2, issues: [{ key: "A-1", fields: {} }] } };
        return { status: 200, body: { startAt: 1, total: 2, issues: [{ key: "A-2", fields: {} }] } };
      },
    },
  ]);
  const keys = [];
  for await (const issue of client(fetchImpl).searchAll("x", { pageSize: 1 })) keys.push(issue.key);
  assert.deepEqual(seenStartAt, [0, 1]);
  assert.deepEqual(keys, ["A-1", "A-2"]);
});

test("searchAll: stops immediately on an empty first page", async () => {
  const fetchImpl = createScriptedFetch([
    {
      match: (url, init) => init?.method === "POST" && url.includes("/rest/api/3/search"),
      respond: () => ({ status: 200, body: { startAt: 0, total: 0, issues: [] } }),
    },
  ]);
  const keys = [];
  for await (const issue of client(fetchImpl).searchAll("x")) keys.push(issue.key);
  assert.deepEqual(keys, []);
});

test("searchIssues: a single page passes jql/startAt/maxResults through as the request body", async () => {
  let capturedBody;
  const fetchImpl = createScriptedFetch([
    {
      match: (url, init) => init?.method === "POST" && url.includes("/rest/api/3/search"),
      respond: (_url, init) => {
        capturedBody = JSON.parse(init.body);
        return { status: 200, body: { startAt: 5, total: 5, issues: [] } };
      },
    },
  ]);
  await client(fetchImpl).searchIssues("project = ENG", { fields: ["summary"], startAt: 5, maxResults: 25 });
  assert.deepEqual(capturedBody, { jql: "project = ENG", fields: ["summary"], startAt: 5, maxResults: 25 });
});
