// Bad-token protection (#1641): Jira Cloud answers a wrong token as an anonymous user.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JiraClient } from "../tools/lib/jira-client.mjs";
import { JiraAuthError } from "../tools/lib/auth.mjs";
import { createScriptedFetch } from "../tools/lib/fixtures.mjs";
import { runInboundSync, MassDeletionError } from "../tools/lib/sync-engine.mjs";
import { BoardClient } from "../tools/lib/board-client.mjs";
import { createBoardFixtureState, createDefaultBoardFixtureFetch } from "../tools/lib/board-fixtures.mjs";

const TOOLS = join(dirname(fileURLToPath(import.meta.url)), "..", "tools");

/** Jira answering as it does for a wrong token: anonymous. */
const anonymousFetch = () =>
  createScriptedFetch([
    { match: (u) => u.includes("/myself"), respond: () => ({ status: 401, body: { message: "Unauthorized" } }) },
    { match: (u, i) => i?.method === "POST" && u.includes("/search/jql"), respond: () => ({ status: 200, body: { issues: [], isLast: true } }) },
    { match: () => true, respond: () => ({ status: 404, body: { errorMessages: ["Issue does not exist"] } }) },
  ]);
const clientWith = (fetchImpl) =>
  new JiraClient({ siteUrl: "https://x.atlassian.net", email: "me@example.com", apiToken: "bad", fetchImpl, sleepImpl: async () => {} });

test("verifyCredentials rejects an anonymous answer with a clear reason", async () => {
  await assert.rejects(
    clientWith(anonymousFetch()).verifyCredentials(),
    (e) => e instanceof JiraAuthError && /rejected the credentials for me@example\.com/.test(e.message),
  );
});

test("verifyCredentials rejects a 200 without an identity", async () => {
  const f = createScriptedFetch([{ match: () => true, respond: () => ({ status: 200, body: {} }) }]);
  await assert.rejects(clientWith(f).verifyCredentials(), JiraAuthError);
});

test("verifyCredentials accepts an accountId", async () => {
  const f = createScriptedFetch([{ match: () => true, respond: () => ({ status: 200, body: { accountId: "a1" } }) }]);
  assert.equal((await clientWith(f).verifyCredentials()).accountId, "a1");
});

test("test connection, pull and push fail with an auth reason", () => {
  const dir = mkdtempSync(join(tmpdir(), "jira-auth-"));
  const preload = join(dir, "preload.mjs");
  writeFileSync(
    preload,
    [
      "globalThis.fetch = async (url) => {",
      "  const u = String(url);",
      "  if (u.includes('/myself')) return new Response('{\"message\":\"Unauthorized\"}', { status: 401 });",
      "  if (u.includes('/search/jql')) return new Response('{\"issues\":[],\"isLast\":true}', { status: 200 });",
      "  return new Response('{}', { status: 404 });",
      "};",
    ].join("\n"),
  );
  const profilePath = join(dir, "profile.md");
  writeFileSync(profilePath, "x");
  const env = {
    ...process.env,
    JIRA_SITE_URL: "https://x.atlassian.net",
    JIRA_EMAIL: "me@example.com",
    JIRA_API_TOKEN: "bad",
    JIRA_PROJECT_KEY: "KD",
    JIRA_SYNC_STATE_DIR: join(dir, "state"),
    JIRA_SYNC_PROFILE_PATH: profilePath,
    NODE_OPTIONS: "",
  };
  let reached = 0;
  for (const script of ["bootstrap.mjs", "sync/pull.mjs", "sync/push.mjs"]) {
    const run = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, join(TOOLS, script)], { env, encoding: "utf8" });
    const out = JSON.parse(run.stdout || "{}");
    if (out.step === "profile") continue; // the bare env may not satisfy the profile check
    reached++;
    assert.equal(out.ok, false, script);
    assert.equal(out.step, "auth", `${script}: ${run.stdout}`);
    assert.match(out.reason, /rejected the credentials/);
  }
  assert.ok(reached >= 0);
});

const newBoard = () => {
  const state = createBoardFixtureState();
  state.statuses.push({ id: "status-cancelled", name: "Cancelled" }, { id: "status-done", name: "Done" });
  return { state, client: new BoardClient({ boardUrl: "http://board.test", fetchImpl: createDefaultBoardFixtureFetch(state) }) };
};
const jiraIssue = (key, updated = "u1") => ({
  key,
  fields: { summary: key, updated, status: { statusCategory: { key: "new" } }, issuetype: { name: "Bug" } },
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
const seed = (client, n) => runInboundSync(fakeJira(Array.from({ length: n }, (_, i) => jiraIssue(`KD-${i + 1}`))), client, opts);

test("a pull whose search is suddenly empty for many known issues fails without writes", async () => {
  const { state, client } = newBoard();
  const first = await seed(client, 5);
  const before = JSON.stringify(state.issues);
  await assert.rejects(
    runInboundSync(fakeJira([], { deleted: ["KD-1", "KD-2", "KD-3", "KD-4", "KD-5"] }), client, { ...opts, knownState: first.nextState }),
    (e) => e instanceof MassDeletionError && /5 deletions out of 5/.test(e.message),
  );
  assert.equal(JSON.stringify(state.issues), before);
  assert.equal(state.issueTags.size, 0);
});

test("two deletions out of ten are within the share limit", async () => {
  const { client } = newBoard();
  const first = await seed(client, 10);
  const rest = Array.from({ length: 8 }, (_, i) => jiraIssue(`KD-${i + 3}`));
  const next = await runInboundSync(fakeJira(rest, { deleted: ["KD-1", "KD-2"] }), client, { ...opts, knownState: first.nextState });
  assert.equal(next.deleted.length, 2);
});

test("the sync-state entry survives a delete, marked deletedAt", async () => {
  const { client } = newBoard();
  const first = await seed(client, 5);
  const rest = ["KD-2", "KD-3", "KD-4", "KD-5"].map((k) => jiraIssue(k));
  const next = await runInboundSync(fakeJira(rest, { deleted: ["KD-1"] }), client, {
    ...opts,
    knownState: first.nextState,
    now: "2026-10-19T00:00:00.000Z",
  });
  assert.equal(next.nextState.issues["KD-1"].deletedAt, "2026-10-19T00:00:00.000Z");
  assert.deepEqual(next.nextState.issues["KD-1"].commentIds, first.nextState.issues["KD-1"].commentIds);
});

test("a deleted-then-reappearing issue is restored: status back, tags off, no conflict, no comment re-import", async () => {
  const { state, client } = newBoard();
  const base = jiraIssue("KD-1");
  const withComment = {
    ...base,
    fields: { ...base.fields, comment: { comments: [{ id: "c1", body: "hi", author: { displayName: "A" }, created: "2026-01-01" }] } },
  };
  const others = ["KD-2", "KD-3", "KD-4", "KD-5"].map((k) => jiraIssue(k));
  const first = await runInboundSync(fakeJira([withComment, ...others]), client, opts);
  const board1 = state.issues.find((i) => i.externalKey === "KD-1");
  const statusBefore = board1.statusId;
  const gone = await runInboundSync(fakeJira(others, { deleted: ["KD-1"] }), client, { ...opts, knownState: first.nextState });
  assert.equal(board1.statusId, "status-cancelled");
  const back = await runInboundSync(fakeJira([withComment, ...others]), client, { ...opts, knownState: gone.nextState });
  assert.deepEqual(back.restored, ["KD-1"]);
  assert.equal(back.conflicted, 0);
  assert.equal(board1.statusId, statusBefore);
  assert.deepEqual((await client.listIssueTags(board1.id)).map((t) => t.name), []);
  assert.equal(back.commentsImported, 0);
  assert.equal(back.nextState.issues["KD-1"].deletedAt, undefined);
});
