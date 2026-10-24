import { test } from "node:test";
import assert from "node:assert/strict";
import { runInboundSync } from "../tools/lib/sync-engine.mjs";
import { BoardClient } from "../tools/lib/board-client.mjs";
import { createBoardFixtureState, createDefaultBoardFixtureFetch } from "../tools/lib/board-fixtures.mjs";
import { planOutbox } from "../tools/lib/outbox-producer.mjs";
import { runPush } from "../tools/lib/push-plan.mjs";
import { loadBoardState, snapshotAfterPull } from "../tools/lib/state-sync.mjs";
import { resolveSyncDirections } from "../tools/lib/sync-direction.mjs";
import { FIELDS } from "../tools/lib/field-map.mjs";

const both = resolveSyncDirections({ SYNC_CONFIG_SYNCDIRECTION: "both" });
const toBoard = resolveSyncDirections({});
const toJira = resolveSyncDirections({ SYNC_CONFIG_SYNCDIRECTION: "board-to-jira" });

const jiraIssue = (key, links = []) => ({
  key,
  fields: { summary: key, status: { statusCategory: { key: "new" } }, updated: "2026-01-01T00:00:00.000+0000", issuelinks: links, comment: { comments: [] } },
});
const blocks = (id, { out, inn }) => ({ id, type: { name: "Blocks" }, ...(out ? { outwardIssue: { key: out } } : {}), ...(inn ? { inwardIssue: { key: inn } } : {}) });

function setup() {
  const state = createBoardFixtureState();
  const board = new BoardClient({ boardUrl: "https://b.local", fetchImpl: createDefaultBoardFixtureFetch(state) });
  let issues = [];
  const client = {
    async getIssue(key) {
      const i = issues.find((x) => x.key === key);
      if (!i) throw Object.assign(new Error("gone"), { status: 404 });
      return i;
    },
    async *searchAll() {
      for (const i of issues) yield i;
    },
    created: [],
    deleted: [],
    async createIssueLink(l) {
      this.created.push(l);
    },
    async deleteIssueLink(id) {
      this.deleted.push(id);
    },
  };
  let pull = { issues: {} };
  return {
    state,
    board,
    client,
    setJira: (v) => (issues = v),
    async pull(directions = toBoard, dryRun = false) {
      const r = await runInboundSync(client, board, { jql: "x", projectId: "p", knownState: pull, directions, dryRun });
      if (!dryRun) pull = r.nextState;
      return r;
    },
    deps: () => state.dependencies,
    id: (key) => state.issues.find((i) => i.externalKey === key).id,
  };
}

test("FIELDS requests issuelinks", () => assert.ok(FIELDS.includes("issuelinks")));

test("KD-a blocks KD-b: pull makes b depend on a; a re-pull adds nothing", async () => {
  const t = setup();
  t.setJira([jiraIssue("KD-1", [blocks("10", { out: "KD-2" })]), jiraIssue("KD-2", [blocks("10", { inn: "KD-1" })])]);
  const r = await t.pull();
  assert.equal(r.links.created, 1);
  assert.deepEqual(t.deps().map((d) => [d.issueId, d.dependsOnId, d.type]), [[t.id("KD-2"), t.id("KD-1"), "depends_on"]]);
  const again = await t.pull();
  assert.equal(again.links.created, 0);
  assert.equal(t.deps().length, 1);
});

test("link removed in Jira: plugin-created dependency goes, hand-added stays (reported as a conflict)", async () => {
  const t = setup();
  t.setJira([jiraIssue("KD-1", [blocks("10", { out: "KD-2" })]), jiraIssue("KD-2"), jiraIssue("KD-3")]);
  await t.pull();
  // a person adds KD-3 depends_on KD-1 by hand, and Jira later links it too
  t.state.dependencies.push({ id: "hand", issueId: t.id("KD-3"), dependsOnId: t.id("KD-1"), type: "depends_on" });
  t.setJira([jiraIssue("KD-1", [blocks("10", { out: "KD-2" }), blocks("11", { out: "KD-3" })]), jiraIssue("KD-2"), jiraIssue("KD-3")]);
  await t.pull();
  t.setJira([jiraIssue("KD-1"), jiraIssue("KD-2"), jiraIssue("KD-3")]);
  const r = await t.pull();
  assert.equal(r.links.removed, 1);
  assert.equal(r.links.conflicted, 1);
  assert.deepEqual(t.deps().map((d) => d.id), ["hand"]);
});

test("out-of-scope link end is skipped and reported, no error", async () => {
  const t = setup();
  t.setJira([jiraIssue("KD-1", [blocks("10", { out: "KD-99" })])]);
  const r = await t.pull();
  assert.equal(r.links.skipped, 1);
  assert.match(r.links.details[0].reason, /KD-99/);
  assert.equal(t.deps().length, 0);
});

test("dry run plans a link and writes nothing", async () => {
  const t = setup();
  t.setJira([jiraIssue("KD-1", [blocks("10", { out: "KD-2" })]), jiraIssue("KD-2")]);
  await t.pull();
  // KD-1 and KD-2 now exist; drop the dependency to see the plan
  t.state.dependencies.length = 0;
  const r = await t.pull(toBoard, true);
  assert.equal(t.deps().length, 0);
  assert.equal(r.links.created, 0); // already tracked in state, so nothing new is planned
});

async function baseline(t, directions) {
  const state = await loadBoardState(t.board, "p");
  return planOutbox({ ...state, snapshot: null, directions }).nextSnapshot;
}

test("board dependency added with direction both: one issueLink POST; next pull quiet", async () => {
  const t = setup();
  t.setJira([jiraIssue("KD-1"), jiraIssue("KD-2")]);
  await t.pull(both);
  const snap = await baseline(t, both);
  await t.board.addDependency(t.id("KD-2"), t.id("KD-1"), "depends_on");
  const planned = planOutbox({ ...(await loadBoardState(t.board, "p")), snapshot: snap, directions: both });
  assert.equal(planned.entries.length, 1);
  assert.deepEqual(planned.entries[0], { kind: "link", action: "add", linkKey: "blocks:KD-1>KD-2", linkType: "blocks", from: "KD-1", to: "KD-2" });
  const res = await runPush(t.client, planned.entries, {});
  assert.equal(res.failed.length, 0);
  assert.deepEqual(t.client.created, [{ typeName: "Blocks", inwardKey: "KD-2", outwardKey: "KD-1" }]);
  assert.equal(planOutbox({ ...(await loadBoardState(t.board, "p")), snapshot: planned.nextSnapshot, directions: both }).entries.length, 0);
  t.setJira([jiraIssue("KD-1", [blocks("20", { out: "KD-2" })]), jiraIssue("KD-2", [blocks("20", { inn: "KD-1" })])]);
  const pulled = await t.pull(both);
  assert.equal(pulled.links.created, 0);
  assert.equal(t.deps().length, 1);
  // an add whose Jira link already exists makes no POST
  t.client.created.length = 0;
  await runPush(t.client, planned.entries, {});
  assert.equal(t.client.created.length, 0);
});

test("board dependency removed with both: one DELETE of the Jira link id", async () => {
  const t = setup();
  t.setJira([jiraIssue("KD-1", [blocks("20", { out: "KD-2" })]), jiraIssue("KD-2", [blocks("20", { inn: "KD-1" })])]);
  await t.pull(both);
  const snap = await baseline(t, both);
  t.state.dependencies.length = 0;
  const planned = planOutbox({ ...(await loadBoardState(t.board, "p")), snapshot: snap, directions: both });
  assert.equal(planned.entries[0].action, "remove");
  await runPush(t.client, planned.entries, {});
  assert.deepEqual(t.client.deleted, ["20"]);
});

test("direction jira-to-board: the board dependency is not pushed", async () => {
  const t = setup();
  t.setJira([jiraIssue("KD-1"), jiraIssue("KD-2")]);
  await t.pull(toBoard);
  const snap = await baseline(t, toBoard);
  await t.board.addDependency(t.id("KD-2"), t.id("KD-1"), "depends_on");
  const planned = planOutbox({ ...(await loadBoardState(t.board, "p")), snapshot: snap, directions: toBoard });
  assert.deepEqual(planned.entries, []);
});

test("board-to-jira: pull never writes dependencies; the board link is restored in Jira by the next push", async () => {
  const t = setup();
  t.setJira([jiraIssue("KD-1"), jiraIssue("KD-2")]);
  await t.pull(toJira);
  const snap = await baseline(t, toJira);
  await t.board.addDependency(t.id("KD-2"), t.id("KD-1"), "depends_on");
  const r = await t.pull(toJira);
  assert.equal(t.deps().length, 1);
  assert.equal(r.links.created, 0);
  const adjusted = await snapshotAfterPull({ boardClient: t.board, projectId: "p", snapshot: snap, touchedKeys: new Set(), linkAdjust: r.linkSnapshotAdjust });
  // the snapshot already lacked the link (it was added after baselining), so push sees it as new
  const planned = planOutbox({ ...(await loadBoardState(t.board, "p")), snapshot: adjusted, directions: toJira });
  assert.deepEqual(planned.entries.map((e) => [e.action, e.linkKey]), [["add", "blocks:KD-1>KD-2"]]);
});

test("dry run push of a link entry sends nothing", async () => {
  const t = setup();
  t.setJira([jiraIssue("KD-1"), jiraIssue("KD-2")]);
  const entry = { kind: "link", action: "add", linkKey: "blocks:KD-1>KD-2", linkType: "blocks", from: "KD-1", to: "KD-2" };
  const res = await runPush(t.client, [entry], { dryRun: true });
  assert.equal(res.applied[0].wouldApply, true);
  assert.equal(t.client.created.length, 0);
});
