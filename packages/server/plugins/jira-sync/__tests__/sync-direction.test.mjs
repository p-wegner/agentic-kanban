import { test } from "node:test";
import assert from "node:assert/strict";
import { planOutbox } from "../tools/lib/outbox-producer.mjs";
import { runPush } from "../tools/lib/push-plan.mjs";
import { runInboundSync } from "../tools/lib/sync-engine.mjs";
import { resolveSyncDirections } from "../tools/lib/sync-direction.mjs";
import { snapshotAfterPull } from "../tools/lib/state-sync.mjs";

const names = new Map([["s-todo", "Todo"]]);
const issue = (over = {}) => ({ id: "i1", title: "T", description: "D", priority: "medium", issueType: "task", tags: [], externalKey: "KD-1", statusId: "s-todo", ...over });
const plan = (over) => planOutbox({ statusNameById: names, commentsByIssueId: {}, snapshot: null, issues: [], ...over });
const both = resolveSyncDirections({ SYNC_CONFIG_SYNCDIRECTION: "both" });

test("resolveSyncDirections: unset = jira-to-board; overrides and toggles parse", () => {
  const d = resolveSyncDirections({});
  assert.equal(d.default, "jira-to-board");
  assert.ok(Object.values(d.fields).every((v) => v === "jira-to-board"));
  assert.ok(d.pushStatus && d.pushComments);
  const o = resolveSyncDirections({
    SYNC_CONFIG_SYNCDIRECTION: "both",
    SYNC_CONFIG_FIELDDIRECTIONS: '{"description":"jira-to-board"}',
    SYNC_CONFIG_PUSHCOMMENTS: "false",
  });
  assert.equal(o.fields.title, "both");
  assert.equal(o.fields.description, "jira-to-board");
  assert.equal(o.pushComments, false);
});

test("both: a board title edit makes one coalesced fields entry; a queued one is replaced", () => {
  const base = plan({ issues: [issue()], directions: both }).nextSnapshot;
  const edited = plan({ issues: [issue({ title: "New" })], snapshot: base, directions: both });
  assert.deepEqual(edited.entries, [{ kind: "fields", key: "KD-1", boardIssueId: "i1", fields: { title: "New" } }]);
  assert.deepEqual(edited.supersedeKeys, ["KD-1"]);
  const again = plan({ issues: [issue({ title: "New", description: "D2" })], snapshot: edited.nextSnapshot, outboxEntries: edited.entries, directions: both });
  assert.equal(again.entries.length, 1);
  assert.deepEqual(again.entries[0].fields, { title: "New", description: "D2" });
  assert.equal(plan({ issues: [issue({ title: "New" })], snapshot: edited.nextSnapshot, directions: both }).entries.length, 0);
});

test("jira-to-board and unset: the same edit produces no entry", () => {
  for (const directions of [undefined, resolveSyncDirections({})]) {
    const base = plan({ issues: [issue()], directions }).nextSnapshot;
    assert.deepEqual(plan({ issues: [issue({ title: "New" })], snapshot: base, directions }).entries, []);
  }
});

test("per-field override pushes title but not description", () => {
  const directions = resolveSyncDirections({ SYNC_CONFIG_SYNCDIRECTION: "both", SYNC_CONFIG_FIELDDIRECTIONS: '{"description":"jira-to-board"}' });
  const base = plan({ issues: [issue()], directions }).nextSnapshot;
  const r = plan({ issues: [issue({ title: "N", description: "changed" })], snapshot: base, directions });
  assert.deepEqual(r.entries[0].fields, { title: "N" });
});

test("push toggles suppress status and comment entries", () => {
  const directions = resolveSyncDirections({ SYNC_CONFIG_PUSHSTATUS: "false" });
  const sn = plan({ issues: [issue()], directions }).nextSnapshot;
  const r = plan({ issues: [issue({ statusId: "s-x" })], statusNameById: new Map([["s-x", "Done"]]), snapshot: sn, directions });
  assert.deepEqual(r.entries, []);
});

function fakeJira({ reject } = {}) {
  const calls = [];
  return {
    calls,
    async updateIssueFields(key, fields) {
      calls.push({ key, fields });
      const bad = reject ? Object.keys(fields).filter((f) => reject.includes(f)) : [];
      if (bad.length) throw Object.assign(new Error("400"), { status: 400, body: { errors: Object.fromEntries(bad.map((f) => [f, "not on the screen"])) } });
    },
  };
}
const entry = { kind: "fields", key: "KD-1", boardIssueId: "i1", fields: { title: "N", description: "**x**", priority: "high", type: "bug", labels: ["a"] } };

test("push applies a fields entry via updateIssueFields (ADF description, priority name, issue type)", async () => {
  const client = fakeJira();
  const r = await runPush(client, [entry]);
  assert.equal(r.failed.length, 0);
  assert.deepEqual(r.remaining, []);
  const f = client.calls[0].fields;
  assert.equal(f.summary, "N");
  assert.equal(f.description.type, "doc");
  assert.deepEqual(f.priority, { name: "High" });
  assert.deepEqual(f.issuetype, { name: "Bug" });
  assert.deepEqual(f.labels, ["a"]);
});

test("dry run plans the field write without sending it", async () => {
  const client = fakeJira();
  const r = await runPush(client, [entry], { dryRun: true });
  assert.equal(client.calls.length, 0);
  assert.equal(r.applied[0].wouldApply, true);
  assert.equal(r.applied[0].kind, "fields");
});

test("a field Jira's screen rejects becomes a failed entry naming it; the rest is written", async () => {
  const client = fakeJira({ reject: ["issuetype"] });
  const r = await runPush(client, [entry]);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].reason, /type/);
  assert.equal(r.failed[0].key, "KD-1");
  assert.deepEqual(r.remaining, []);
  assert.equal(client.calls.length, 2);
  assert.ok(!("issuetype" in client.calls[1].fields));
  assert.ok(r.applied[0].fields.includes("title"));
});

function fakeJiraRead(issues) {
  return { async getIssue(key) { return { key }; }, async *searchAll() { for (const i of issues) yield i; } };
}
function fakeBoard(issue) {
  const st = { issue };
  return {
    st,
    async listStatuses() { return [{ id: "s-todo", name: "Todo", isDefault: true }]; },
    async listExternallyTrackedIssues() { return new Map([[st.issue.externalKey, st.issue]]); },
    async updateIssue(id, body) { Object.assign(st.issue, body, { updatedAt: `u${Math.random()}` }); return st.issue; },
    async listTags() { return []; },
    async listIssueTags() { return []; },
    async listComments() { return []; },
    async attachTag() {},
    async createTag(n) { return { id: n, name: n }; },
  };
}
const jiraIssue = (summary, updated) => ({
  key: "KD-1",
  fields: { summary, description: null, status: { statusCategory: { key: "new" } }, priority: { name: "Medium" }, labels: [], updated, issuetype: { name: "Task" } },
});

test("pull: a board-to-jira field is not overwritten and a board edit to it is no conflict", async () => {
  const directions = resolveSyncDirections({ SYNC_CONFIG_SYNCDIRECTION: "board-to-jira" });
  const board = fakeBoard({ id: "i1", externalKey: "KD-1", title: "S", description: "", priority: "medium", issueType: "task", statusId: "s-todo", updatedAt: "u0" });
  const first = await runInboundSync(fakeJiraRead([jiraIssue("S", "j1")]), board, { jql: "x", projectId: "p", knownState: { issues: {} }, directions });
  assert.equal(first.created, 0);
  board.st.issue.title = "Board rename";
  board.st.issue.updatedAt = "u-edit";
  const second = await runInboundSync(fakeJiraRead([jiraIssue("S", "j2")]), board, { jql: "x", projectId: "p", knownState: { issues: { "KD-1": { updated: "j1", boardIssueId: "i1", boardUpdatedAt: "u0", fields: { title: "S", description: "", priority: "medium", type: "task", statusId: "s-todo" } } } }, directions });
  assert.equal(second.conflicted, 0);
  assert.equal(board.st.issue.title, "Board rename");
});

test("both: edits on both sides of the same field are still a conflict, with Jira's value shown", async () => {
  const board = fakeBoard({ id: "i1", externalKey: "KD-1", title: "Board rename", description: "", priority: "medium", issueType: "task", statusId: "s-todo", updatedAt: "u-edit" });
  const known = { "KD-1": { updated: "j1", boardIssueId: "i1", boardUpdatedAt: "u0", fields: { title: "S", description: "", priority: "medium", type: "task", statusId: "s-todo" } } };
  const r = await runInboundSync(fakeJiraRead([jiraIssue("Jira rename", "j2")]), board, { jql: "x", projectId: "p", knownState: { issues: known }, directions: both });
  assert.equal(r.conflicted, 1);
  assert.equal(r.details[0].fields.find((f) => f.field === "title").jira, "Jira rename");
});

test("no echo: after a pull writes a field, the push snapshot already holds it", async () => {
  const board = fakeBoard(issue({ title: "From Jira" }));
  board.listIssues = async () => [board.st.issue];
  const sn = { issues: { i1: { status: "Todo", fields: { title: "Old", description: "D", priority: "medium", type: "task", labels: [] } } }, commentsSeen: [] };
  const next = await snapshotAfterPull({ boardClient: board, projectId: "p", snapshot: sn, touchedKeys: new Set(["KD-1"]) });
  assert.equal(next.issues.i1.fields.title, "From Jira");
});

// ---- #1696 ----
const lastSync = { title: "S", description: "", priority: "medium", type: "task", statusId: "s-todo" };
const stateFor = (over = {}) => ({ issues: { "KD-1": { updated: "j1", boardIssueId: "i1", boardUpdatedAt: "u0", fields: lastSync, ...over } } });

test("board-to-jira: a Jira edit is not recorded as agreed; push restores Jira to the board value", async () => {
  const directions = resolveSyncDirections({ SYNC_CONFIG_SYNCDIRECTION: "board-to-jira" });
  const board = fakeBoard({ id: "i1", externalKey: "KD-1", title: "S", description: "", priority: "medium", issueType: "task", statusId: "s-todo", updatedAt: "u0" });
  const r = await runInboundSync(fakeJiraRead([jiraIssue("Jira edit", "j2")]), board, { jql: "x", projectId: "p", knownState: stateFor(), directions });
  assert.equal(board.st.issue.title, "S");
  assert.equal(r.updated, 0, "no board write, no update count");
  assert.equal(r.nextState.issues["KD-1"].fields.title, "Jira edit", "lastSync holds what Jira holds");
  assert.deepEqual(r.details[0].jiraDiffers, { title: "Jira edit" });
  // pull.mjs hands jiraDiffers to the push snapshot: the board title then reads as a change.
  const base = plan({ issues: [issue({ title: "S" })], directions }).nextSnapshot;
  base.issues.i1.fields = { ...base.issues.i1.fields, ...r.details[0].jiraDiffers };
  const pushed = plan({ issues: [issue({ title: "S" })], snapshot: base, directions });
  assert.deepEqual(pushed.entries[0].fields, { title: "S" });
});

test("jira-to-board: a board edit to a Jira-owned field is a conflict with or without a Jira change", async () => {
  for (const jiraUpdated of ["j1", "j2"]) {
    const board = fakeBoard({ id: "i1", externalKey: "KD-1", title: "Board edit", description: "", priority: "medium", issueType: "task", statusId: "s-todo", updatedAt: "u-edit" });
    const r = await runInboundSync(fakeJiraRead([jiraIssue("S", jiraUpdated)]), board, { jql: "x", projectId: "p", knownState: stateFor(), directions: resolveSyncDirections({}) });
    assert.equal(r.conflicted, 1, `jira updated=${jiraUpdated}`);
    assert.equal(board.st.issue.title, "Board edit");
  }
});

test("push does not re-baseline an unpushed jira-to-board edit as agreed", async () => {
  const { refreshPullStateAfterPush } = await import("../tools/lib/state-sync.mjs");
  const directions = resolveSyncDirections({ SYNC_CONFIG_SYNCDIRECTION: "both", SYNC_CONFIG_FIELDDIRECTIONS: '{"priority":"jira-to-board"}' });
  const boardIssue = { id: "i1", externalKey: "KD-1", title: "New", description: "", priority: "high", issueType: "task", statusId: "s-todo", updatedAt: "u2" };
  const boardClient = { async listExternallyTrackedIssues() { return new Map([["KD-1", boardIssue]]); } };
  const next = await refreshPullStateAfterPush({ client: {}, boardClient, projectId: "p", pullState: stateFor(), applied: [{ kind: "fields", key: "KD-1" }], directions });
  assert.equal(next.issues["KD-1"].fields.title, "New");
  assert.equal(next.issues["KD-1"].fields.priority, "medium");
});

test("one create switch: pushCreate alone enables push-create", () => {
  const issues = [issue({ externalKey: null, id: "n1" })];
  const sn = plan({ issues: [], snapshot: { issues: {}, commentsSeen: [] }, createEnabled: true }).nextSnapshot;
  const r = plan({ issues, snapshot: sn, createEnabled: true });
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].kind, "create");
});
