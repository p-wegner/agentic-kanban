import { test } from "node:test";
import assert from "node:assert/strict";
import { planOutbox } from "../tools/lib/outbox-producer.mjs";
import { runInboundSync } from "../tools/lib/sync-engine.mjs";
import { applyWritebacks } from "../tools/lib/writebacks.mjs";
import { prepareCreateFields } from "../tools/lib/push-plan.mjs";
import { BoardClient } from "../tools/lib/board-client.mjs";
import { createBoardFixtureState, createDefaultBoardFixtureFetch } from "../tools/lib/board-fixtures.mjs";
import { JiraClient } from "../tools/lib/jira-client.mjs";
import { createDefaultFixtureFetch } from "../tools/lib/fixtures.mjs";

const names = new Map([["s-todo", "Todo"], ["s-prog", "In Progress"]]);
const issue = (over = {}) => ({ id: "i1", title: "T", externalKey: "KD-1", statusId: "s-todo", ...over });
const plan = (over) => planOutbox({ statusNameById: names, commentsByIssueId: {}, snapshot: null, issues: [], ...over });

test("first run only baselines", () => {
  const { entries, nextSnapshot } = plan({ issues: [issue()] });
  assert.deepEqual(entries, []);
  assert.equal(nextSnapshot.issues.i1.status, "Todo");
});

test("a status change on a synced issue produces exactly one transition entry", () => {
  const first = plan({ issues: [issue()] });
  const moved = [issue({ statusId: "s-prog" })];
  const second = plan({ issues: moved, snapshot: first.nextSnapshot });
  assert.equal(second.entries.length, 1);
  assert.deepEqual(second.entries[0], { kind: "transition", key: "KD-1", targetStatus: "In Progress", boardIssueId: "i1" });
  // unchanged on the next diff, and an already-queued entry is not duplicated
  assert.equal(plan({ issues: moved, snapshot: second.nextSnapshot }).entries.length, 0);
  assert.equal(plan({ issues: moved, snapshot: first.nextSnapshot, outboxEntries: second.entries }).entries.length, 0);
});

test("a Jira-originated comment is not echoed back; a board comment is sent once", () => {
  const base = plan({ issues: [issue()] }).nextSnapshot;
  const comments = {
    i1: [
      { id: "c1", body: "from jira", payload: { origin: "jira" }, author: "user", kind: "note" },
      { id: "c2", body: "hello", author: "user", kind: "note" },
      { id: "c3", body: "sys", author: "system", kind: "note" },
    ],
  };
  const { entries, nextSnapshot } = plan({ issues: [issue()], snapshot: base, commentsByIssueId: comments });
  assert.deepEqual(entries.map((e) => e.comment.boardCommentId), ["c2"]);
  assert.equal(plan({ issues: [issue()], snapshot: nextSnapshot, commentsByIssueId: comments }).entries.length, 0);
});

test("create is opt-in and only for issues new since the baseline", () => {
  const base = plan({ issues: [issue()] }).nextSnapshot;
  const fresh = issue({ id: "i2", externalKey: null, title: "New" });
  assert.equal(plan({ issues: [issue(), fresh], snapshot: base }).entries.length, 0);
  const { entries } = plan({ issues: [issue(), fresh], snapshot: base, createEnabled: true });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "create");
  assert.equal(entries[0].boardIssueId, "i2");
});

test("prepareCreateFields injects the project key and default issue type", () => {
  const f = prepareCreateFields({ summary: "S", description: "d" }, { projectKey: "KD", defaultIssueType: "Task" });
  assert.deepEqual(f.project, { key: "KD" });
  assert.deepEqual(f.issuetype, { name: "Task" });
  assert.equal(f.description.type, "doc");
  assert.deepEqual(prepareCreateFields({ project: { key: "X" }, issuetype: { name: "Bug" } }, { projectKey: "KD" }).project, { key: "X" });
});

test("create -> writeback -> pull yields 0 created for that key", async () => {
  const state = createBoardFixtureState();
  const board = new BoardClient({ boardUrl: "https://b.local", fetchImpl: createDefaultBoardFixtureFetch(state) });
  const jira = new JiraClient({ siteUrl: "https://fixture.atlassian.net", email: "a@b.c", apiToken: "t", fetchImpl: createDefaultFixtureFetch() });
  const { searchAll } = jira;
  let jiraKey;
  for await (const i of searchAll.call(jira, "project = ENG", { fields: ["summary"] })) { jiraKey = i.key; break; }

  const local = await board.createIssue({ projectId: "p", title: "local" });
  const run = (extra = {}) => runInboundSync(jira, board, { jql: "project = ENG", projectId: "p", knownState: { issues: {} }, dryRun: true, ...extra });

  // while the writeback is pending, pull must not import the key
  const pending = await run({ pendingWritebackKeys: new Set([jiraKey]) });
  assert.equal(pending.details.find((d) => d.key === jiraKey).action, "skip");

  // once applied, the board issue carries the key, so pull finds it instead of creating
  const wb = await applyWritebacks(board, { keys: { [local.id]: jiraKey } }, { siteUrl: "https://fixture.atlassian.net" });
  assert.deepEqual(wb.keys, {});
  const stored = state.issues.find((i) => i.id === local.id);
  assert.equal(stored.externalKey, jiraKey);
  assert.equal(stored.externalUrl, `https://fixture.atlassian.net/browse/${jiraKey}`);
  assert.notEqual((await run()).details.find((d) => d.key === jiraKey).action, "create");
});

test("a Done loop ticket (plugin-loop: key) queues no outbox entry (#1718)", () => {
  const loop = issue({ id: "L1", externalKey: "plugin-loop:jira-sync:sync-conflicts:conflict:KD-54:r2" });
  const first = plan({ issues: [loop] });
  const done = plan({ issues: [{ ...loop, statusId: "s-prog" }], snapshot: first.nextSnapshot });
  assert.deepEqual(done.entries, []);
});
