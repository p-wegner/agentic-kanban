import { test } from "node:test";
import assert from "node:assert/strict";
import { runInboundSync } from "../tools/lib/sync-engine.mjs";

/** A fake Jira client whose `searchAll` yields whatever `issues` currently holds. */
function fakeJiraClient(issues) {
  return {
    async *searchAll() {
      for (const issue of issues) yield issue;
    },
  };
}

/** A fake board — in-memory, deterministic timestamps (a counter, not wall-clock). */
function fakeBoardClient() {
  let clock = 0;
  const nextTimestamp = () => `t${++clock}`;
  const state = {
    statuses: [{ id: "status-todo", name: "Todo", isDefault: true }],
    issues: [],
    tags: [],
    issueTags: new Map(),
  };
  let nextId = 1;

  return {
    state,
    async listStatuses() {
      return state.statuses;
    },
    async listExternallyTrackedIssues() {
      const byKey = new Map();
      for (const issue of state.issues) if (issue.externalKey) byKey.set(issue.externalKey, issue);
      return byKey;
    },
    async createIssue(body) {
      const issue = { id: `issue-${nextId++}`, updatedAt: nextTimestamp(), ...body };
      state.issues.push(issue);
      return issue;
    },
    async updateIssue(id, body) {
      const issue = state.issues.find((i) => i.id === id);
      Object.assign(issue, body, { updatedAt: nextTimestamp() });
      return issue;
    },
    async listTags() {
      return state.tags;
    },
    async createTag(name) {
      const tag = { id: `tag-${state.tags.length + 1}`, name };
      state.tags.push(tag);
      return tag;
    },
    async listIssueTags(issueId) {
      const ids = state.issueTags.get(issueId) ?? new Set();
      return state.tags.filter((t) => ids.has(t.id));
    },
    async attachTag(issueId, tagId) {
      if (!state.issueTags.has(issueId)) state.issueTags.set(issueId, new Set());
      state.issueTags.get(issueId).add(tagId);
    },
  };
}

function jiraIssue(key, { summary, updated, priority = "Medium", labels = [] } = {}) {
  return {
    key,
    fields: {
      summary,
      status: { name: "To Do", statusCategory: { key: "new" } },
      priority: { name: priority },
      labels,
      updated,
    },
  };
}

test("first import: creates a board issue per Jira issue, keyed by externalKey", async () => {
  const jira = [
    jiraIssue("ENG-1", { summary: "Set up CI", updated: "2026-09-01T00:00:00.000Z" }),
    jiraIssue("ENG-2", { summary: "Fix login test", updated: "2026-09-02T00:00:00.000Z" }),
  ];
  const board = fakeBoardClient();

  const result = await runInboundSync(fakeJiraClient(jira), board, {
    jql: "project = ENG",
    projectId: "proj-1",
    knownState: { issues: {} },
  });

  assert.equal(result.created, 2);
  assert.equal(result.updated, 0);
  assert.equal(result.skipped, 0);
  assert.equal(result.conflicted, 0);
  assert.equal(board.state.issues.length, 2);
  assert.deepEqual(board.state.issues.map((i) => i.externalKey).sort(), ["ENG-1", "ENG-2"]);
  assert.equal(result.nextState.issues["ENG-1"].updated, "2026-09-01T00:00:00.000Z");
});

test("idempotent second run: nothing changed in Jira -> everything skipped, no board writes", async () => {
  const jira = [jiraIssue("ENG-1", { summary: "Set up CI", updated: "2026-09-01T00:00:00.000Z" })];
  const board = fakeBoardClient();

  const first = await runInboundSync(fakeJiraClient(jira), board, {
    jql: "project = ENG",
    projectId: "proj-1",
    knownState: { issues: {} },
  });
  const boardIssueId = board.state.issues[0].id;
  const updatedAtAfterFirst = board.state.issues[0].updatedAt;

  const second = await runInboundSync(fakeJiraClient(jira), board, {
    jql: "project = ENG",
    projectId: "proj-1",
    knownState: first.nextState,
  });

  assert.equal(second.created, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.skipped, 1);
  assert.equal(second.conflicted, 0);
  assert.equal(board.state.issues.length, 1);
  assert.equal(board.state.issues[0].id, boardIssueId);
  assert.equal(board.state.issues[0].updatedAt, updatedAtAfterFirst, "unchanged issue must not be rewritten");
});

test("changed field: a later Jira `updated` triggers an update, mapped fields land on the board issue", async () => {
  const board = fakeBoardClient();
  const v1 = [jiraIssue("ENG-1", { summary: "Set up CI", updated: "2026-09-01T00:00:00.000Z", priority: "Low" })];
  const first = await runInboundSync(fakeJiraClient(v1), board, {
    jql: "project = ENG",
    projectId: "proj-1",
    knownState: { issues: {} },
  });

  const v2 = [jiraIssue("ENG-1", { summary: "Set up CI (renamed)", updated: "2026-09-05T00:00:00.000Z", priority: "High" })];
  const second = await runInboundSync(fakeJiraClient(v2), board, {
    jql: "project = ENG",
    projectId: "proj-1",
    knownState: first.nextState,
  });

  assert.equal(second.updated, 1);
  assert.equal(second.skipped, 0);
  assert.equal(second.conflicted, 0);
  assert.equal(board.state.issues[0].title, "Set up CI (renamed)");
  assert.equal(board.state.issues[0].priority, "high");
  assert.equal(second.nextState.issues["ENG-1"].updated, "2026-09-05T00:00:00.000Z");
});

test("conflict: a board issue edited locally since the last sync is reported, not overwritten", async () => {
  const board = fakeBoardClient();
  const v1 = [jiraIssue("ENG-1", { summary: "Set up CI", updated: "2026-09-01T00:00:00.000Z" })];
  const first = await runInboundSync(fakeJiraClient(v1), board, {
    jql: "project = ENG",
    projectId: "proj-1",
    knownState: { issues: {} },
  });

  // Simulate a human editing the board issue directly (not through this plugin) —
  // its updatedAt moves without going through our own write path.
  const boardIssue = board.state.issues[0];
  boardIssue.title = "Locally renamed by a human";
  boardIssue.updatedAt = "human-edit-1";

  // Jira also changed in the meantime.
  const v2 = [jiraIssue("ENG-1", { summary: "Set up CI (from Jira)", updated: "2026-09-05T00:00:00.000Z" })];
  const second = await runInboundSync(fakeJiraClient(v2), board, {
    jql: "project = ENG",
    projectId: "proj-1",
    knownState: first.nextState,
  });

  assert.equal(second.updated, 0);
  assert.equal(second.conflicted, 1);
  assert.equal(second.details[0].action, "conflict");
  assert.equal(board.state.issues[0].title, "Locally renamed by a human", "the local edit must survive");
  // The conflicted issue's state is left untouched so the conflict resurfaces next run too.
  assert.equal(second.nextState.issues["ENG-1"].updated, "2026-09-01T00:00:00.000Z");
});

test("out-of-scope: a previously-synced key no longer returned by the JQL is reported, not deleted", async () => {
  const board = fakeBoardClient();
  const v1 = [
    jiraIssue("ENG-1", { summary: "Stays in scope", updated: "2026-09-01T00:00:00.000Z" }),
    jiraIssue("ENG-2", { summary: "Moves out of scope", updated: "2026-09-01T00:00:00.000Z" }),
  ];
  const first = await runInboundSync(fakeJiraClient(v1), board, {
    jql: "project = ENG",
    projectId: "proj-1",
    knownState: { issues: {} },
  });

  const v2 = [jiraIssue("ENG-1", { summary: "Stays in scope", updated: "2026-09-01T00:00:00.000Z" })];
  const second = await runInboundSync(fakeJiraClient(v2), board, {
    jql: "project = ENG AND ...narrower",
    projectId: "proj-1",
    knownState: first.nextState,
  });

  assert.deepEqual(second.reportedOutOfScope, ["ENG-2"]);
  assert.equal(board.state.issues.length, 2, "an out-of-scope issue must not be deleted from the board");
});

test("labels map to tags, created on demand and attached", async () => {
  const board = fakeBoardClient();
  const jira = [jiraIssue("ENG-1", { summary: "x", updated: "2026-09-01T00:00:00.000Z", labels: ["infra", "ci"] })];

  await runInboundSync(fakeJiraClient(jira), board, {
    jql: "project = ENG",
    projectId: "proj-1",
    knownState: { issues: {} },
  });

  assert.deepEqual(board.state.tags.map((t) => t.name).sort(), ["ci", "infra"]);
  const issueId = board.state.issues[0].id;
  const attached = await board.listIssueTags(issueId);
  assert.deepEqual(attached.map((t) => t.name).sort(), ["ci", "infra"]);
});

test("dry run performs no board writes", async () => {
  const board = fakeBoardClient();
  const jira = [jiraIssue("ENG-1", { summary: "x", updated: "2026-09-01T00:00:00.000Z" })];

  const result = await runInboundSync(fakeJiraClient(jira), board, {
    jql: "project = ENG",
    projectId: "proj-1",
    knownState: { issues: {} },
    dryRun: true,
  });

  assert.equal(result.created, 1);
  assert.equal(board.state.issues.length, 0);
});
