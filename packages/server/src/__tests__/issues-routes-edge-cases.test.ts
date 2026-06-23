/**
 * Edge-case integration tests for routes/issues.ts and routes/issue-export-import.ts
 * Exercises comment CRUD, activity, AI-touched files, time entries, and CSV/JSON
 * import/export against a real test DB via Hono app.request().
 *
 * NOTE: drizzle-orm's db.transaction() with libsql :memory: databases creates a
 * new connection per transaction — which is a new empty database. Tests exercising
 * transactional endpoints (batch, import) use a temp-file DB instead.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import * as schema from "@agentic-kanban/shared/schema";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { applyMigrationsToClient } from "./helpers/test-db.js";
import { createIssuesRoute } from "../routes/issues.js";
import { createIssueExportImportRoute } from "../routes/issue-export-import.js";
import { createTagsRoute } from "../routes/tags.js";
import { createPreferencesRoute } from "../routes/preferences.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type DbAndApp = { app: Hono; db: TestDb; cleanup?: () => void };

/** In-memory DB — fine for non-transactional tests. */
function memorySetup(): DbAndApp {
  const { db } = createTestDb();
  const app = new Hono();
  app.route("/api/issues", createIssuesRoute(db));
  app.route("/api/projects", createIssueExportImportRoute(db));
  app.route("/api/tags", createTagsRoute(db));
  app.route("/api/preferences", createPreferencesRoute(db));
  return { app, db };
}

/**
 * Temp-file DB — required for transactional tests (batch, import).
 * drizzle's libsql transaction() opens a new connection; :memory: DBs are
 * per-connection, so the post-tx query hits an empty database.
 * A file-based SQLite doesn't have this problem.
 */
function fileSetup(): DbAndApp {
  const dbPath = join(tmpdir(), `test-issues-${randomUUID()}.db`);
  const client = createClient({ url: `file:${dbPath}` });
  applyMigrationsToClient(client);
  const db = drizzle(client, { schema }) as TestDb;
  const app = new Hono();
  app.route("/api/issues", createIssuesRoute(db));
  app.route("/api/projects", createIssueExportImportRoute(db));
  app.route("/api/tags", createTagsRoute(db));
  app.route("/api/preferences", createPreferencesRoute(db));
  return {
    app, db,
    cleanup: () => { try { unlinkSync(dbPath); } catch {} },
  };
}

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

async function seedIssue(db: TestDb, projectId: string, statusId: string, overrides?: Partial<typeof schema.issues.$inferInsert>) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(schema.issues).values({
    id, issueNumber: overrides?.issueNumber ?? 1, title: overrides?.title ?? "Test Issue",
    statusId, projectId, createdAt: now, updatedAt: now, ...overrides,
  });
  return id;
}

async function fullSeed(db: TestDb) {
  const projectId = await seedProject(db);
  const backlogId = await seedStatus(db, projectId, "Backlog", 0);
  const inProgressId = await seedStatus(db, projectId, "In Progress", 1);
  const doneId = await seedStatus(db, projectId, "Done", 2);
  const issueId = await seedIssue(db, projectId, inProgressId);
  return { projectId, backlogId, inProgressId, doneId, issueId };
}

/** JSON request helper. */
function json(method: string, body: unknown) {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

// ---------------------------------------------------------------------------
// Comments edge cases (in-memory, no transactions)
// ---------------------------------------------------------------------------

describe("Issues route — comments edge cases", () => {
  const { app, db } = memorySetup();
  let ids: Awaited<ReturnType<typeof fullSeed>>;

  beforeEach(async () => { ids = await fullSeed(db); });

  it("POST comment requires body text", async () => {
    const res = await app.request(`/api/issues/${ids.issueId}/comments`, json("POST", { body: "" }));
    expect(res.status).toBe(400);
  });

  it("POST comment defaults kind/author when omitted or invalid", async () => {
    const r1 = await app.request(`/api/issues/${ids.issueId}/comments`, json("POST", { body: "no kind" }));
    expect(r1.status).toBe(201);
    const j1 = await r1.json();
    expect(j1.kind).toBe("note");
    expect(j1.author).toBe("user");

    const r2 = await app.request(`/api/issues/${ids.issueId}/comments`, json("POST", { body: "bad kind", kind: "bogus" }));
    expect((await r2.json()).kind).toBe("note");

    const r3 = await app.request(`/api/issues/${ids.issueId}/comments`, json("POST", { body: "bad author", author: "hacker" }));
    expect((await r3.json()).author).toBe("user");
  });

  it("POST comment accepts all valid kinds and authors", async () => {
    const kinds = ["preflight-clarification", "agent-question", "merge-attempt", "note"] as const;
    const authors = ["user", "butler", "agent", "preflight", "system"] as const;
    for (const kind of kinds) {
      for (const author of authors) {
        const res = await app.request(`/api/issues/${ids.issueId}/comments`, json("POST", { body: `${kind}-${author}`, kind, author }));
        expect(res.status).toBe(201);
      }
    }
    const list = await (await app.request(`/api/issues/${ids.issueId}/comments`)).json();
    expect(list.comments).toHaveLength(kinds.length * authors.length);
  });

  it("POST comment persists payload as JSON", async () => {
    const payload = { toolUseId: "tu-1", answers: [{ q: "a?" }] };
    const res = await app.request(`/api/issues/${ids.issueId}/comments`, json("POST", { body: "with payload", kind: "agent-question", payload }));
    expect((await res.json()).payload).toEqual(payload);
  });

  it("GET comments returns empty array for issue with no comments", async () => {
    const res = await app.request(`/api/issues/${ids.issueId}/comments`);
    expect((await res.json()).comments).toEqual([]);
  });

  it("DELETE comment removes the comment", async () => {
    const { id } = await (await app.request(`/api/issues/${ids.issueId}/comments`, json("POST", { body: "gone" }))).json();
    await app.request(`/api/issues/${ids.issueId}/comments/${id}`, { method: "DELETE" });
    expect((await (await app.request(`/api/issues/${ids.issueId}/comments`)).json()).comments).toHaveLength(0);
  });

  it("DELETE non-existent comment is idempotent", async () => {
    expect((await app.request(`/api/issues/${ids.issueId}/comments/${randomUUID()}`, { method: "DELETE" })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Activity / status-history edge cases (in-memory, no transactions)
// ---------------------------------------------------------------------------

describe("Issues route — activity edge cases", () => {
  const { app, db } = memorySetup();
  let ids: Awaited<ReturnType<typeof fullSeed>>;

  beforeEach(async () => { ids = await fullSeed(db); });

  it("GET activity returns 404 for unknown issue", async () => {
    expect((await app.request(`/api/issues/${randomUUID()}/activity`)).status).toBe(404);
  });

  it("GET activity for fresh issue has issue_created event", async () => {
    const json = await (await app.request(`/api/issues/${ids.issueId}/activity`)).json();
    expect(json.events.map((e: any) => e.type)).toContain("issue_created");
  });

  it("GET activity includes workspace + session events", async () => {
    const wsId = randomUUID();
    await db.insert(schema.workspaces).values({
      id: wsId, issueId: ids.issueId, branch: "feature/test", status: "merged",
      createdAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      updatedAt: new Date().toISOString(), mergedAt: new Date().toISOString(),
    });
    await db.insert(schema.sessions).values({
      id: randomUUID(), workspaceId: wsId, executor: "claude-code", status: "completed",
      startedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      endedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), exitCode: "0",
    });
    const { events } = await (await app.request(`/api/issues/${ids.issueId}/activity`)).json();
    const types = events.map((e: any) => e.type);
    expect(types).toContain("workspace_created");
    expect(types).toContain("session_completed");
  });

  it("GET cycle-time returns 404 for unknown issue", async () => {
    expect((await app.request(`/api/issues/${randomUUID()}/cycle-time`)).status).toBe(404);
  });

  it("GET cycle-time returns result for existing issue", async () => {
    const res = await (await app.request(`/api/issues/${ids.issueId}/cycle-time`)).json();
    expect(res).toHaveProperty("statusBreakdowns");
  });
});

// ---------------------------------------------------------------------------
// AI-touched files edge cases (in-memory, no transactions)
// ---------------------------------------------------------------------------

describe("Issues route — touched files edge cases", () => {
  const { app, db } = memorySetup();
  let ids: Awaited<ReturnType<typeof fullSeed>>;

  beforeEach(async () => { ids = await fullSeed(db); });

  it("GET touched-files returns 404 for unknown issue", async () => {
    expect((await app.request(`/api/issues/${randomUUID()}/touched-files`)).status).toBe(404);
  });

  it("GET touched-files returns empty files for no prediction", async () => {
    const { files, cached } = await (await app.request(`/api/issues/${ids.issueId}/touched-files`)).json();
    expect(files).toEqual([]);
    expect(cached).toBe(true);
  });

  it("GET touched-files returns parsed files from touchedFilesJson", async () => {
    const files = [{ path: "src/a.ts", reason: "main", confidence: "high" }];
    await db.update(schema.issues).set({ touchedFilesJson: JSON.stringify(files) }).where(eq(schema.issues.id, ids.issueId));
    expect((await (await app.request(`/api/issues/${ids.issueId}/touched-files`)).json()).files).toEqual(files);
  });

  it("GET touched-files handles malformed JSON gracefully", async () => {
    await db.update(schema.issues).set({ touchedFilesJson: "not-json{{}" }).where(eq(schema.issues.id, ids.issueId));
    expect((await (await app.request(`/api/issues/${ids.issueId}/touched-files`)).json()).files).toEqual([]);
  });

  it("GET related-issues returns 404 for unknown issue", async () => {
    expect((await app.request(`/api/issues/${randomUUID()}/related-issues`)).status).toBe(404);
  });

  it("GET related-issues finds overlapping files", async () => {
    await db.update(schema.issues).set({ touchedFilesJson: JSON.stringify([{ path: "src/shared.ts" }]) }).where(eq(schema.issues.id, ids.issueId));
    const i2 = randomUUID();
    await db.insert(schema.issues).values({ id: i2, issueNumber: 2, title: "R", statusId: ids.inProgressId, projectId: ids.projectId, touchedFilesJson: JSON.stringify([{ path: "src/shared.ts" }]) });
    const { related } = await (await app.request(`/api/issues/${ids.issueId}/related-issues`)).json();
    expect(related).toHaveLength(1);
    expect(related[0].sharedFileCount).toBe(1);
  });

  it("GET related-issues handles malformed JSON on candidates", async () => {
    await db.update(schema.issues).set({ touchedFilesJson: JSON.stringify([{ path: "a.ts" }]) }).where(eq(schema.issues.id, ids.issueId));
    await db.insert(schema.issues).values({ id: randomUUID(), issueNumber: 2, title: "M", statusId: ids.inProgressId, projectId: ids.projectId, touchedFilesJson: "bad" });
    expect((await (await app.request(`/api/issues/${ids.issueId}/related-issues`)).json()).related).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Time entries edge cases (in-memory, no transactions)
// ---------------------------------------------------------------------------

describe("Issues route — time entries edge cases", () => {
  const { app, db } = memorySetup();
  let ids: Awaited<ReturnType<typeof fullSeed>>;

  beforeEach(async () => { ids = await fullSeed(db); });

  it("rejects negative minutes", async () => {
    expect((await app.request(`/api/issues/${ids.issueId}/time-entries`, json("POST", { minutes: -5 }))).status).toBe(400);
  });

  it("rejects zero minutes", async () => {
    expect((await app.request(`/api/issues/${ids.issueId}/time-entries`, json("POST", { minutes: 0 }))).status).toBe(400);
  });

  it("rejects non-integer minutes", async () => {
    expect((await app.request(`/api/issues/${ids.issueId}/time-entries`, json("POST", { minutes: 1.5 }))).status).toBe(400);
  });

  it("round-trips valid minutes", async () => {
    const res = await app.request(`/api/issues/${ids.issueId}/time-entries`, json("POST", { minutes: 30, note: "Hi" }));
    expect(res.status).toBe(201);
    const entry = await res.json();
    expect(entry.minutes).toBe(30);
    expect(entry.note).toBe("Hi");
    const list = await (await app.request(`/api/issues/${ids.issueId}/time-entries`)).json();
    expect(list.entries).toHaveLength(1);
    expect(list.totalMinutes).toBe(30);
  });

  it("defaults note to null", async () => {
    expect((await (await app.request(`/api/issues/${ids.issueId}/time-entries`, json("POST", { minutes: 15 }))).json()).note).toBeNull();
  });

  it("DELETE removes the entry", async () => {
    const { id } = await (await app.request(`/api/issues/${ids.issueId}/time-entries`, json("POST", { minutes: 45 }))).json();
    await app.request(`/api/issues/${ids.issueId}/time-entries/${id}`, { method: "DELETE" });
    const list = await (await app.request(`/api/issues/${ids.issueId}/time-entries`)).json();
    expect(list.entries).toHaveLength(0);
    expect(list.totalMinutes).toBe(0);
  });

  it("aggregates multiple entries", async () => {
    await app.request(`/api/issues/${ids.issueId}/time-entries`, json("POST", { minutes: 10 }));
    await app.request(`/api/issues/${ids.issueId}/time-entries`, json("POST", { minutes: 20 }));
    const list = await (await app.request(`/api/issues/${ids.issueId}/time-entries`)).json();
    expect(list.entries).toHaveLength(2);
    expect(list.totalMinutes).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Transactional issue deletion (file-based — DELETE cascade runs in a tx)
// arch-review #879: HTTP DELETE must cascade ALL direct child tables, including
// issue_time_entries, atomically — same single shared implementation as CLI/MCP.
// ---------------------------------------------------------------------------

describe("Issues route — DELETE cascade includes time entries", () => {
  const { app, db, cleanup } = fileSetup();
  let ids: Awaited<ReturnType<typeof fullSeed>>;

  beforeEach(async () => { ids = await fullSeed(db); });
  afterEach(() => { cleanup?.(); });

  it("DELETE /:id removes issue_time_entries (regression: forked cascade missed them)", async () => {
    // Seed a time entry via the HTTP endpoint so it lands like a real one.
    const post = await app.request(`/api/issues/${ids.issueId}/time-entries`, json("POST", { minutes: 25, note: "work" }));
    expect(post.status).toBe(201);

    const before = await db.select().from(schema.issueTimeEntries).where(eq(schema.issueTimeEntries.issueId, ids.issueId));
    expect(before).toHaveLength(1);

    const del = await app.request(`/api/issues/${ids.issueId}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    // Issue gone…
    const issueRows = await db.select().from(schema.issues).where(eq(schema.issues.id, ids.issueId));
    expect(issueRows).toHaveLength(0);
    // …and its time entries gone with it. Before the fix the non-cascading FK
    // either orphaned these rows or made the delete FK-fail mid-cascade.
    const after = await db.select().from(schema.issueTimeEntries).where(eq(schema.issueTimeEntries.issueId, ids.issueId));
    expect(after).toHaveLength(0);
  });

  it("DELETE /:id cascades every direct child table atomically", async () => {
    // A comment, a tag link, a showdown, a workspace + session, and a dependency
    // edge in both directions — every table the cascade must clear.
    const commentRes = await app.request(`/api/issues/${ids.issueId}/comments`, json("POST", { body: "c" }));
    expect(commentRes.status).toBe(201);
    await app.request(`/api/issues/${ids.issueId}/time-entries`, json("POST", { minutes: 5 }));

    const otherIssueId = await seedIssue(db, ids.projectId, ids.inProgressId, { issueNumber: 2, title: "Other" });
    await db.insert(schema.issueDependencies).values({
      id: randomUUID(), issueId: ids.issueId, dependsOnId: otherIssueId,
      type: "depends_on", createdAt: new Date().toISOString(),
    });

    const tagId = randomUUID();
    await db.insert(schema.tags).values({ id: tagId, name: "t", color: null, createdAt: new Date().toISOString() });
    await db.insert(schema.issueTags).values({ id: randomUUID(), issueId: ids.issueId, tagId });

    await db.insert(schema.showdowns).values({
      id: randomUUID(), issueId: ids.issueId,
      status: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    const wsId = randomUUID();
    await db.insert(schema.workspaces).values({
      id: wsId, issueId: ids.issueId, branch: "feature/del", status: "idle",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await db.insert(schema.sessions).values({
      id: randomUUID(), workspaceId: wsId, executor: "claude-code", status: "completed",
      createdAt: new Date().toISOString(),
    });

    const del = await app.request(`/api/issues/${ids.issueId}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    // The issue and every directly-referencing row are gone; nothing orphaned.
    expect(await db.select().from(schema.issues).where(eq(schema.issues.id, ids.issueId))).toHaveLength(0);
    expect(await db.select().from(schema.issueTimeEntries).where(eq(schema.issueTimeEntries.issueId, ids.issueId))).toHaveLength(0);
    expect(await db.select().from(schema.issueComments).where(eq(schema.issueComments.issueId, ids.issueId))).toHaveLength(0);
    expect(await db.select().from(schema.issueTags).where(eq(schema.issueTags.issueId, ids.issueId))).toHaveLength(0);
    expect(await db.select().from(schema.showdowns).where(eq(schema.showdowns.issueId, ids.issueId))).toHaveLength(0);
    expect(await db.select().from(schema.issueDependencies).where(eq(schema.issueDependencies.issueId, ids.issueId))).toHaveLength(0);
    expect(await db.select().from(schema.workspaces).where(eq(schema.workspaces.issueId, ids.issueId))).toHaveLength(0);
    expect(await db.select().from(schema.sessions).where(eq(schema.sessions.workspaceId, wsId))).toHaveLength(0);
    // The dependency target issue is untouched.
    expect(await db.select().from(schema.issues).where(eq(schema.issues.id, otherIssueId))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Issue CRUD edge cases (file-based, supports transactions)
// ---------------------------------------------------------------------------

describe("Issues route — CRUD edge cases", () => {
  const { app, db, cleanup } = fileSetup();
  let ids: Awaited<ReturnType<typeof fullSeed>>;

  beforeEach(async () => { ids = await fullSeed(db); });
  afterEach(() => { cleanup?.(); });

  it("GET / requires projectId", async () => {
    expect((await app.request("/api/issues")).status).toBe(400);
  });

  it("GET / filters by statusName", async () => {
    const json = await (await app.request(`/api/issues?projectId=${ids.projectId}&statusName=In Progress`)).json();
    expect(json).toHaveLength(1);
  });

  it("GET / returns empty for non-existent status", async () => {
    expect(await (await app.request(`/api/issues?projectId=${ids.projectId}&statusName=Nope`)).json()).toEqual([]);
  });

  it("POST / requires projectId", async () => {
    expect((await app.request("/api/issues", json("POST", { title: "X" }))).status).toBe(400);
  });

  it("POST / requires title", async () => {
    expect((await app.request("/api/issues", json("POST", { projectId: ids.projectId }))).status).toBe(400);
  });

  it("POST / rejects whitespace title", async () => {
    expect((await app.request("/api/issues", json("POST", { projectId: ids.projectId, title: "   " }))).status).toBe(400);
  });

  it("POST / creates issue and returns 201", async () => {
    const res = await app.request("/api/issues", json("POST", { projectId: ids.projectId, title: "New", priority: "high" }));
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.title).toBe("New");
    expect(j.priority).toBe("high");
  });

  it("GET /:id returns 404 for unknown issue", async () => {
    expect((await app.request(`/api/issues/${randomUUID()}`)).status).toBe(404);
  });

  it("PATCH /:id updates fields", async () => {
    const j = await (await app.request(`/api/issues/${ids.issueId}`, json("PATCH", { title: "Upd", priority: "critical" }))).json();
    expect(j.title).toBe("Upd");
    expect(j.priority).toBe("critical");
  });

  it("DELETE /:id removes the issue", async () => {
    expect((await app.request(`/api/issues/${ids.issueId}`, { method: "DELETE" })).status).toBe(200);
    expect((await app.request(`/api/issues/${ids.issueId}`)).status).toBe(404);
  });

  it("POST /batch creates multiple issues", async () => {
    const res = await app.request("/api/issues/batch", json("POST", { projectId: ids.projectId, issues: [{ title: "A" }, { title: "B" }] }));
    expect(res.status).toBe(201);
    expect((await res.json()).issues).toHaveLength(2);
  });

  it("POST /batch requires issues array", async () => {
    expect((await app.request("/api/issues/batch", json("POST", { projectId: ids.projectId }))).status).toBe(400);
  });

  it("POST /:id/duplicate creates a copy", async () => {
    const j = await (await app.request(`/api/issues/${ids.issueId}/duplicate`, { method: "POST" })).json();
    expect(j.title).toContain("Test Issue");
    expect(j.id).not.toBe(ids.issueId);
  });
});

// ---------------------------------------------------------------------------
// Issue export/import edge cases (file-based, supports transactions)
// ---------------------------------------------------------------------------

describe("Issues route — export/import edge cases", () => {
  const { app, db, cleanup } = fileSetup();
  let ids: Awaited<ReturnType<typeof fullSeed>>;

  beforeEach(async () => { ids = await fullSeed(db); });
  afterEach(() => { cleanup?.(); });

  it("GET export returns JSON array", async () => {
    const res = await app.request(`/api/projects/${ids.projectId}/issues/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].title).toBe("Test Issue");
  });

  it("GET export with format=csv returns CSV", async () => {
    const res = await app.request(`/api/projects/${ids.projectId}/issues/export?format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    const lines = (await res.text()).split("\n").filter((l) => l.trim());
    expect(lines.length).toBe(2); // header + 1 row
    expect(lines[0]).toContain("number,title");
  });

  it("GET export rejects invalid format", async () => {
    expect((await app.request(`/api/projects/${ids.projectId}/issues/export?format=xml`)).status).toBe(400);
  });

  it("GET export escapes CSV special characters", async () => {
    await app.request("/api/issues", json("POST", { projectId: ids.projectId, title: 'He said "hello", then left', description: "Line1\nLine2" }));
    const text = await (await app.request(`/api/projects/${ids.projectId}/issues/export?format=csv`)).text();
    expect(text).toContain('""hello""');
  });

  it("POST import rejects unsupported Content-Type", async () => {
    expect((await app.request(`/api/projects/${ids.projectId}/issues/import`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" })).status).toBe(400);
  });

  it("POST import creates issues from JSON array", async () => {
    const before = (await (await app.request(`/api/issues?projectId=${ids.projectId}`)).json()).length;
    const res = await app.request(`/api/projects/${ids.projectId}/issues/import`, json("POST", [{ title: "Imp A" }, { title: "Imp B", priority: "high", type: "bug" }]));
    expect(res.status).toBe(201);
    expect((await res.json()).created).toBe(2);
    expect((await (await app.request(`/api/issues?projectId=${ids.projectId}`)).json()).length).toBe(before + 2);
  });

  it("POST import with empty array returns 201 with zero created", async () => {
    const res = await app.request(`/api/projects/${ids.projectId}/issues/import`, json("POST", []));
    // Empty array is valid JSON but has no rows — returns 201 with created:0
    expect(res.status).toBe(201);
    expect((await res.json()).created).toBe(0);
  });

  it("POST import skips rows with empty title", async () => {
    const j = await (await app.request(`/api/projects/${ids.projectId}/issues/import`, json("POST", [{ title: "V" }, { title: "" }, { title: "W" }]))).json();
    expect(j.created).toBe(2);
    expect(j.parseErrors.length).toBeGreaterThanOrEqual(1);
  });

  it("POST import skips duplicate titles", async () => {
    const j = await (await app.request(`/api/projects/${ids.projectId}/issues/import`, json("POST", [{ title: "Dup" }, { title: "Dup" }]))).json();
    expect(j.created).toBe(1);
    expect(j.skipped).toBe(1);
    expect(j.skippedRows[0].reason).toContain("duplicate");
  });

  it("POST import defaults invalid priority/type", async () => {
    const res = await app.request(`/api/projects/${ids.projectId}/issues/import`, json("POST", [{ title: "Def", priority: "mega", type: "super" }]));
    const resJson = await res.json() as any;
    // present-but-invalid values default to medium/feature and surface a warning.
    expect(resJson.warnings).toHaveLength(2);
    const list = await (await app.request(`/api/issues?projectId=${ids.projectId}`)).json();
    const imported = list.find((i: any) => i.title === "Def");
    expect(imported.priority).toBe("medium");
    expect(imported.issueType).toBe("feature");
  });

  it("POST import reports parse errors for non-object items", async () => {
    expect((await app.request(`/api/projects/${ids.projectId}/issues/import`, json("POST", [42, null, "str"]))).status).toBe(400);
  });

  it("export → import round-trip preserves issue data", async () => {
    const exportData = await (await app.request(`/api/projects/${ids.projectId}/issues/export?format=json`)).json();
    const newPid = await seedProject(db);
    await seedStatus(db, newPid, "Backlog", 0);
    await seedStatus(db, newPid, "In Progress", 1);
    await seedStatus(db, newPid, "Done", 2);
    const importRes = await app.request(`/api/projects/${newPid}/issues/import`, json("POST", exportData));
    expect(importRes.status).toBe(201);
    const list = await (await app.request(`/api/issues?projectId=${newPid}`)).json();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("Test Issue");
  });
});

describe("Markdown + preview import", () => {
  const { app, db, cleanup } = fileSetup();
  let ids: Awaited<ReturnType<typeof fullSeed>>;

  beforeEach(async () => { ids = await fullSeed(db); });
  afterEach(() => { cleanup?.(); });

  it("parses Markdown: one issue per top-level bullet, sub-bullets as description", async () => {
    const md = [
      "# Sprint plan",
      "",
      "- Add login page",
      "  - Needs OAuth",
      "  - Design first",
      "- Fix N+1 queries",
      "* Refactor config",
    ].join("\n");
    const res = await app.request(`/api/projects/${ids.projectId}/issues/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: md, format: "markdown" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.created).toBe(3);
    const list = await (await app.request(`/api/issues?projectId=${ids.projectId}`)).json();
    const login = list.find((i: any) => i.title === "Add login page");
    expect(login.description).toBe("Needs OAuth\nDesign first");
    // Markdown rows default to medium / feature.
    expect(login.priority).toBe("medium");
    expect(login.issueType).toBe("feature");
  });

  it("preview parses without persisting and returns resolved rows", async () => {
    const csv = "title,priority,type\nA,high,bug\nB,,\n";
    const res = await app.request(`/api/projects/${ids.projectId}/issues/import/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: csv, format: "auto" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.format).toBe("csv");
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toMatchObject({ title: "A", priority: "high", issueType: "bug" });
    // Row B omits priority/type → defaulted silently (no warning), medium/feature.
    expect(body.rows[1]).toMatchObject({ title: "B", priority: "medium", issueType: "feature" });
    expect(body.warnings).toHaveLength(0);
    // Nothing persisted.
    const before = (await (await app.request(`/api/issues?projectId=${ids.projectId}`)).json()).length;
    expect(before).toBe(1); // only the seeded issue
  });

  it("preview surfaces per-row warnings and skips (does not abort)", async () => {
    const md = [
      "- Good one",
      "- Good two",
      "- Good one", // duplicate → skipped
      "- Bad value",
    ].join("\n");
    const res = await app.request(`/api/projects/${ids.projectId}/issues/import/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `${md}\n`, format: "markdown" }),
    });
    const body = await res.json() as any;
    expect(body.format).toBe("markdown");
    expect(body.rows.map((r: any) => r.title)).toEqual(["Good one", "Good two", "Bad value"]);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0].reason).toContain("duplicate");
  });

  it("auto-detects format: JSON array → json, bullets → markdown, else csv", async () => {
    const jsonRes = await app.request(`/api/projects/${ids.projectId}/issues/import/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: '[{"title":"X"}]', format: "auto" }),
    });
    expect((await jsonRes.json() as any).format).toBe("json");

    const mdRes = await app.request(`/api/projects/${ids.projectId}/issues/import/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "- An item\n", format: "auto" }),
    });
    expect((await mdRes.json() as any).format).toBe("markdown");

    const csvRes = await app.request(`/api/projects/${ids.projectId}/issues/import/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "title\nOnly a title\n", format: "auto" }),
    });
    expect((await csvRes.json() as any).format).toBe("csv");
  });

  it("imported issues land in the default (Backlog) status", async () => {
    const res = await app.request(`/api/projects/${ids.projectId}/issues/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "title,type\nNew One,feature\n", format: "csv" }),
    });
    expect(res.status).toBe(201);
    const list = await (await app.request(`/api/issues?projectId=${ids.projectId}`)).json();
    const imported = list.find((i: any) => i.title === "New One");
    expect(imported.statusName).toBe("Backlog");
  });
});
