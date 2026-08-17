/**
 * Tests for the opt-in ?slim=1 param on GET /api/issues.
 * slim=1 omits the description field (the bulk of the payload) from every
 * issue in the list; the default response shape is unchanged.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createIssuesRoute } from "../routes/issues.js";

async function seedProject(db: TestDb) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(schema.projects).values({
    id, name: `project-${id.slice(0, 8)}`, repoPath: `/tmp/${id}`,
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  return id;
}

async function seedStatus(db: TestDb, projectId: string, name: string, sortOrder: number) {
  const id = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id, projectId, name, sortOrder, isDefault: sortOrder === 0, createdAt: new Date().toISOString(),
  });
  return id;
}

async function seedIssue(db: TestDb, projectId: string, statusId: string, issueNumber: number, description: string | null) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(schema.issues).values({
    id, issueNumber, title: `Issue ${issueNumber}`, description,
    statusId, projectId, createdAt: now, updatedAt: now, sortOrder: issueNumber,
  });
  return id;
}

describe("GET /api/issues ?slim=1", () => {
  let app: Hono;
  let db: TestDb;
  let projectId: string;
  let statusId: string;

  beforeEach(async () => {
    ({ db } = createTestDb());
    app = new Hono();
    app.route("/api/issues", createIssuesRoute(db));
    projectId = await seedProject(db);
    statusId = await seedStatus(db, projectId, "Backlog", 0);
    await seedIssue(db, projectId, statusId, 1, "A long description that should be omitted in slim mode");
    await seedIssue(db, projectId, statusId, 2, null);
  });

  it("default response still includes description (shape unchanged)", async () => {
    const res = await app.request(`/api/issues?projectId=${projectId}`);
    expect(res.status).toBe(200);
    const list = await res.json() as Record<string, unknown>[];
    expect(list.length).toBe(2);
    const withDesc = list.find(i => i.issueNumber === 1)!;
    expect(withDesc.description).toBe("A long description that should be omitted in slim mode");
    const nullDesc = list.find(i => i.issueNumber === 2)!;
    // Null description stays an explicit null key in the default response
    expect("description" in nullDesc).toBe(true);
    expect(nullDesc.description).toBeNull();
  });

  it("slim=1 omits the description key entirely (absent, not null)", async () => {
    const res = await app.request(`/api/issues?projectId=${projectId}&slim=1`);
    expect(res.status).toBe(200);
    const list = await res.json() as Record<string, unknown>[];
    expect(list.length).toBe(2);
    for (const issue of list) {
      expect("description" in issue).toBe(false);
    }
    // Everything else the picker/list consumers need is still present
    const first = list.find(i => i.issueNumber === 1)!;
    expect(first.id).toBeDefined();
    expect(first.title).toBe("Issue 1");
    expect(first.statusName).toBe("Backlog");
    expect(first.statusId).toBe(statusId);
    expect(first.projectId).toBe(projectId);
  });

  it("slim=1 composes with issueNumber and statusName filters", async () => {
    const res = await app.request(`/api/issues?projectId=${projectId}&issueNumber=1&statusName=Backlog&slim=1`);
    expect(res.status).toBe(200);
    const list = await res.json() as Record<string, unknown>[];
    expect(list.length).toBe(1);
    expect(list[0].issueNumber).toBe(1);
    expect("description" in list[0]).toBe(false);
  });

  // CONTRACT CHANGE (#511). This used to assert that `?slim=true` keeps the FULL response,
  // pinning the old `=== "1"` check. That was describing the implementation, not a
  // requirement: routes were split between `=== "1"` and `=== "true"`, so a client picking
  // the wrong spelling had its flag silently ignored — the request succeeded and the flag
  // just did nothing. `queryFlag` now accepts both, so `?slim=true` IS slim.
  it("accepts either wire spelling for the slim flag", async () => {
    for (const raw of ["1", "true"]) {
      const res = await app.request(`/api/issues?projectId=${projectId}&slim=${raw}`);
      expect(res.status).toBe(200);
      const list = await res.json() as Record<string, unknown>[];
      const issue = list.find(i => i.issueNumber === 1)!;
      expect("description" in issue, `slim=${raw} should omit description`).toBe(false);
    }
  });

  it("keeps the full response for a non-truthy slim value", async () => {
    for (const raw of ["0", "false", ""]) {
      const res = await app.request(`/api/issues?projectId=${projectId}&slim=${raw}`);
      expect(res.status).toBe(200);
      const list = await res.json() as Record<string, unknown>[];
      const withDesc = list.find(i => i.issueNumber === 1)!;
      expect(withDesc.description, `slim=${raw} should keep description`)
        .toBe("A long description that should be omitted in slim mode");
    }
  });
});

describe("GET /api/issues conditional GET (#418)", () => {
  let app: Hono;
  let db: TestDb;
  let projectId: string;
  let statusId: string;

  beforeEach(async () => {
    ({ db } = createTestDb());
    app = new Hono();
    app.route("/api/issues", createIssuesRoute(db));
    projectId = await seedProject(db);
    statusId = await seedStatus(db, projectId, "Backlog", 0);
    await seedIssue(db, projectId, statusId, 1, "big description payload");
  });

  it("serves an ETag and answers 304 with no body when If-None-Match matches", async () => {
    const first = await app.request(`/api/issues?projectId=${projectId}`);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const second = await app.request(`/api/issues?projectId=${projectId}`, {
      headers: { "if-none-match": etag! },
    });
    expect(second.status).toBe(304);
    expect(second.headers.get("etag")).toBe(etag);
    expect(await second.text()).toBe("");
  });

  it("returns 200 with a new ETag once the list changes", async () => {
    const first = await app.request(`/api/issues?projectId=${projectId}`);
    const etag = first.headers.get("etag")!;

    await seedIssue(db, projectId, statusId, 2, "another issue");

    const second = await app.request(`/api/issues?projectId=${projectId}`, {
      headers: { "if-none-match": etag },
    });
    expect(second.status).toBe(200);
    expect(second.headers.get("etag")).not.toBe(etag);
    const list = await second.json() as unknown[];
    expect(list.length).toBe(2);
  });

  it("slim=1 and full responses carry distinct ETags", async () => {
    const full = await app.request(`/api/issues?projectId=${projectId}`);
    const slim = await app.request(`/api/issues?projectId=${projectId}&slim=1`);
    expect(full.headers.get("etag")).not.toBe(slim.headers.get("etag"));
  });
});

describe("GET /api/issues pagination (#424)", () => {
  let app: Hono;
  let db: TestDb;
  let projectId: string;
  let statusId: string;

  beforeEach(async () => {
    ({ db } = createTestDb());
    app = new Hono();
    app.route("/api/issues", createIssuesRoute(db));
    projectId = await seedProject(db);
    statusId = await seedStatus(db, projectId, "Backlog", 0);
    for (let n = 1; n <= 12; n++) await seedIssue(db, projectId, statusId, n, `description ${n}`);
  });

  it("without limit, returns everything and sets NO X-Total-Count (shape unchanged)", async () => {
    const res = await app.request(`/api/issues?projectId=${projectId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBeNull();
    expect(((await res.json()) as unknown[]).length).toBe(12);
  });

  it("limit caps the page and reports the unpaginated total", async () => {
    const res = await app.request(`/api/issues?projectId=${projectId}&limit=5`);
    expect(res.status).toBe(200);
    // The header is the whole point of the feature and is easy to lose: a header set on a
    // hand-constructed Response does NOT survive Hono's raw-Response adoption, which
    // silently swallowed it during development. Assert it explicitly.
    expect(res.headers.get("x-total-count")).toBe("12");
    expect(((await res.json()) as unknown[]).length).toBe(5);
  });

  it("offset walks disjoint pages that reassemble into the full ordered list", async () => {
    const seen: number[] = [];
    for (let offset = 0; offset < 12; offset += 5) {
      const res = await app.request(`/api/issues?projectId=${projectId}&limit=5&offset=${offset}`);
      const page = (await res.json()) as Array<{ issueNumber: number }>;
      seen.push(...page.map((i) => i.issueNumber));
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(new Set(seen).size).toBe(12);
  });

  it("clamps an oversized limit instead of rejecting it", async () => {
    const res = await app.request(`/api/issues?projectId=${projectId}&limit=99999`);
    expect(res.status).toBe(200);
    // Fewer issues exist than the cap, so this asserts the request is SERVED, not 400'd.
    expect(((await res.json()) as unknown[]).length).toBe(12);
  });

  it("ignores a junk or non-positive limit and falls back to the full list", async () => {
    for (const bad of ["abc", "0", "-5", ""]) {
      const res = await app.request(`/api/issues?projectId=${projectId}&limit=${bad}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-total-count")).toBeNull();
      expect(((await res.json()) as unknown[]).length).toBe(12);
    }
  });

  it("offset without limit is ignored rather than silently returning a partial list", async () => {
    const res = await app.request(`/api/issues?projectId=${projectId}&offset=5`);
    expect(((await res.json()) as unknown[]).length).toBe(12);
  });

  it("composes with slim and keeps conditional GET working", async () => {
    const res = await app.request(`/api/issues?projectId=${projectId}&slim=1&limit=4`);
    const page = (await res.json()) as Record<string, unknown>[];
    expect(page.length).toBe(4);
    for (const issue of page) expect("description" in issue).toBe(false);
    expect(res.headers.get("x-total-count")).toBe("12");

    const etag = res.headers.get("etag")!;
    const again = await app.request(`/api/issues?projectId=${projectId}&slim=1&limit=4`, {
      headers: { "if-none-match": etag },
    });
    expect(again.status).toBe(304);
  });
});
