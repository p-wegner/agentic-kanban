import { test } from "node:test";
import assert from "node:assert/strict";
import { mapJiraIssueToBoardFields, parseAssigneeMap } from "../tools/lib/field-map.mjs";
import { planOutbox } from "../tools/lib/outbox-producer.mjs";
import { runPush } from "../tools/lib/push-plan.mjs";
import { runInboundSync } from "../tools/lib/sync-engine.mjs";
import { resolveSyncDirections } from "../tools/lib/sync-direction.mjs";
import { refreshPullStateAfterPush } from "../tools/lib/state-sync.mjs";
import { resolveIssue } from "../tools/lib/resolve.mjs";

const both = resolveSyncDirections({ SYNC_CONFIG_SYNCDIRECTION: "both" });
const assigneeMap = { acc1: "Peter", acc2: "Anna" };

const jiraIssue = ({ assignee, updated = "j1" } = {}) => ({
  key: "KD-1",
  fields: { summary: "S", description: null, status: { statusCategory: { key: "new" } }, priority: { name: "Medium" }, labels: [], updated, issuetype: { name: "Task" }, assignee },
});
const person = (accountId, displayName) => ({ accountId, displayName });

test("pull mapping: mapped accountId gives the mapped name, unmapped the displayName, unassigned no tag", () => {
  const mapped = mapJiraIssueToBoardFields(jiraIssue({ assignee: person("acc1", "Peter W.") }), { assigneeMap });
  assert.ok(mapped.tags.includes("assignee:Peter"));
  assert.equal(mapped.assigneeAccountId, "acc1");
  const unmapped = mapJiraIssueToBoardFields(jiraIssue({ assignee: person("zzz", "Zed") }), { assigneeMap });
  assert.ok(unmapped.tags.includes("assignee:Zed"));
  const none = mapJiraIssueToBoardFields(jiraIssue({ assignee: null }), { assigneeMap });
  assert.equal(none.tags.some((t) => t.startsWith("assignee:")), false);
  assert.equal(none.assignee, "");
});

test("parseAssigneeMap: object and row array parse; bad rows are named", () => {
  assert.deepEqual(parseAssigneeMap('{"a":"A"}').map, { a: "A" });
  assert.deepEqual(parseAssigneeMap([{ accountId: "b", name: "B" }]).map, { b: "B" });
  assert.equal(parseAssigneeMap('{"a":""}').problems.length, 1);
  assert.equal(parseAssigneeMap("nope").problems.length, 1);
});

// A board whose tags are real: attach/detach change what listExternallyTrackedIssues reports.
function statefulBoard() {
  const st = { exists: false, tags: [], issue: { id: "i1", externalKey: "KD-1", title: "S", description: "", priority: "medium", issueType: "task", statusId: "s-todo", updatedAt: "u0" } };
  const view = () => ({ ...st.issue, tags: st.tags.map((n) => ({ id: n, name: n })) });
  return {
    st,
    async listStatuses() { return [{ id: "s-todo", name: "Todo", isDefault: true }]; },
    async listExternallyTrackedIssues() { return st.exists ? new Map([["KD-1", view()]]) : new Map(); },
    async createIssue(body) { st.exists = true; Object.assign(st.issue, { title: body.title, priority: body.priority, issueType: body.issueType }); return st.issue; },
    async updateIssue(_id, body) { Object.assign(st.issue, body, { updatedAt: "u-upd" }); return st.issue; },
    async listTags() { return st.tags.map((n) => ({ id: n, name: n })); },
    async createTag(name) { return { id: name, name }; },
    async listIssueTags() { return st.tags.map((n) => ({ id: n, name: n })); },
    async attachTag(_i, id) { st.tags.push(id); },
    async detachTag(_i, id) { st.tags = st.tags.filter((n) => n !== id); },
    async listComments() { return []; },
  };
}
const jiraRead = (issue) => ({ async getIssue() { return issue; }, async *searchAll() { yield issue; } });
const pull = (jira, board, knownState, extra = {}) =>
  runInboundSync(jiraRead(jira), board, { jql: "x", projectId: "p", knownState, assigneeMap, directions: both, ...extra });
const names = new Map([["s-todo", "Todo"]]);
const plan = (board, snapshot, outboxEntries = []) =>
  planOutbox({ issues: [{ ...board.st.issue, tags: board.st.tags }], statusNameById: names, commentsByIssueId: {}, snapshot, outboxEntries, directions: both });

function fakeJiraWrite() {
  const calls = [];
  return { calls, async assignIssue(key, accountId) { calls.push({ key, accountId }); } };
}

async function synced(assignee) {
  const board = statefulBoard();
  const first = await pull(jiraIssue({ assignee }), board, { issues: {} });
  return { board, state: first.nextState, snapshot: plan(board, null).nextSnapshot };
}

test("board tag change (both): one assignee PUT with the mapped accountId; the next pull is quiet", async () => {
  const { board, state, snapshot } = await synced(person("acc1", "Peter W."));
  assert.deepEqual(board.st.tags, ["assignee:Peter"]);
  assert.equal(state.issues["KD-1"].assigneeAccountId, "acc1");
  board.st.tags = ["assignee:Anna"];
  board.st.issue.updatedAt = "u1";
  const planned = plan(board, snapshot);
  assert.deepEqual(planned.entries, [{ kind: "assignee", key: "KD-1", boardIssueId: "i1", name: "Anna" }]);
  const jira = fakeJiraWrite();
  const pushed = await runPush(jira, planned.entries, { assigneeMap });
  assert.deepEqual(jira.calls, [{ key: "KD-1", accountId: "acc2" }]);
  assert.equal(pushed.failed.length, 0);
  const afterJira = jiraIssue({ assignee: person("acc2", "Anna B."), updated: "j2" });
  const refreshed = await refreshPullStateAfterPush({
    client: jiraRead(afterJira), boardClient: board, projectId: "p", pullState: state, applied: pushed.applied, directions: both,
  });
  const next = await pull(afterJira, board, refreshed);
  assert.equal(next.conflicted, 0);
  assert.equal(next.updated, 0);
  assert.deepEqual(board.st.tags, ["assignee:Anna"]);
  assert.equal(plan(board, planned.nextSnapshot).entries.length, 0);
});

test("tag removed: PUT with accountId null", async () => {
  const { board, snapshot } = await synced(person("acc1", "Peter W."));
  board.st.tags = [];
  const planned = plan(board, snapshot);
  assert.equal(planned.entries[0].name, "");
  const jira = fakeJiraWrite();
  await runPush(jira, planned.entries, { assigneeMap });
  assert.deepEqual(jira.calls, [{ key: "KD-1", accountId: null }]);
});

test("unmapped name: a push failure with the reason, nothing written, entry stays queued", async () => {
  const jira = fakeJiraWrite();
  const entry = { kind: "assignee", key: "KD-1", boardIssueId: "i1", name: "Nobody" };
  const r = await runPush(jira, [entry], { assigneeMap });
  assert.equal(jira.calls.length, 0);
  assert.equal(r.failed[0].reason, "assignee Nobody has no accountId in assigneeMap");
  assert.deepEqual(r.remaining, [entry]);
});

test("jira-to-board: a tag change is not pushed", async () => {
  const { board, snapshot } = await synced(person("acc1", "Peter W."));
  board.st.tags = ["assignee:Anna"];
  const planned = planOutbox({ issues: [{ ...board.st.issue, tags: board.st.tags }], statusNameById: names, commentsByIssueId: {}, snapshot, directions: resolveSyncDirections({}) });
  assert.deepEqual(planned.entries, []);
});

test("pull: a reassigned and an unassigned Jira issue swap and drop the tag", async () => {
  const { board, state } = await synced(person("acc1", "Peter W."));
  const re = await pull(jiraIssue({ assignee: person("acc2", "Anna B."), updated: "j2" }), board, state);
  assert.equal(re.conflicted, 0);
  assert.deepEqual(board.st.tags, ["assignee:Anna"]);
  const gone = await pull(jiraIssue({ assignee: null, updated: "j3" }), board, re.nextState);
  assert.equal(gone.conflicted, 0);
  assert.deepEqual(board.st.tags, []);
});

test("both sides changed: a conflict row on assignee, resolvable per field", async () => {
  const { board, state } = await synced(person("acc1", "Peter W."));
  board.st.tags = ["assignee:Anna"];
  board.st.issue.updatedAt = "u-edit";
  const jiraNow = jiraIssue({ assignee: person("acc3", "Carl"), updated: "j2" });
  const conflict = await pull(jiraNow, board, state);
  assert.equal(conflict.conflicted, 1);
  const row = conflict.details[0].fields.find((f) => f.field === "assignee");
  assert.equal(row.differs, true);
  assert.deepEqual([row.board, row.lastSync, row.jira], ["Anna", "Peter", "Carl"]);

  const jiraWrites = [];
  const client = { ...jiraRead(jiraNow), async assignIssue(k, id) { jiraWrites.push([k, id]); }, async updateIssueFields() {}, async addComment() {} };
  const keepJira = await resolveIssue({ client, boardClient: board, projectId: "p", key: "KD-1", keep: { assignee: "jira" }, reason: "test", knownState: state, assigneeMap });
  assert.equal(keepJira.ok, true);
  assert.deepEqual(board.st.tags, ["assignee:Carl"]);
  assert.equal(keepJira.nextState.issues["KD-1"].fields.assignee, "Carl");
  assert.equal(jiraWrites.length, 0);

  board.st.tags = ["assignee:Anna"];
  const keepBoard = await resolveIssue({ client, boardClient: board, projectId: "p", key: "KD-1", keep: { assignee: "board" }, reason: "test", knownState: state, assigneeMap });
  assert.equal(keepBoard.ok, true);
  assert.deepEqual(jiraWrites, [["KD-1", "acc2"]]);
});

test("keep board with an unmapped name stops before writing anything", async () => {
  const { board, state } = await synced(person("acc1", "Peter W."));
  board.st.tags = ["assignee:Nobody"];
  const writes = [];
  const client = { ...jiraRead(jiraIssue({ assignee: person("acc1", "Peter W."), updated: "j2" })), async assignIssue() { writes.push("a"); }, async updateIssueFields() { writes.push("f"); }, async addComment() {} };
  const r = await resolveIssue({ client, boardClient: board, projectId: "p", key: "KD-1", keep: "board", reason: "test", knownState: state, assigneeMap });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no accountId in assigneeMap/);
  assert.deepEqual(writes, []);
});

test("#1719: a failing queued assignee entry is superseded when the tag changes or goes", () => {
  const board = statefulBoard();
  board.st.tags = [];
  const snapshot = plan(board, null).nextSnapshot;
  const stale = { kind: "assignee", key: "KD-1", boardIssueId: "i1", name: "Nobody" };
  const gone = plan(board, snapshot, [stale]);
  assert.deepEqual(gone.supersedeAssigneeKeys, ["KD-1"]);
  assert.deepEqual(gone.entries, [{ kind: "assignee", key: "KD-1", boardIssueId: "i1", name: "" }]);
  board.st.tags = ["assignee:Anna"];
  const changed = plan(board, snapshot, [stale]);
  assert.equal(changed.entries[0].name, "Anna");
});

test("#1719: a tag pull recorded as agreed is measured against, so a later removal is pushed", async () => {
  const { snapshotAfterPull } = await import("../tools/lib/state-sync.mjs");
  const board = statefulBoard();
  board.st.exists = true;
  board.listIssues = async () => [{ ...board.st.issue, tags: board.st.tags.map((n) => ({ name: n })) }];
  board.getDependencies = async () => ({ dependencies: [] });
  const stale = plan(board, null).nextSnapshot; // taken before the pull added the tag
  board.st.tags = ["assignee:Peter"];
  const agreedFields = { "KD-1": { assignee: "Peter" } };
  const snap = await snapshotAfterPull({ boardClient: board, projectId: "p", snapshot: stale, touchedKeys: new Set(), agreedFields, directions: both });
  board.st.tags = [];
  assert.equal(plan(board, stale).entries.length, 0);
  assert.equal(plan(board, snap).entries[0].name, "");
});
