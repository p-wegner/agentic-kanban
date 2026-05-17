import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { createIssuesRoute } from "../routes/issues.js";
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
  "../../../shared/drizzle/0018_dependency_types.sql",
  "../../../shared/drizzle/0020_setup_script.sql",
  "../../../shared/drizzle/0021_project_skills.sql",
  "../../../shared/drizzle/0022_teardown_script.sql",
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
  app.route("/api/issues", createIssuesRoute(database));
  return { app, db: database };
}

async function createProjectDirectly(
  database: ReturnType<typeof drizzle<typeof schema>>,
  name: string,
) {
  const now = new Date().toISOString();
  const id = randomUUID();
  await database.insert(schema.projects).values({
    id,
    name,
    repoPath: `/tmp/${name.replace(/\s+/g, "-")}`,
    repoName: name.replace(/\s+/g, "-"),
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function createStatusDirectly(
  database: ReturnType<typeof drizzle<typeof schema>>,
  projectId: string,
  name: string,
  sortOrder: number,
) {
  const now = new Date().toISOString();
  const id = randomUUID();
  await database.insert(schema.projectStatuses).values({
    id,
    projectId,
    name,
    sortOrder,
    isDefault: sortOrder === 0,
    createdAt: now,
  });
  return id;
}

describe("Issue Number Auto-Increment", () => {
  const { app, db: database } = createTestApp();
  let projectId: string;
  let statusId: string;

  beforeAll(async () => {
    projectId = await createProjectDirectly(database, "Issue Number Project");
    statusId = await createStatusDirectly(database, projectId, "Todo", 0);
  });

  it("first issue gets issue number 1", async () => {
    const res = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "First issue", statusId, projectId }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.issueNumber).toBe(1);
  });

  it("second issue gets issue number 2", async () => {
    const res = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Second issue", statusId, projectId }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.issueNumber).toBe(2);
  });

  it("third issue gets issue number 3", async () => {
    const res = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Third issue", statusId, projectId }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.issueNumber).toBe(3);
  });

  it("GET /api/issues returns issues with their issue numbers", async () => {
    const res = await app.request(`/api/issues?projectId=${projectId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.length).toBe(3);

    const numbers = body.map((i: { issueNumber: number }) => i.issueNumber);
    expect(numbers).toContain(1);
    expect(numbers).toContain(2);
    expect(numbers).toContain(3);
  });

  it("issue numbers use MAX of remaining issues after deletion", async () => {
    // Create issue 4
    const res4 = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Issue four", statusId, projectId }),
    });
    const issue4 = await res4.json();
    expect(issue4.issueNumber).toBe(4);

    // Delete issue 4
    await app.request(`/api/issues/${issue4.id}`, { method: "DELETE" });

    // Next issue gets MAX(1,2,3)+1 = 4 (reuses the number since MAX dropped)
    const resNext = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Issue after delete", statusId, projectId }),
    });
    const issueNext = await resNext.json();
    expect(issueNext.issueNumber).toBe(4);
  });

  it("issue numbers continue incrementing when max issue is not deleted", async () => {
    // Issues 1..3 exist from earlier tests. Create issue 5 (next MAX+1)
    const res5 = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Issue five", statusId, projectId }),
    });
    const issue5 = await res5.json();
    // MAX was 4 (from the "after delete" test above), so this is 5
    expect(issue5.issueNumber).toBe(5);

    // And issue 6 continues
    const res6 = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Issue six", statusId, projectId }),
    });
    const issue6 = await res6.json();
    expect(issue6.issueNumber).toBe(6);
  });
});

describe("Issue Number - Independent Per Project", () => {
  const { app, db: database } = createTestApp();
  let projectAId: string;
  let projectBId: string;
  let statusAId: string;
  let statusBId: string;

  beforeAll(async () => {
    projectAId = await createProjectDirectly(database, "Project A");
    statusAId = await createStatusDirectly(database, projectAId, "Todo", 0);

    projectBId = await createProjectDirectly(database, "Project B");
    statusBId = await createStatusDirectly(database, projectBId, "Todo", 0);
  });

  it("project A starts numbering from 1", async () => {
    const res = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Project A issue 1", statusId: statusAId, projectId: projectAId }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.issueNumber).toBe(1);
  });

  it("project B also starts numbering from 1 (independent sequence)", async () => {
    const res = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Project B issue 1", statusId: statusBId, projectId: projectBId }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.issueNumber).toBe(1);
  });

  it("project A increments independently", async () => {
    const res = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Project A issue 2", statusId: statusAId, projectId: projectAId }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.issueNumber).toBe(2);
  });

  it("project B increments independently", async () => {
    const res = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Project B issue 2", statusId: statusBId, projectId: projectBId }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.issueNumber).toBe(2);
  });

  it("interleaving creates between projects does not affect sequences", async () => {
    // Alternate between A and B
    const a3 = await (
      await app.request("/api/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "A-3", statusId: statusAId, projectId: projectAId }),
      })
    ).json();
    const b3 = await (
      await app.request("/api/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "B-3", statusId: statusBId, projectId: projectBId }),
      })
    ).json();
    const a4 = await (
      await app.request("/api/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "A-4", statusId: statusAId, projectId: projectAId }),
      })
    ).json();

    expect(a3.issueNumber).toBe(3);
    expect(b3.issueNumber).toBe(3);
    expect(a4.issueNumber).toBe(4);
  });

  it("GET /api/issues returns correct issue numbers per project", async () => {
    const resA = await app.request(`/api/issues?projectId=${projectAId}`);
    const issuesA = await resA.json();
    const numbersA = issuesA
      .map((i: { issueNumber: number }) => i.issueNumber)
      .sort((a: number, b: number) => a - b);
    expect(numbersA).toEqual([1, 2, 3, 4]);

    const resB = await app.request(`/api/issues?projectId=${projectBId}`);
    const issuesB = await resB.json();
    const numbersB = issuesB
      .map((i: { issueNumber: number }) => i.issueNumber)
      .sort((a: number, b: number) => a - b);
    expect(numbersB).toEqual([1, 2, 3]);
  });
});
