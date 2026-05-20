import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { createSessionsRoute } from "../routes/sessions.js";
import * as schema from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_FILES = [
  "../../../shared/drizzle/0000_flawless_trauma.sql",
  "../../../shared/drizzle/0001_magical_johnny_storm.sql",
  "../../../shared/drizzle/0002_bent_may_parker.sql",
  "../../../shared/drizzle/0003_tough_lightspeed.sql",
  "../../../shared/drizzle/0004_boring_wind_dancer.sql",
  "../../../shared/drizzle/0005_silky_frog_thor.sql",
  "../../../shared/drizzle/0006_wide_ogun.sql",
  "../../../shared/drizzle/0007_diff_comments.sql",
  "../../../shared/drizzle/0008_direct_workspace.sql",
  "../../../shared/drizzle/0009_requires_review.sql",
  "../../../shared/drizzle/0010_session_messages_cascade.sql",
  "../../../shared/drizzle/0011_timestamps.sql",
  "../../../shared/drizzle/0012_session_stats.sql",
  "../../../shared/drizzle/0013_plan_mode.sql",
  "../../../shared/drizzle/0014_issue_dependencies.sql",
  "../../../shared/drizzle/0015_ai_reviewed_status.sql",
  "../../../shared/drizzle/0016_skip_auto_review.sql",
  "../../../shared/drizzle/0017_agent_config.sql",
  "../../../shared/drizzle/0018_agent_skills.sql",
  "../../../shared/drizzle/0019_workspace_skill.sql",
  "../../../shared/drizzle/0023_dependency_types.sql",
  "../../../shared/drizzle/0020_setup_script.sql",
  "../../../shared/drizzle/0021_project_skills.sql",
  "../../../shared/drizzle/0022_teardown_script.sql",
  "../../../shared/drizzle/0024_setup_enabled.sql",
  "../../../shared/drizzle/0025_provider_session_id.sql",
  "../../../shared/drizzle/0026_ready_for_merge.sql",
  "../../../shared/drizzle/0027_estimate_field.sql",
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
  "../../../shared/drizzle/0028_perf_indexes_conflict_cache.sql",
=======
>>>>>>> b6a4ecf (feat: add estimate/sizing field to issues (XS/S/M/L/XL))
=======
  "../../../shared/drizzle/0028_perf_indexes_conflict_cache.sql",
>>>>>>> d778ce3 (perf: add DB indexes and stale-while-revalidate conflict cache for board load)
=======
>>>>>>> 26ff491 (feat: add estimate/sizing field to issues (XS/S/M/L/XL))
=======
  "../../../shared/drizzle/0028_perf_indexes_conflict_cache.sql",
>>>>>>> d318021 (perf: add DB indexes and stale-while-revalidate conflict cache for board load)
=======
>>>>>>> 43685f8 (feat: add estimate/sizing field to issues (XS/S/M/L/XL))
=======
  "../../../shared/drizzle/0028_perf_indexes_conflict_cache.sql",
>>>>>>> 59675e9 (perf: add DB indexes and stale-while-revalidate conflict cache for board load)
];

function createTestApp() {
  const client = createClient({ url: ":memory:" });
  for (const file of MIGRATION_FILES) {
    const sql = readFileSync(resolve(__dirname, file), "utf-8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      client.execute(stmt);
    }
  }

  const database = drizzle(client, { schema });
  const app = new Hono();
  app.route("/api/sessions", createSessionsRoute(database));
  return { app, db: database };
}

// Helper to create prerequisite data: project -> status -> issue -> workspace -> session
async function createSessionWithData(database: ReturnType<typeof drizzle<typeof schema>>) {
  const now = new Date().toISOString();

  // Project
  const projectId = randomUUID();
  await database.insert(schema.projects).values({
    id: projectId,
    name: "Test Project",
    repoPath: "/tmp/test-repo",
    repoName: "test-repo",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  // Status
  const statusId = randomUUID();
  await database.insert(schema.projectStatuses).values({
    id: statusId,
    projectId,
    name: "Todo",
    sortOrder: 0,
    isDefault: true,
    createdAt: now,
  });

  // Issue
  const issueId = randomUUID();
  await database.insert(schema.issues).values({
    id: issueId,
    issueNumber: 1,
    title: "Test Issue",
    projectId,
    statusId,
    priority: "medium",
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  });

  // Workspace
  const workspaceId = randomUUID();
  await database.insert(schema.workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/test",
    status: "active",
    workingDir: "/tmp/worktree",
    isDirect: false,
    planMode: false,
    createdAt: now,
    updatedAt: now,
  });

  // Session
  const sessionId = randomUUID();
  const endedAt = new Date(Date.now() + 345_000).toISOString(); // 5m 45s later
  await database.insert(schema.sessions).values({
    id: sessionId,
    workspaceId,
    executor: "claude-code",
    status: "completed",
    startedAt: now,
    endedAt,
    providerSessionId: "claude-123",
    stats: JSON.stringify({
      durationMs: 345_000,
      totalCostUsd: 0.15,
      inputTokens: 10_000,
      outputTokens: 5_000,
      numTurns: 3,
      model: "claude-sonnet-4-20250514",
      success: true,
    }),
  });

  return { sessionId, workspaceId, issueId, projectId };
}

describe("Session Summary API", () => {
  let testApp: ReturnType<typeof createTestApp>;

  beforeAll(() => {
    testApp = createTestApp();
  });

  it("returns 404 for non-existent session", async () => {
    const res = await testApp.app.request("/api/sessions/nonexistent/summary");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Session not found");
  });

  it("returns summary for a session with no messages", async () => {
    const { sessionId } = await createSessionWithData(testApp.db);

    const res = await testApp.app.request(`/api/sessions/${sessionId}/summary`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.sessionId).toBe(sessionId);
    expect(body.status).toBe("completed");
    expect(body.duration).toBe("5m 45s");
    expect(body.overview).toBe("No activity recorded");
    expect(body.actions).toEqual([]);
    expect(body.keyExcerpts).toEqual([]);
    expect(body.errors).toEqual([]);
    expect(body.filesRead).toEqual([]);
    expect(body.filesEdited).toEqual([]);
    expect(body.filesWritten).toEqual([]);
    expect(body.commandsRun).toEqual([]);
    expect(body.model).toBe("");
  });

  it("parses init and assistant messages", async () => {
    const { sessionId } = await createSessionWithData(testApp.db);

    // Insert session messages
    await testApp.db.insert(schema.sessionMessages).values([
      {
        sessionId,
        type: "stdout",
        data: JSON.stringify({
          type: "system",
          subtype: "init",
          model: "claude-sonnet-4-20250514",
          session_id: "claude-123",
          cwd: "/tmp/worktree",
          tools: ["Read", "Edit", "Bash"],
        }),
      },
      {
        sessionId,
        type: "stdout",
        data: JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-sonnet-4-20250514",
            content: [
              { type: "text", text: "I'll start by reading the existing code." },
            ],
          },
        }),
      },
    ]);

    const res = await testApp.app.request(`/api/sessions/${sessionId}/summary`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.model).toBe("claude-sonnet-4-20250514");
    expect(body.keyExcerpts).toContain("I'll start by reading the existing code.");
    expect(body.overview).toContain("claude-sonnet-4-20250514");
  });

  it("extracts file operations and commands", async () => {
    const { sessionId } = await createSessionWithData(testApp.db);

    await testApp.db.insert(schema.sessionMessages).values([
      {
        sessionId,
        type: "stdout",
        data: JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "tu-1",
                name: "Read",
                input: { file_path: "/src/foo.ts" },
              },
              {
                type: "tool_use",
                id: "tu-2",
                name: "Read",
                input: { file_path: "/src/bar.ts" },
              },
              {
                type: "tool_use",
                id: "tu-3",
                name: "Edit",
                input: { file_path: "/src/foo.ts", old_string: "a", new_string: "b" },
              },
              {
                type: "tool_use",
                id: "tu-4",
                name: "Write",
                input: { file_path: "/src/new-file.ts", content: "export {}" },
              },
              {
                type: "tool_use",
                id: "tu-5",
                name: "Bash",
                input: { command: "pnpm test" },
              },
            ],
          },
        }),
      },
    ]);

    const res = await testApp.app.request(`/api/sessions/${sessionId}/summary`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.filesRead).toEqual(["/src/foo.ts", "/src/bar.ts"]);
    expect(body.filesEdited).toEqual(["/src/foo.ts"]);
    expect(body.filesWritten).toEqual(["/src/new-file.ts"]);
    expect(body.commandsRun).toEqual(["pnpm test"]);
    expect(body.overview).toContain("read 2 files");
    expect(body.overview).toContain("edited 1 file");
    expect(body.overview).toContain("wrote 1 file");
    expect(body.overview).toContain("ran 1 command");
  });

  it("extracts error results from tool_result blocks", async () => {
    const { sessionId } = await createSessionWithData(testApp.db);

    await testApp.db.insert(schema.sessionMessages).values([
      {
        sessionId,
        type: "stdout",
        data: JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "tu-err", name: "Bash", input: { command: "bad-cmd" } },
            ],
          },
        }),
      },
      {
        sessionId,
        type: "stdout",
        data: JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu-err",
                is_error: true,
                content: "Command not found: bad-cmd",
              },
            ],
          },
        }),
      },
    ]);

    const res = await testApp.app.request(`/api/sessions/${sessionId}/summary`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.errors.length).toBe(1);
    expect(body.errors[0]).toContain("Bash");
    expect(body.errors[0]).toContain("Command not found: bad-cmd");
  });

  it("handles multi-line JSONL in a single data field", async () => {
    const { sessionId } = await createSessionWithData(testApp.db);

    // Simulate two JSON lines in one data field (as happens with buffered stdout)
    const line1 = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "First message" }] },
    });
    const line2 = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Second message" }] },
    });

    await testApp.db.insert(schema.sessionMessages).values([
      {
        sessionId,
        type: "stdout",
        data: line1 + "\n" + line2,
      },
    ]);

    const res = await testApp.app.request(`/api/sessions/${sessionId}/summary`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.keyExcerpts).toContain("First message");
    expect(body.keyExcerpts).toContain("Second message");
  });

  it("includes session stats and duration", async () => {
    const { sessionId } = await createSessionWithData(testApp.db);

    const res = await testApp.app.request(`/api/sessions/${sessionId}/summary`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.stats).toBeTruthy();
    expect((body.stats as Record<string, unknown>).totalCostUsd).toBe(0.15);
    expect((body.stats as Record<string, unknown>).model).toBe("claude-sonnet-4-20250514");
    expect(body.duration).toBe("5m 45s");
    expect(body.startedAt).toBeTruthy();
    expect(body.endedAt).toBeTruthy();
  });

  it("limits keyExcerpts to 10 entries", async () => {
    const { sessionId } = await createSessionWithData(testApp.db);

    // Insert 15 assistant text messages
    const messages = [];
    for (let i = 0; i < 15; i++) {
      messages.push({
        sessionId,
        type: "stdout" as const,
        data: JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: `Message ${i}` }] },
        }),
      });
    }
    await testApp.db.insert(schema.sessionMessages).values(messages);

    const res = await testApp.app.request(`/api/sessions/${sessionId}/summary`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.keyExcerpts.length).toBe(10);
  });

  it("truncates long excerpts to 300 chars", async () => {
    const { sessionId } = await createSessionWithData(testApp.db);

    const longText = "a".repeat(500);
    await testApp.db.insert(schema.sessionMessages).values([
      {
        sessionId,
        type: "stdout",
        data: JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: longText }] },
        }),
      },
    ]);

    const res = await testApp.app.request(`/api/sessions/${sessionId}/summary`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.keyExcerpts[0].length).toBeLessThan(longText.length);
    expect(body.keyExcerpts[0]).toContain("...");
  });

  it("skips stderr messages", async () => {
    const { sessionId } = await createSessionWithData(testApp.db);

    await testApp.db.insert(schema.sessionMessages).values([
      {
        sessionId,
        type: "stderr",
        data: "Some warning output",
      },
    ]);

    const res = await testApp.app.request(`/api/sessions/${sessionId}/summary`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.overview).toBe("No activity recorded");
  });
});
