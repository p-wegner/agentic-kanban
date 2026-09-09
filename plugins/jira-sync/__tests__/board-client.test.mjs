import { test } from "node:test";
import assert from "node:assert/strict";
import { BoardClient, BoardApiError, BoardConfigError, resolveBoardConfigFromEnv } from "../tools/lib/board-client.mjs";

function fakeFetch(steps) {
  return async (url, init) => {
    const href = typeof url === "string" ? url : url.toString();
    for (const step of steps) {
      if (!step.match(href, init)) continue;
      const { status = 200, body } = step.respond(href, init);
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => (body === undefined ? "" : JSON.stringify(body)),
      };
    }
    throw new Error(`no route matched ${init?.method ?? "GET"} ${href}`);
  };
}

test("resolveBoardConfigFromEnv: requires both BOARD_URL and PROJECT_ID", () => {
  assert.throws(() => resolveBoardConfigFromEnv({}), BoardConfigError);
  assert.throws(
    () => resolveBoardConfigFromEnv({ JIRA_SYNC_BOARD_URL: "https://board.local" }),
    BoardConfigError,
  );
  const config = resolveBoardConfigFromEnv({
    JIRA_SYNC_BOARD_URL: "https://board.local/",
    JIRA_SYNC_BOARD_PROJECT_ID: "proj-1",
  });
  assert.deepEqual(config, { boardUrl: "https://board.local", projectId: "proj-1" });
});

test("createIssue: POSTs to /api/issues and returns the parsed body", async () => {
  let capturedBody;
  const client = new BoardClient({
    boardUrl: "https://board.local",
    fetchImpl: fakeFetch([
      {
        match: (url, init) => init.method === "POST" && url.endsWith("/api/issues"),
        respond: (_url, init) => {
          capturedBody = JSON.parse(init.body);
          return { status: 201, body: { id: "issue-1", ...capturedBody } };
        },
      },
    ]),
  });
  const created = await client.createIssue({ projectId: "p1", title: "x" });
  assert.equal(created.id, "issue-1");
  assert.deepEqual(capturedBody, { projectId: "p1", title: "x" });
});

test("updateIssue: PATCHes /api/issues/:id", async () => {
  const client = new BoardClient({
    boardUrl: "https://board.local",
    fetchImpl: fakeFetch([
      {
        match: (url, init) => init.method === "PATCH" && url.endsWith("/api/issues/issue-1"),
        respond: () => ({ status: 200, body: { id: "issue-1", title: "updated" } }),
      },
    ]),
  });
  const updated = await client.updateIssue("issue-1", { title: "updated" });
  assert.equal(updated.title, "updated");
});

test("a non-ok response throws BoardApiError with the status and body", async () => {
  const client = new BoardClient({
    boardUrl: "https://board.local",
    fetchImpl: fakeFetch([
      {
        match: () => true,
        respond: () => ({ status: 422, body: { error: "Unrecognized field(s)" } }),
      },
    ]),
  });
  await assert.rejects(
    () => client.createIssue({}),
    (err) => {
      assert.ok(err instanceof BoardApiError);
      assert.equal(err.status, 422);
      assert.equal(err.message, "Unrecognized field(s)");
      return true;
    },
  );
});

test("listExternallyTrackedIssues: keys the map by externalKey and drops issues without one", async () => {
  const client = new BoardClient({
    boardUrl: "https://board.local",
    fetchImpl: fakeFetch([
      {
        match: (url) => url.includes("/api/issues?projectId=p1"),
        respond: () => ({
          status: 200,
          body: [
            { id: "i1", externalKey: "ENG-1" },
            { id: "i2", externalKey: null },
          ],
        }),
      },
    ]),
  });
  const byKey = await client.listExternallyTrackedIssues("p1");
  assert.deepEqual([...byKey.keys()], ["ENG-1"]);
});

test("listExternallyTrackedIssues: pages past the 500-item server cap via offset", async () => {
  const pageSize = 500;
  const firstPage = Array.from({ length: pageSize }, (_, i) => ({ id: `i${i}`, externalKey: `ENG-${i}` }));
  const secondPage = [{ id: "i500", externalKey: "ENG-500" }];
  const client = new BoardClient({
    boardUrl: "https://board.local",
    fetchImpl: fakeFetch([
      {
        match: (url) => url.includes("offset=0"),
        respond: () => ({ status: 200, body: firstPage }),
      },
      {
        match: (url) => url.includes(`offset=${pageSize}`),
        respond: () => ({ status: 200, body: secondPage }),
      },
    ]),
  });
  const byKey = await client.listExternallyTrackedIssues("p1");
  assert.equal(byKey.size, pageSize + 1);
  assert.ok(byKey.has("ENG-0"));
  assert.ok(byKey.has("ENG-500"), "the 501st tracked issue must not be dropped by the page cap");
});
