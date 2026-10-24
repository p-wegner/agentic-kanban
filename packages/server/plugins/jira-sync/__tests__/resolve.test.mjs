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
  const result = await resolveIssue({ client: writableJira(jira), boardClient: board, projectId: "p", key: "ENG-1", keep: "jira", reason: "r", knownState: state });
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
  const result = await resolveIssue({ client: jc, boardClient: board, projectId: "p", key: "ENG-1", keep: "board", reason: "r", knownState: state });
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

// ---- #1697: evidence, per-field keep, needs-human, audit comments, brief placeholders ----

/** Both fields changed on both sides, like KD-56 in round 7. */
async function bothFieldsFixture() {
  const board = fakeBoardClient();
  const jira = [jiraIssue("ENG-1", { summary: "Set up CI", updated: "2026-09-01T00:00:00.000Z", priority: "Medium" })];
  const first = await runInboundSync(fakeJiraClient(jira), board, { jql: "project = ENG", projectId: "p", knownState: { issues: {} } });
  Object.assign(board.state.issues[0], { title: "Board title", priority: "high", updatedAt: "2026-09-04T00:00:00.000Z" });
  jira[0].fields.summary = "Jira title";
  jira[0].fields.priority = { name: "Low" };
  jira[0].fields.updated = "2026-09-05T00:00:00.000Z";
  jira[0].changelog = {
    histories: [
      { created: "2026-09-02T00:00:00.000Z", author: { displayName: "Early Eve" }, items: [{ field: "summary" }] },
      { created: "2026-09-05T00:00:00.000Z", author: { displayName: "Jo Jira" }, items: [{ field: "summary" }, { field: "priority" }] },
    ],
  };
  return { board, jira, state: first.nextState };
}

/** Jira fake applying summary/priority writes and recording comments. */
function jiraWithComments(issues) {
  const client = fakeJiraClient(issues);
  client.writes = [];
  client.comments = [];
  client.getIssue = async (key) => issues.find((i) => i.key === key);
  client.updateIssueFields = async (key, fields) => {
    client.writes.push({ key, fields });
    const issue = issues.find((i) => i.key === key);
    if (fields.summary != null) issue.fields.summary = fields.summary;
    if (fields.priority) issue.fields.priority = fields.priority;
    issue.fields.updated = "2026-09-09T00:00:00.000Z";
  };
  client.addComment = async (key, body) => {
    client.comments.push({ key, body });
    issues.find((i) => i.key === key).fields.updated = "2026-09-09T00:00:01.000Z";
  };
  return client;
}

test("resolve show: per differing field, when and by whom each side last changed it", async () => {
  const { board, jira, state } = await bothFieldsFixture();
  const result = await resolveIssue({ client: jiraWithComments(jira), boardClient: board, projectId: "p", key: "ENG-1", knownState: state });
  const title = result.fields.find((f) => f.field === "title");
  assert.equal(title.evidence.jira.by, "Jo Jira");
  assert.equal(title.evidence.jira.at, "2026-09-05T00:00:00.000Z", "the newest changelog entry for the field wins");
  assert.equal(title.evidence.board.at, "2026-09-04T00:00:00.000Z");
  assert.equal(result.fields.find((f) => f.field === "type").evidence, undefined, "equal rows carry no evidence");
});

test("per-field keep writes only the chosen fields each way; next pull is quiet", async () => {
  const { board, jira, state } = await bothFieldsFixture();
  const jc = jiraWithComments(jira);
  const result = await resolveIssue({ client: jc, boardClient: board, projectId: "p", key: "ENG-1", keep: { title: "board", priority: "jira" }, ticket: 7, reason: "r", knownState: state });
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(jc.writes.map((w) => Object.keys(w.fields)), [["summary"]], "only the title goes to Jira");
  assert.equal(jira[0].fields.summary, "Board title");
  assert.equal(board.state.issues[0].title, "Board title");
  assert.equal(board.state.issues[0].priority, "low", "priority came from Jira");
  assert.equal(jira[0].fields.priority.name, "Low");

  const next = await runInboundSync(fakeJiraClient(jira), board, { jql: "project = ENG", projectId: "p", knownState: result.nextState });
  assert.equal(next.conflicted, 0);
  assert.equal(next.updated, 0);
});

test("keep posts the audit comment on the losing side with the previous values and the ticket", async () => {
  const { board, jira, state } = await bothFieldsFixture();
  const jc = jiraWithComments(jira);
  const result = await resolveIssue({ client: jc, boardClient: board, projectId: "p", key: "ENG-1", keep: "board", ticket: 7, reason: "r", knownState: state });
  assert.equal(result.auditComment.jira.posted, true);
  assert.equal(jc.comments.length, 1);
  assert.match(jc.comments[0].body, /ticket #7/);
  assert.match(jc.comments[0].body, /title: was "Jira title", now "Board title"/);
  assert.match(jc.comments[0].body, /priority: was "low"/);
  assert.equal(board.state.comments.length, 0, "the winning side gets no comment");
  assert.equal(result.artifact.path, "docs/jira-sync/conflicts/ENG-1.md");
  assert.match(result.artifact.content, /Jo Jira/);

  const second = await bothFieldsFixture();
  await resolveIssue({ client: jiraWithComments(second.jira), boardClient: second.board, projectId: "p", key: "ENG-1", keep: "jira", ticket: "#8", reason: "r", knownState: second.state });
  const note = second.board.state.comments[0];
  assert.match(note.body, /ticket #8/);
  assert.match(note.body, /title: was "Board title", now "Jira title"/);
  assert.equal(note.payload.origin, "jira", "push must not echo the audit note to Jira");
});

test("needs-human writes nothing, and the loop reports the unit as needs-human", async () => {
  const { board, jira, state } = await bothFieldsFixture();
  const jc = jiraWithComments(jira);
  const result = await resolveIssue({ client: jc, boardClient: board, projectId: "p", key: "ENG-1", keep: "needs-human", reason: "no ordering signal", ticket: 7, knownState: state });
  assert.equal(result.ok, true);
  assert.equal(result.needsHuman, true);
  assert.equal(result.nextState, undefined);
  assert.deepEqual(jc.writes, []);
  assert.deepEqual(jc.comments, []);
  assert.equal(board.state.comments.length, 0);
  assert.equal(board.state.issues[0].title, "Board title");
  assert.match(result.artifact.content, /Needs a human/);

  const register = updateRegister({ entries: {} }, [{ id: "ENG-1", reason: "diverged" }]);
  register.entries["ENG-1"].needsHuman = true;
  register.entries["ENG-1"].needsHumanReason = "no ordering signal";
  const plan = buildLoopPlan({ cursor: { lastPullAt: "x" }, conflictRegister: register, failureRegister: { entries: {} } });
  assert.deepEqual(plan.units, [], "a needs-human unit gets no agent ticket (#1709)");
  assert.equal(plan.converged, false);
  assert.match(plan.note, /1 needs-human/);
  assert.match(plan.note, /ENG-1/);
});

test("resolve rejects an unknown field or side in a per-field keep", async () => {
  const { board, jira, state } = await bothFieldsFixture();
  for (const keep of [{ labels: "board" }, { title: "both" }, {}]) {
    const r = await resolveIssue({ client: jiraWithComments(jira), boardClient: board, projectId: "p", key: "ENG-1", keep, knownState: state });
    assert.equal(r.ok, false);
  }
});

test("the brief carries the real endpoint and project id, no <...> placeholder", async () => {
  const register = updateRegister({ entries: {} }, [{ id: "ENG-1", reason: "diverged" }]);
  const plan = buildLoopPlan({
    cursor: { lastPullAt: "x" },
    conflictRegister: register,
    failureRegister: { entries: {} },
    board: { boardUrl: "http://board.example:3001/", projectId: "proj-123" },
  });
  const brief = plan.units[0].description;
  assert.match(brief, /POST http:\/\/board\.example:3001\/api\/plugins\/jira-sync\/sync\/resolve/);
  assert.match(brief, /"projectId":"proj-123"/);
  assert.match(brief, /needs-human/);
  assert.match(brief, /docs\/jira-sync\/conflicts\/ENG-1\.md/);
  assert.doesNotMatch(brief, /<jira-sync plugin id>|<this project>/);
});

const JIRA_OWNS = { fields: { title: "jira-to-board", description: "jira-to-board", priority: "jira-to-board", type: "jira-to-board", labels: "jira-to-board" } };

test("show returns the owner per field (#1709)", async () => {
  const { board, jira, state } = await bothFieldsFixture();
  const result = await resolveIssue({ client: jiraWithComments(jira), boardClient: board, projectId: "p", key: "ENG-1", knownState: state, directions: JIRA_OWNS });
  assert.equal(result.fields.find((f) => f.field === "title").owner, "jira");
  assert.equal(result.fields.find((f) => f.field === "status").owner, null);
});

test("keep board on a jira-to-board field is refused without override, applied with override and reason", async () => {
  const refused = await bothFieldsFixture();
  const rjc = jiraWithComments(refused.jira);
  const no = await resolveIssue({ client: rjc, boardClient: refused.board, projectId: "p", key: "ENG-1", keep: "board", reason: "r", knownState: refused.state, directions: JIRA_OWNS });
  assert.equal(no.ok, false);
  assert.match(no.reason, /title is owned by jira/);
  assert.match(no.reason, /override/);
  assert.deepEqual(rjc.writes, []);

  const { board, jira, state } = await bothFieldsFixture();
  const jc = jiraWithComments(jira);
  const yes = await resolveIssue({ client: jc, boardClient: board, projectId: "p", key: "ENG-1", keep: "board", reason: "Jira was edited by mistake", override: true, ticket: 7, knownState: state, directions: JIRA_OWNS });
  assert.equal(yes.ok, true);
  assert.match(yes.artifact.content, /Reason: Jira was edited by mistake/);
  assert.match(yes.artifact.content, /override/);
  assert.match(jc.comments[0].body, /Reason: Jira was edited by mistake/);
});

test("keep without a reason is refused", async () => {
  const { board, jira, state } = await bothFieldsFixture();
  const r = await resolveIssue({ client: jiraWithComments(jira), boardClient: board, projectId: "p", key: "ENG-1", keep: "jira", knownState: state });
  assert.equal(r.ok, false);
  assert.match(r.reason, /"reason" is required/);
});

test("a per-field audit names which fields came from which side, and carries the reason", async () => {
  const { board, jira, state } = await bothFieldsFixture();
  const jc = jiraWithComments(jira);
  await resolveIssue({ client: jc, boardClient: board, projectId: "p", key: "ENG-1", keep: { title: "jira", priority: "board" }, reason: "priority was triaged on the board", ticket: 7, knownState: state });
  assert.match(jc.comments[0].body, /kept from the board: priority \/ kept from Jira: title/);
  assert.match(jc.comments[0].body, /Reason: priority was triaged on the board/);
  assert.match(board.state.comments[0].body, /kept from the board: priority \/ kept from Jira: title/);
});

test("the brief names the owner, the ticket number token and has no <...> placeholder", () => {
  const register = updateRegister({ entries: {} }, [{ id: "ENG-1", reason: "diverged", fields: [{ field: "title", board: "a", lastSync: "b", jira: "c", differs: true, owner: "jira" }] }]);
  const plan = buildLoopPlan({
    cursor: { lastPullAt: "x" },
    conflictRegister: register,
    failureRegister: { entries: {} },
    board: { boardUrl: "http://localhost:3001", projectId: "proj-123" },
  });
  const brief = plan.units[0].description;
  assert.match(brief, /Jira owns title here: the default is keep jira/);
  assert.match(brief, /"ticket": \{\{issueNumber\}\}/);
  assert.match(brief, /\.mcp-kanban\.json/);
  assert.doesNotMatch(brief, /<[^>\n]*number[^>\n]*>/);
});
