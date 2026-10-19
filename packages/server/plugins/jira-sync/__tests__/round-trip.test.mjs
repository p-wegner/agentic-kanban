// Round-trip defects from live round 2 (#1629), against the strict in-memory board fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runInboundSync } from "../tools/lib/sync-engine.mjs";
import { planOutbox } from "../tools/lib/outbox-producer.mjs";
import { prepareCreateFields } from "../tools/lib/push-plan.mjs";
import { refreshPullStateAfterPush, snapshotAfterPull } from "../tools/lib/state-sync.mjs";
import { BoardClient } from "../tools/lib/board-client.mjs";
import { createBoardFixtureState, createDefaultBoardFixtureFetch } from "../tools/lib/board-fixtures.mjs";

const newBoard = () => {
  const state = createBoardFixtureState();
  state.statuses.push({ id: "status-cancelled", name: "Cancelled" }, { id: "status-done", name: "Done" });
  return { state, client: new BoardClient({ boardUrl: "http://board.test", fetchImpl: createDefaultBoardFixtureFetch(state) }) };
};

const jiraIssue = (key, extra = {}, updated = "u1") => ({
  key,
  fields: { summary: key, updated, status: { statusCategory: { key: "new" } }, issuetype: { name: "Bug" }, ...extra },
});
const fakeJira = (issues, { deleted = [] } = {}) => ({
  async getIssue(key) {
    if (deleted.includes(key)) throw Object.assign(new Error("gone"), { status: 404 });
    return { key, fields: { updated: "u2" } };
  },
  async *searchAll() {
    for (const i of issues) yield i;
  },
});
const opts = { jql: "project = KD", projectId: "p", knownState: { issues: {} } };

test("pull stores the Jira type as issueType (fixture rejects unknown fields)", async () => {
  const { state, client } = newBoard();
  await runInboundSync(fakeJira([jiraIssue("KD-1")]), client, opts);
  assert.equal(state.issues[0].issueType, "bug");
  await assert.rejects(client.createIssue({ projectId: "p", title: "x", type: "bug" }), /unknown issue field/);
});

test("push then pull yields no conflict for the pushed issue", async () => {
  const { state, client } = newBoard();
  const jira = fakeJira([jiraIssue("KD-1")]);
  const first = await runInboundSync(jira, client, opts);
  // board edit, then a push that transitions it in Jira
  await client.updateIssue(state.issues[0].id, { statusId: "status-done" });
  const pullState = await refreshPullStateAfterPush({
    client: jira,
    boardClient: client,
    projectId: "p",
    pullState: first.nextState,
    applied: [{ kind: "transition", key: "KD-1", targetStatus: "Done" }],
  });
  const next = await runInboundSync(fakeJira([jiraIssue("KD-1", {}, "u2")]), client, { ...opts, knownState: pullState });
  assert.equal(next.conflicted, 0);
  assert.equal(next.skipped, 1);
});

test("a pull-moved deleted issue produces no outbound entry", async () => {
  const { state, client } = newBoard();
  const first = await runInboundSync(fakeJira([jiraIssue("KD-39")]), client, opts);
  let snapshot = await snapshotAfterPull({ boardClient: client, projectId: "p", snapshot: null, touchedKeys: new Set() });
  const gone = await runInboundSync(fakeJira([], { deleted: ["KD-39"] }), client, { ...opts, knownState: first.nextState });
  assert.equal(gone.deleted[0].movedTo, "Cancelled");
  snapshot = await snapshotAfterPull({ boardClient: client, projectId: "p", snapshot, touchedKeys: new Set(["KD-39"]) });
  const issues = await client.listIssues("p");
  const names = new Map(state.statuses.map((s) => [s.id, s.name]));
  assert.equal(planOutbox({ issues, statusNameById: names, commentsByIssueId: {}, snapshot }).entries.length, 0);
  // even with a stale snapshot, a jira:deleted issue is never queued
  const stale = { issues: { [issues[0].id]: { status: "Todo" } }, commentsSeen: [] };
  const tagged = issues.map((i) => ({ ...i, tags: [{ name: "jira:deleted" }] }));
  assert.equal(planOutbox({ issues: tagged, statusNameById: names, commentsByIssueId: {}, snapshot: stale }).entries.length, 0);
});

test("the first pull takes the baseline so earlier board edits are still pushed", async () => {
  const { state, client } = newBoard();
  const first = await runInboundSync(fakeJira([jiraIssue("KD-1")]), client, opts);
  const snapshot = await snapshotAfterPull({ boardClient: client, projectId: "p", snapshot: null, touchedKeys: new Set() });
  assert.equal(snapshot.issues[state.issues[0].id].status, "Todo");
  await client.updateIssue(state.issues[0].id, { statusId: "status-done" });
  const names = new Map(state.statuses.map((s) => [s.id, s.name]));
  const { entries } = planOutbox({ issues: await client.listIssues("p"), statusNameById: names, commentsByIssueId: {}, snapshot });
  assert.equal(entries[0]?.targetStatus, "Done");
  assert.ok(first);
});

test("push-create sends ADF, the mapped type and labels", () => {
  const issue = { id: "i", title: "T", description: "# Head\n\n- one", issueType: "bug", statusId: "s", tags: [{ name: "ui" }, { name: "jira:deleted" }, { name: "epic:KD-1" }, { name: "assignee:Ann" }, { name: "needs review" }] };
  const { entries } = planOutbox({ issues: [issue], statusNameById: new Map(), commentsByIssueId: {}, snapshot: { issues: {}, commentsSeen: [] }, createEnabled: true });
  const fields = prepareCreateFields(entries[0].fields, { projectKey: "KD", defaultIssueType: "Task" });
  assert.equal(fields.issuetype.name, "Bug");
  assert.deepEqual(fields.labels, ["ui", "needs-review"]);
  assert.equal(fields.description.content[0].type, "heading");
  assert.equal(fields.description.content[1].type, "bulletList");
});

test("a deletion is counted as deleted (once), listed, and not as out of scope (#1634)", async () => {
  const { state, client } = newBoard();
  const first = await runInboundSync(fakeJira([jiraIssue("KD-46"), jiraIssue("KD-50")]), client, opts);
  const gone = fakeJira([jiraIssue("KD-50")], { deleted: ["KD-46"] });
  const second = await runInboundSync(gone, client, { ...opts, knownState: first.nextState });
  assert.deepEqual(second.deleted.map((d) => d.key), ["KD-46"]);
  assert.equal(second.outOfScope.length, 0);
  assert.equal(second.reportedOutOfScope.length, 0);
  assert.deepEqual(second.details.filter((d) => d.action === "delete").map((d) => d.key), ["KD-46"]);
  assert.equal(second.details.find((d) => d.action === "delete").localIssueNumber, state.issues.find((i) => i.externalKey === "KD-46").issueNumber);
  // the run that applied it reports it; the next one does not
  const third = await runInboundSync(gone, client, { ...opts, knownState: second.nextState });
  assert.equal(third.deleted.length, 0);
});

test("a key that left the JQL scope but still exists stays out of scope, not deleted", async () => {
  const { client } = newBoard();
  const first = await runInboundSync(fakeJira([jiraIssue("KD-1")]), client, opts);
  const next = await runInboundSync(fakeJira([]), client, { ...opts, knownState: first.nextState });
  assert.equal(next.deleted.length, 0);
  assert.deepEqual(next.reportedOutOfScope, ["KD-1"]);
});

test("pull details carry the board issue number for create, update, conflict and skip rows", async () => {
  const { state, client } = newBoard();
  const first = await runInboundSync(fakeJira([jiraIssue("KD-1")]), client, opts);
  assert.equal(first.details[0].localIssueNumber, 1);
  const again = await runInboundSync(fakeJira([jiraIssue("KD-1")]), client, { ...opts, knownState: first.nextState });
  assert.equal(again.details[0].localIssueNumber, 1);
  await new Promise((r) => setTimeout(r, 5)); // the fixture stamps updatedAt in ms
  await client.updateIssue(state.issues[0].id, { title: "edited" });
  const conflict = await runInboundSync(fakeJira([jiraIssue("KD-1", {}, "u2")]), client, { ...opts, knownState: first.nextState });
  assert.equal(conflict.details[0].action, "conflict");
  assert.equal(conflict.details[0].localIssueNumber, 1);
});
