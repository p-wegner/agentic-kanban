import { test } from "node:test";
import assert from "node:assert/strict";
import { runInboundSync } from "../tools/lib/sync-engine.mjs";
import { resolveIssue } from "../tools/lib/resolve.mjs";
import { updateRegister, outstandingEntries } from "../tools/lib/conflict-register.mjs";
import { buildLoopPlan } from "../tools/lib/loop-plan.mjs";

/** A fake Jira client whose `searchAll` yields whatever `issues` currently holds. */
function fakeJiraClient(issues, { deleted = [] } = {}) {
  return {
    async getIssue(key) {
      if (deleted.includes(key)) throw Object.assign(new Error("Issue does not exist"), { status: 404 });
      return { key };
    },
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
    statuses: [
      { id: "status-todo", name: "Todo", isDefault: true },
      { id: "status-cancelled", name: "Cancelled" },
    ],
    issues: [],
    tags: [],
    issueTags: new Map(),
    comments: [],
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
    async listComments(issueId) {
      return state.comments.filter((c) => c.issueId === issueId);
    },
    async addComment(issueId, body) {
      const comment = { id: `comment-${state.comments.length + 1}`, issueId, ...body };
      state.comments.push(comment);
      return comment;
    },
    async attachTag(issueId, tagId) {
      if (!state.issueTags.has(issueId)) state.issueTags.set(issueId, new Set());
      state.issueTags.get(issueId).add(tagId);
    },
  };
}

function jiraIssue(key, { summary, updated, priority = "Medium", labels = [], extra = {} } = {}) {
  return {
    key,
    fields: {
      ...extra,
      summary,
      status: { name: "To Do", statusCategory: { key: "new" } },
      priority: { name: priority },
      labels,
      updated,
    },
  };
}


/** Jira fake that also records field writes and re-serves the edited summary with a bumped `updated`. */
function writableJira(issues) {
  const client = fakeJiraClient(issues);
  client.writes = [];
  client.getIssue = async (key) => issues.find((i) => i.key === key);
  client.updateIssueFields = async (key, fields) => {
    client.writes.push({ key, fields });
    const issue = issues.find((i) => i.key === key);
    issue.fields.summary = fields.summary;
    issue.fields.updated = "2026-09-09T00:00:00.000Z";
  };
  return client;
}

async function conflictedFixture() {
  const board = fakeBoardClient();
  const jira = [jiraIssue("ENG-1", { summary: "Set up CI", updated: "2026-09-01T00:00:00.000Z" })];
  const first = await runInboundSync(fakeJiraClient(jira), board, { jql: "project = ENG", projectId: "p", knownState: { issues: {} } });
  board.state.issues[0].title = "Board title";
  board.state.issues[0].updatedAt = "human-edit";
  jira[0].fields.summary = "Jira title";
  jira[0].fields.updated = "2026-09-05T00:00:00.000Z";
  const pull = await runInboundSync(fakeJiraClient(jira), board, { jql: "project = ENG", projectId: "p", knownState: first.nextState });
  return { board, jira, state: first.nextState, pull };
}

test("a conflict records the three-way field table and the brief renders it", async () => {
  const { pull } = await conflictedFixture();
  const detail = pull.details[0];
  const title = detail.fields.find((f) => f.field === "title");
  assert.deepEqual([title.board, title.lastSync, title.jira], ["Board title", "Set up CI", "Jira title"]);

  const register = updateRegister({ entries: {} }, [{ id: detail.key, reason: detail.reason, fields: detail.fields }]);
  const plan = buildLoopPlan({ cursor: { lastPullAt: "x" }, conflictRegister: register, failureRegister: { entries: {} } });
  const brief = plan.units[0].description;
  assert.match(brief, /\| Field \| Board now \| Last sync \| Jira now \|/);
  assert.match(brief, /Board title \| Set up CI \| Jira title/);
  assert.match(brief, /sync\/resolve/);
  assert.doesNotMatch(brief, /closing it is what marks/i);
});

test("resolve show: reads board / last sync / Jira without writing anything", async () => {
  const { board, jira, state } = await conflictedFixture();
  const jc = writableJira(jira);
  const result = await resolveIssue({ client: jc, boardClient: board, projectId: "p", key: "ENG-1", knownState: state });
  assert.equal(result.mode, "show");
  assert.equal(result.fields.find((f) => f.field === "title").jira, "Jira title");
  assert.deepEqual(jc.writes, []);
  assert.equal(board.state.issues[0].title, "Board title");
});

test("resolve --keep jira: the board is overwritten, the next pull has no conflict, the register entry resolves", async () => {
  const { board, jira, state, pull } = await conflictedFixture();
  const result = await resolveIssue({ client: writableJira(jira), boardClient: board, projectId: "p", key: "ENG-1", keep: "jira", knownState: state });
  assert.equal(result.ok, true);
  assert.equal(board.state.issues[0].title, "Jira title");

  const next = await runInboundSync(fakeJiraClient(jira), board, { jql: "project = ENG", projectId: "p", knownState: result.nextState });
  assert.equal(next.conflicted, 0);
  const open = updateRegister({ entries: {} }, [{ id: "ENG-1" }]);
  const after = updateRegister(open, next.details.filter((d) => d.action === "conflict").map((d) => ({ id: d.key })));
  assert.equal(outstandingEntries(after).length, 0);
  assert.equal(pull.conflicted, 1);
});

test("resolve --keep board: Jira gets the board's fields once, and the next pull reports no conflict", async () => {
  const { board, jira, state } = await conflictedFixture();
  const jc = writableJira(jira);
  const result = await resolveIssue({ client: jc, boardClient: board, projectId: "p", key: "ENG-1", keep: "board", knownState: state });
  assert.equal(result.ok, true);
  assert.equal(jc.writes.length, 1);
  assert.equal(jc.writes[0].fields.summary, "Board title");
  assert.equal(board.state.issues[0].title, "Board title", "the board edit is kept");

  const next = await runInboundSync(fakeJiraClient(jira), board, { jql: "project = ENG", projectId: "p", knownState: result.nextState });
  assert.equal(next.conflicted, 0);
  assert.equal(next.updated, 0);
});

test("resolve refuses an unknown side and an unlinked key", async () => {
  const { board, jira, state } = await conflictedFixture();
  const bad = await resolveIssue({ client: writableJira(jira), boardClient: board, projectId: "p", key: "ENG-1", keep: "both", knownState: state });
  assert.equal(bad.ok, false);
  const none = await resolveIssue({ client: writableJira(jira), boardClient: board, projectId: "p", key: "ENG-99", knownState: state });
  assert.equal(none.ok, false);
});
