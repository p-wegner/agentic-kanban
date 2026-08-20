import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { getProjectActivity } from "../services/project-activity.service.js";

let db: TestDb;
let client: ReturnType<typeof createTestDb>["client"];
let projectId: string;
let statusId: string;

beforeAll(async () => {
  const testDb = createTestDb();
  db = testDb.db;
  client = testDb.client;

  const now = new Date().toISOString();
  projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name: "Test Project",
    repoPath: "/tmp/test",
    repoName: "test",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  statusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: statusId,
    projectId,
    name: "Done",
    sortOrder: 1,
    isDefault: false,
    createdAt: now,
  });

  const issueId = randomUUID();
  await db.insert(schema.issues).values({
    id: issueId,
    issueNumber: 1,
    title: "Test Issue",
    statusId,
    projectId,
    createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    updatedAt: now,
    statusChangedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  });
});

describe("getProjectActivity", () => {
  it("returns events for the project", async () => {
    const result = await getProjectActivity(projectId, db);
    expect(result.events.length).toBeGreaterThan(0);
    const created = result.events.find((e) => e.type === "issue_created");
    expect(created).toBeDefined();
  });

  it("returns empty events for unknown project", async () => {
    const result = await getProjectActivity(randomUUID(), db);
    expect(result.events).toHaveLength(0);
  });

  it("events are sorted newest-first", async () => {
    const result = await getProjectActivity(projectId, db);
    const timestamps = result.events.map((e) => e.timestamp);
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i - 1] >= timestamps[i]).toBe(true);
    }
  });
});

// #346: the feed's three fan-out queries were bare `select()` — all ~75 workspace
// columns, all session columns including the multi-KB `stats` JSON, and full comment
// bodies + payloads — ~5.5MB fetched per request on the dev project to render a 32KB
// feed, on the project view's poll path. They now name explicit columns and fetch only
// a bounded body prefix. These tests pin that the visible feed is unchanged by that.
describe("activity feed column narrowing (#346)", () => {
  let narrowProjectId: string;
  let narrowIssueId: string;

  beforeAll(async () => {
    const now = new Date().toISOString();
    narrowProjectId = randomUUID();
    await db.insert(schema.projects).values({
      id: narrowProjectId,
      name: "Narrowing Project",
      repoPath: "/tmp/narrowing",
      repoName: "narrowing",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });
    const narrowStatusId = randomUUID();
    await db.insert(schema.projectStatuses).values({
      id: narrowStatusId,
      projectId: narrowProjectId,
      name: "In Progress",
      sortOrder: 1,
      isDefault: true,
      createdAt: now,
    });
    narrowIssueId = randomUUID();
    await db.insert(schema.issues).values({
      id: narrowIssueId,
      issueNumber: 42,
      title: "Narrowed feed",
      statusId: narrowStatusId,
      projectId: narrowProjectId,
      createdAt: now,
      updatedAt: now,
    });
    const wsId = randomUUID();
    await db.insert(schema.workspaces).values({
      id: wsId,
      issueId: narrowIssueId,
      branch: "feature/ak-42-narrow",
      status: "closed",
      provider: "claude",
      createdAt: now,
      updatedAt: now,
      mergedAt: now,
      // A fat column the feed must not need.
      codeMetricsJson: JSON.stringify({ padding: "x".repeat(5000) }),
    });
    await db.insert(schema.sessions).values({
      id: randomUUID(),
      workspaceId: wsId,
      executor: "claude",
      status: "completed",
      startedAt: now,
      endedAt: now,
      exitCode: "0",
      skillName: "code-review",
      // The 2.94MB-on-the-dev-project column. Must not be fetched.
      stats: JSON.stringify({ padding: "y".repeat(20000) }),
    });
  });

  it("still renders workspace, session and skill detail from the narrowed columns", async () => {
    const result = await getProjectActivity(narrowProjectId, db);
    const types = result.events.map((e) => e.type);

    expect(types).toContain("workspace_created");
    expect(types).toContain("workspace_merged");
    expect(types).toContain("session_started");
    expect(types).toContain("session_completed");

    const created = result.events.find((e) => e.type === "workspace_created")!;
    expect(created.summary).toBe("Workspace created on feature/ak-42-narrow");
    expect(created.issueNumber).toBe(42);
    expect(created.issueTitle).toBe("Narrowed feed");

    // skillName and executor both survive the narrowing.
    const started = result.events.find((e) => e.type === "session_started")!;
    expect(started.summary).toBe("Agent session started (code-review)");
    expect(started.actor).toBe("claude");
    // provider is read for merged/closed events, so it must still be selected.
    expect(result.events.find((e) => e.type === "workspace_merged")!.actor).toBe("claude");
  });

  it("reports a failed session's exit code (exitCode survives the narrowing)", async () => {
    const now = new Date().toISOString();
    const wsId = randomUUID();
    await db.insert(schema.workspaces).values({
      id: wsId,
      issueId: narrowIssueId,
      branch: "feature/ak-42-failing",
      status: "error",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.sessions).values({
      id: randomUUID(),
      workspaceId: wsId,
      executor: "codex",
      status: "completed",
      startedAt: now,
      endedAt: now,
      exitCode: "1",
    });

    const result = await getProjectActivity(narrowProjectId, db);
    const failed = result.events.find((e) => e.type === "session_failed");
    expect(failed).toBeDefined();
    expect(failed!.summary).toBe("Session failed (exit 1)");
  });

  it("previews a short comment in full with no ellipsis", async () => {
    const now = new Date().toISOString();
    await db.insert(schema.issueComments).values({
      id: randomUUID(),
      issueId: narrowIssueId,
      kind: "note",
      author: "user",
      body: "Short and sweet.",
      createdAt: now,
    });

    const result = await getProjectActivity(narrowProjectId, db);
    const comment = result.events.find((e) => e.summary === "Note: Short and sweet.");
    expect(comment).toBeDefined();
    expect(comment!.commentKind).toBe("note");
    expect(comment!.actor).toBe("user");
  });

  it("keeps the 80-char preview and the ellipsis for a body far longer than the fetched prefix", async () => {
    // The regression this guards: the ellipsis is decided by the row's TRUE length, not
    // by the truncated prefix, so a 5000-char comment still renders identically to
    // before the narrowing even though only 300 chars are fetched.
    const now = new Date().toISOString();
    const longBody = "A".repeat(5000);
    await db.insert(schema.issueComments).values({
      id: randomUUID(),
      issueId: narrowIssueId,
      kind: "merge-attempt",
      author: "agent",
      body: longBody,
      createdAt: now,
      payload: JSON.stringify({ padding: "z".repeat(10000) }),
    });

    const result = await getProjectActivity(narrowProjectId, db);
    const comment = result.events.find((e) => e.commentKind === "merge-attempt")!;
    expect(comment.summary).toBe(`Merge attempt: ${"A".repeat(80)}...`);
  });
});

describe("activity feed index coverage", () => {
  it("issues query uses idx_issues_project_id_created_at index", async () => {
    const result = await client.execute(
      `EXPLAIN QUERY PLAN SELECT id, issue_number, title, created_at, status_changed_at FROM issues WHERE project_id = 'x' ORDER BY created_at DESC`,
    );
    const plan = result.rows.map((r) => String(r[3] ?? r.detail ?? Object.values(r).join(" "))).join("\n");
    expect(plan.toLowerCase()).toContain("idx_issues_project_id_created_at");
  });

  it("workspaces query uses idx_workspaces_issue_id_created_at index", async () => {
    const result = await client.execute(
      `EXPLAIN QUERY PLAN SELECT id, issue_id, created_at, merged_at, closed_at FROM workspaces WHERE issue_id = 'x'`,
    );
    const plan = result.rows.map((r) => String(r[3] ?? r.detail ?? Object.values(r).join(" "))).join("\n");
    expect(plan.toLowerCase()).toContain("idx_workspaces_issue_id_created_at");
  });

  it("idx_sessions_workspace_id_started_at index exists", async () => {
    const result = await client.execute(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sessions_workspace_id_started_at'`,
    );
    expect(result.rows.length).toBe(1);
  });
});
