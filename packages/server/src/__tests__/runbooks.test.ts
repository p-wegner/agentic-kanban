import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as schema from "@agentic-kanban/shared/schema";
import { createRunbooksRoute } from "../routes/runbooks.js";
import { createTestApp as createHarness } from "./helpers/test-app.js";
import type { TestDb } from "./helpers/test-db.js";

function createTestApp() {
  return createHarness((app, db) => {
    app.route("/api/projects", createRunbooksRoute(db));
  });
}

interface ProjectSeed {
  projectId: string;
  repoPath: string;
}

async function seedProject(db: TestDb, repoPath: string): Promise<string> {
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name: "runbook-test-project",
    repoPath,
    repoName: "runbook-test-project",
    defaultBranch: "main",
  });
  return projectId;
}

describe("runbooks route", () => {
  let repoPath: string;
  let app: ReturnType<typeof createTestApp>["app"];
  let db: TestDb;
  let projectId: string;

  beforeAll(async () => {
    repoPath = mkdtempSync(join(tmpdir(), "ak-runbooks-test-"));

    // Create CLAUDE.md at repo root
    writeFileSync(join(repoPath, "CLAUDE.md"), "# Project Instructions\n\nThis is the CLAUDE.md file.", "utf-8");

    // Create docs/learnings directory with a learning file
    mkdirSync(join(repoPath, "docs", "learnings"), { recursive: true });
    writeFileSync(
      join(repoPath, "docs", "learnings", "2026-05-24-agent-lesson.md"),
      "# Lesson Learned\n\nAgents should not delete databases.",
      "utf-8",
    );

    // Create scripts/board-monitor/README.md
    mkdirSync(join(repoPath, "scripts", "board-monitor"), { recursive: true });
    writeFileSync(
      join(repoPath, "scripts", "board-monitor", "README.md"),
      "# Board Monitor\n\nHow to run the autonomous board monitor.",
      "utf-8",
    );

    const harness = createTestApp();
    app = harness.app;
    db = harness.db;
    projectId = await seedProject(db, repoPath);
  });

  afterAll(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  it("returns a list of runbook entries including CLAUDE.md", async () => {
    const res = await app.request(`/api/projects/${projectId}/runbooks`);
    expect(res.status).toBe(200);

    const body = await res.json() as any[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);

    const claudeEntry = body.find((e: any) => e.path === "CLAUDE.md");
    expect(claudeEntry).toBeDefined();
    expect(claudeEntry).toMatchObject({
      path: "CLAUDE.md",
      title: expect.any(String),
      lastModified: expect.any(String),
    });
  });

  it("includes docs/learnings entries in the list", async () => {
    const res = await app.request(`/api/projects/${projectId}/runbooks`);
    expect(res.status).toBe(200);

    const body = await res.json() as any[];
    const learningEntry = body.find((e: any) =>
      (e.path as string).includes("2026-05-24-agent-lesson.md"),
    );
    expect(learningEntry).toBeDefined();
    expect(learningEntry).toMatchObject({
      path: expect.stringContaining("docs/learnings"),
      title: expect.any(String),
      lastModified: expect.any(String),
    });
  });

  it("returns markdown content for CLAUDE.md", async () => {
    const res = await app.request(
      `/api/projects/${projectId}/runbooks/content?path=CLAUDE.md`,
    );
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body).toMatchObject({
      path: "CLAUDE.md",
      content: expect.stringContaining("# Project Instructions"),
    });
  });

  it("returns content for a nested learnings file", async () => {
    const res = await app.request(
      `/api/projects/${projectId}/runbooks/content?path=docs/learnings/2026-05-24-agent-lesson.md`,
    );
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.content).toContain("Lesson Learned");
  });

  it("rejects path traversal attempts with 400", async () => {
    const res = await app.request(
      `/api/projects/${projectId}/runbooks/content?path=../outside.md`,
    );
    expect(res.status).toBe(400);

    const body = await res.json() as any;
    expect(body.error).toBeTruthy();
  });

  it("rejects absolute path attempts with 400", async () => {
    const res = await app.request(
      `/api/projects/${projectId}/runbooks/content?path=/etc/passwd`,
    );
    expect(res.status).toBe(400);

    const body = await res.json() as any;
    expect(body.error).toBeTruthy();
  });

  it("returns 404 for a content path that does not exist", async () => {
    const res = await app.request(
      `/api/projects/${projectId}/runbooks/content?path=nonexistent.md`,
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for a project that does not exist", async () => {
    const unknownId = randomUUID();
    const res = await app.request(`/api/projects/${unknownId}/runbooks`);
    expect(res.status).toBe(404);
  });
});
