// Out-of-scope marking (#1731): settled once, restored on return, refused in bulk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runInboundSync, MassOutOfScopeError } from "../tools/lib/sync-engine.mjs";
import { BoardClient } from "../tools/lib/board-client.mjs";
import { createBoardFixtureState, createDefaultBoardFixtureFetch } from "../tools/lib/board-fixtures.mjs";

const newBoard = () => {
  const state = createBoardFixtureState();
  return { state, client: new BoardClient({ boardUrl: "http://board.test", fetchImpl: createDefaultBoardFixtureFetch(state) }) };
};
const jiraIssue = (key) => ({
  key,
  fields: { summary: key, updated: "u1", status: { statusCategory: { key: "new" } }, issuetype: { name: "Bug" } },
});
let getCalls = 0;
const fakeJira = (issues) => ({
  async getIssue(key) {
    getCalls++;
    return { key, fields: { updated: "u2" } };
  },
  async *searchAll() {
    for (const i of issues) yield i;
  },
});
const opts = { jql: "sprint in openSprints()", projectId: "p", knownState: { issues: {} } };
const keys = (n) => Array.from({ length: n }, (_, i) => `KD-${i + 1}`);
const tagNames = async (client, state, key) =>
  (await client.listIssueTags(state.issues.find((i) => i.externalKey === key).id)).map((t) => t.name).sort();

test("leave and return: tags removed, restore named, marker settled in between", async () => {
  const { state, client } = newBoard();
  const all = keys(10).map(jiraIssue);
  const first = await runInboundSync(fakeJira(all), client, opts);
  const left = await runInboundSync(fakeJira(all.slice(1)), client, { ...opts, knownState: first.nextState, now: "2026-10-29T00:00:00.000Z" });
  assert.deepEqual(left.reportedOutOfScope, ["KD-1"]);
  assert.equal(left.nextState.issues["KD-1"].outOfScopeAt, "2026-10-29T00:00:00.000Z");
  assert.deepEqual(await tagNames(client, state, "KD-1"), ["jira:out-of-scope", "no-auto-start"]);

  getCalls = 0;
  const still = await runInboundSync(fakeJira(all.slice(1)), client, { ...opts, knownState: left.nextState });
  assert.equal(getCalls, 0);
  assert.deepEqual(still.reportedOutOfScope, []);

  const back = await runInboundSync(fakeJira(all), client, { ...opts, knownState: still.nextState });
  assert.deepEqual(back.restored, ["KD-1"]);
  assert.equal(back.details.find((d) => d.key === "KD-1").restored, true);
  assert.deepEqual(await tagNames(client, state, "KD-1"), []);
  assert.equal(back.nextState.issues["KD-1"].outOfScopeAt, undefined);
});

test("a hand-added no-auto-start survives the return", async () => {
  const { state, client } = newBoard();
  const all = keys(10).map(jiraIssue);
  const first = await runInboundSync(fakeJira(all), client, opts);
  const board1 = state.issues.find((i) => i.externalKey === "KD-1");
  const tag = await client.createTag("no-auto-start");
  await client.attachTag(board1.id, tag.id);
  const left = await runInboundSync(fakeJira(all.slice(1)), client, { ...opts, knownState: first.nextState });
  await runInboundSync(fakeJira(all), client, { ...opts, knownState: left.nextState });
  assert.deepEqual(await tagNames(client, state, "KD-1"), ["no-auto-start"]);
});

test("mass out-of-scope marking is refused without writes", async () => {
  const { state, client } = newBoard();
  const first = await runInboundSync(fakeJira(keys(5).map(jiraIssue)), client, opts);
  await assert.rejects(
    runInboundSync(fakeJira([]), client, { ...opts, knownState: first.nextState }),
    (e) => e instanceof MassOutOfScopeError && /5 out of 5/.test(e.message),
  );
  assert.equal(state.issueTags.size, 0);
});
