import { test } from "node:test";
import assert from "node:assert/strict";
import { JiraClient } from "../tools/lib/jira-client.mjs";
import { createScriptedFetch, loadFixture } from "../tools/lib/fixtures.mjs";
import { runPush } from "../tools/lib/push-plan.mjs";

function transitionsRoute() {
  return {
    match: (url, init) => (init?.method ?? "GET") === "GET" && /\/transitions$/.test(url),
    respond: () => ({ status: 200, body: loadFixture("transitions") }),
  };
}

function refusingRoute(label) {
  // Any write route that must never be hit: throws if matched, so an
  // accidental call fails the test instead of silently succeeding.
  return {
    match: (url, init) => (init?.method ?? "GET") === "POST",
    respond: () => {
      throw new Error(`unexpected write during dry-run: ${label}`);
    },
  };
}

test("transition: resolves the target status via the transition graph and applies it", async () => {
  const calls = [];
  const fetchImpl = createScriptedFetch([
    transitionsRoute(),
    {
      match: (url, init) => init?.method === "POST" && /\/transitions$/.test(url),
      respond: (url, init) => {
        calls.push(JSON.parse(init.body));
        return { status: 204 };
      },
    },
  ]);
  const client = new JiraClient({ siteUrl: "https://fixture.atlassian.net", apiToken: "x", fetchImpl });

  const { applied, failed, remaining } = await runPush(client, [{ kind: "transition", key: "ENG-1", targetStatus: "Done" }]);

  assert.deepEqual(failed, []);
  assert.deepEqual(remaining, []);
  assert.deepEqual(applied, [{ key: "ENG-1", kind: "transition", targetStatus: "Done", transitionId: "21" }]);
  assert.deepEqual(calls, [{ transition: { id: "21" } }]);
});

test("transition: an unresolvable target status fails without ever calling transitionIssue", async () => {
  const fetchImpl = createScriptedFetch([transitionsRoute(), refusingRoute("transitionIssue")]);
  const client = new JiraClient({ siteUrl: "https://fixture.atlassian.net", apiToken: "x", fetchImpl });

  const { applied, failed, remaining } = await runPush(client, [{ kind: "transition", key: "ENG-1", targetStatus: "Blocked" }]);

  assert.deepEqual(applied, []);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].key, "ENG-1");
  assert.match(failed[0].reason, /no transition to status "Blocked"/);
  assert.deepEqual(remaining, [{ kind: "transition", key: "ENG-1", targetStatus: "Blocked" }]);
});

test("comment: a comment that originated as a Jira import is never re-posted (echo suppression)", async () => {
  const fetchImpl = createScriptedFetch([refusingRoute("addComment")]);
  const client = new JiraClient({ siteUrl: "https://fixture.atlassian.net", apiToken: "x", fetchImpl });

  const entry = { kind: "comment", key: "ENG-1", comment: { body: "from jira", boardCommentId: "c1", origin: "jira" } };
  const { applied, failed } = await runPush(client, [entry]);

  assert.deepEqual(failed, []);
  assert.deepEqual(applied, [{ key: "ENG-1", kind: "comment", skipped: "echo-suppressed" }]);
});

test("comment: a board-authored comment posts to Jira with an attribution marker", async () => {
  const posted = [];
  const fetchImpl = createScriptedFetch([
    {
      match: (url, init) => init?.method === "POST" && /\/comment$/.test(url),
      respond: (url, init) => {
        posted.push(JSON.parse(init.body));
        return { status: 200, body: loadFixture("comment-response") };
      },
    },
  ]);
  const client = new JiraClient({ siteUrl: "https://fixture.atlassian.net", apiToken: "x", fetchImpl });

  const entry = { kind: "comment", key: "ENG-1", comment: { body: "Fixed in latest build", boardCommentId: "c42" } };
  const { applied, failed } = await runPush(client, [entry]);

  assert.deepEqual(failed, []);
  assert.equal(applied.length, 1);
  const text = posted[0].body.content[0].content[0].text;
  assert.match(text, /^Fixed in latest build/);
  assert.match(text, /Synced from agentic-kanban comment c42/);
});

test("create: a board issue with no external_key is created in Jira and the key is written back", async () => {
  const fetchImpl = createScriptedFetch([
    {
      match: (url, init) => init?.method === "POST" && /\/rest\/api\/3\/issue$/.test(url),
      respond: () => ({ status: 201, body: loadFixture("issue-create-response") }),
    },
  ]);
  const client = new JiraClient({ siteUrl: "https://fixture.atlassian.net", apiToken: "x", fetchImpl });

  const entry = { kind: "create", boardIssueId: "board-issue-1", fields: { summary: "New from board", project: { key: "ENG" } } };
  const { applied, failed, writebacks } = await runPush(client, [entry]);

  assert.deepEqual(failed, []);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].key, "ENG-42");
  assert.deepEqual(writebacks, [{ boardIssueId: "board-issue-1", key: "ENG-42" }]);
});

test("dry-run: refuses every write, across transition/comment/create, and still reports what would happen", async () => {
  const fetchImpl = createScriptedFetch([transitionsRoute(), refusingRoute("any write")]);
  const client = new JiraClient({ siteUrl: "https://fixture.atlassian.net", apiToken: "x", fetchImpl });

  const entries = [
    { kind: "transition", key: "ENG-1", targetStatus: "Done" },
    { kind: "comment", key: "ENG-2", comment: { body: "hello", boardCommentId: "c1" } },
    { kind: "create", boardIssueId: "board-issue-2", fields: { summary: "New" } },
  ];

  const { applied, failed, remaining, writebacks } = await runPush(client, entries, { dryRun: true });

  assert.deepEqual(failed, []);
  assert.deepEqual(remaining, []);
  assert.deepEqual(writebacks, []);
  assert.deepEqual(applied, [
    { key: "ENG-1", kind: "transition", targetStatus: "Done", transitionId: "21", wouldApply: true },
    { key: "ENG-2", kind: "comment", wouldApply: true, preview: "hello\n\n_Synced from agentic-kanban comment c1_" },
    { boardIssueId: "board-issue-2", kind: "create", fields: { summary: "New" }, wouldApply: true },
  ]);
});

test("dry-run: still reports a transition-resolution failure instead of hiding it", async () => {
  const fetchImpl = createScriptedFetch([transitionsRoute(), refusingRoute("transitionIssue")]);
  const client = new JiraClient({ siteUrl: "https://fixture.atlassian.net", apiToken: "x", fetchImpl });

  const { applied, failed } = await runPush(client, [{ kind: "transition", key: "ENG-1", targetStatus: "Blocked" }], { dryRun: true });

  assert.deepEqual(applied, []);
  assert.equal(failed.length, 1);
  assert.match(failed[0].reason, /no transition to status "Blocked"/);
});
