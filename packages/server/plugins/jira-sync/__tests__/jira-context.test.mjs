import { test } from "node:test";
import assert from "node:assert/strict";
import { runInboundSync, resolveJiraContext } from "../tools/lib/sync-engine.mjs";
import { planOutbox } from "../tools/lib/outbox-producer.mjs";
import { runPush } from "../tools/lib/push-plan.mjs";
import { labelsFromBoardTags } from "../tools/lib/field-map.mjs";
import { resolveSyncDirections } from "../tools/lib/sync-direction.mjs";

const CATALOG = [
  { id: "customfield_10020", name: "Sprint", schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" } },
  { id: "customfield_10016", name: "Story Points", schema: { type: "number" } },
  { id: "customfield_10050", name: "Team", schema: { type: "option" } },
];
const MAP = JSON.stringify({ "Story Points": "tag:sp", Team: "tag:team" });

function issue({ sprint = "Sprint 7", updated = "2026-09-01T00:00:00.000Z" } = {}) {
  return {
    key: "KD-1",
    fields: {
      summary: "S",
      description: null,
      status: { statusCategory: { key: "new" } },
      priority: { name: "Medium" },
      labels: [],
      updated,
      customfield_10020: [{ id: 1, name: sprint, state: "active" }, { id: 0, name: "Old", state: "closed" }],
      fixVersions: [{ name: "1.0" }, { name: "1.1" }],
      customfield_10016: 5,
      customfield_10050: { value: "Platform" },
      attachment: [
        { filename: "a.png", size: 2048, content: "https://j/a.png" },
        { filename: "b.pdf", size: 10, content: "https://j/b.pdf" },
      ],
    },
  };
}

function jira(issues) {
  return {
    listFields: async () => CATALOG,
    getIssue: async (key) => ({ key }),
    async *searchAll() {
      for (const i of issues) yield i;
    },
  };
}

function board() {
  const s = { issues: [], tags: [], issueTags: new Map(), n: 0 };
  return {
    s,
    listStatuses: async () => [{ id: "st", name: "Todo", isDefault: true }],
    listExternallyTrackedIssues: async () => new Map(s.issues.map((i) => [i.externalKey, i])),
    createIssue: async (b) => (s.issues.push({ id: `i${++s.n}`, updatedAt: `t${++s.n}`, ...b }), s.issues.at(-1)),
    updateIssue: async (id, b) => Object.assign(s.issues.find((i) => i.id === id), b, { updatedAt: `t${++s.n}` }),
    listTags: async () => s.tags,
    createTag: async (name) => (s.tags.push({ id: `tg${s.tags.length + 1}`, name }), s.tags.at(-1)),
    listIssueTags: async (id) => s.tags.filter((t) => (s.issueTags.get(id) ?? new Set()).has(t.id)),
    attachTag: async (id, tid) => (s.issueTags.set(id, (s.issueTags.get(id) ?? new Set()).add(tid)), undefined),
    detachTag: async (id, tid) => void s.issueTags.get(id)?.delete(tid),
    listComments: async () => [],
    addComment: async () => ({}),
  };
}
const names = (b) => b.s.tags.filter((t) => b.s.issueTags.get("i2")?.has(t.id) || [...b.s.issueTags.values()].some((x) => x.has(t.id))).map((t) => t.name).sort();
const run = (b, issues, state) => runInboundSync(jira(issues), b, { jql: "x", projectId: "p", knownState: state, customFieldMap: MAP });

test("pull: sprint, versions, custom fields as tags, attachment footer; re-pull is a no-op", async () => {
  const b = board();
  const first = await run(b, [issue()], { issues: {} });
  assert.deepEqual(names(b), ["sp:5", "sprint:Sprint 7", "team:Platform", "version:1.0", "version:1.1"]);
  const desc = b.s.issues[0].description;
  assert.match(desc, /a\.png \(2\.0 KB\): https:\/\/j\/a\.png/);
  assert.match(desc, /b\.pdf/);
  const second = await run(b, [issue()], first.nextState);
  assert.equal(second.created + second.updated, 0);
  assert.equal(b.s.issues[0].description, desc);
});

test("sprint changed in Jira: the old sprint tag is replaced", async () => {
  const b = board();
  const first = await run(b, [issue()], { issues: {} });
  const r = await run(b, [issue({ sprint: "Sprint 8", updated: "2026-09-02T00:00:00.000Z" })], first.nextState);
  assert.equal(r.conflicted, 0);
  const n = names(b);
  assert.ok(n.includes("sprint:Sprint 8"));
  assert.ok(!n.includes("sprint:Sprint 7"));
  assert.equal(r.updated, 1);
});

test("a description push carries no footer and no sprint/version/custom label", async () => {
  const body = "text\n\n<!-- jira-sync:attachments -->\n- a\n<!-- /jira-sync:attachments -->";
  assert.deepEqual(labelsFromBoardTags(["sprint:S", "version:1", "sp:5", "keep"], { extraPrefixes: ["sp"] }), ["keep"]);
  const calls = [];
  const client = { updateIssueFields: async (k, f) => calls.push(f) };
  const e = { kind: "fields", key: "KD-1", boardIssueId: "i1", fields: { description: body } };
  await runPush(client, [e]);
  assert.ok(!JSON.stringify(calls[0]).includes("jira-sync:attachments"));
  const names1 = new Map([["s", "Todo"]]);
  const mk = (description) => ({ id: "i1", title: "T", description, priority: "medium", issueType: "task", tags: ["sprint:S", "version:1"], externalKey: "KD-1", statusId: "s" });
  const base = planOutbox({ issues: [mk("text")], statusNameById: names1, commentsByIssueId: {}, snapshot: null }).nextSnapshot;
  const both = resolveSyncDirections({ SYNC_CONFIG_SYNCDIRECTION: "both" });
  const p = planOutbox({ issues: [mk(body)], statusNameById: names1, commentsByIssueId: {}, snapshot: base, directions: both });
  assert.equal(p.entries.length, 0, "a footer-only change is not a push");
});

test("an unknown customFieldMap field fails and names it", async () => {
  await assert.rejects(
    resolveJiraContext(jira([]), JSON.stringify({ Nonesuch: "tag:x" })),
    /unknown Jira field "Nonesuch"/,
  );
});
