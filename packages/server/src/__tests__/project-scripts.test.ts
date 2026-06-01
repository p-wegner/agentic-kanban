import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createClient } from "@libsql/client";
import * as schema from "@agentic-kanban/shared/schema";
import { createRoutes } from "../routes/index.js";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import type { TestDb } from "./helpers/test-db.js";
import { MIGRATION_FILES, MIGRATIONS_DIR } from "./helpers/migrations.js";

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api", createRoutes(db, () => createMockSessionManager()));
  });
}

async function applyMigrationFile(client: ReturnType<typeof createClient>, file: string): Promise<void> {
  const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf-8");
  const statements = sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await client.execute(statement);
  }
}

async function createProject(database: TestDb) {
  const repoPath = join(tmpdir(), `ak-script-shortcuts-${randomUUID()}`);
  mkdirSync(join(repoPath, "packages", "server"), { recursive: true });
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await database.insert(schema.projects).values({
    id: projectId,
    name: "Script Project",
    repoPath,
    repoName: "script-project",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  return { projectId, repoPath, cleanup: () => rmSync(repoPath, { recursive: true, force: true }) };
}

describe("Project script shortcuts API", () => {
  it("migrates existing shortcut working directories to custom cwd mode", async () => {
    const client = createClient({ url: ":memory:" });
    for (const file of MIGRATION_FILES.filter((name) => name !== "0067_project_script_shortcut_details.sql")) {
      await applyMigrationFile(client, file);
    }

    const now = new Date().toISOString();
    await client.execute({
      sql: "INSERT INTO projects (id, name, repo_path, repo_name, default_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: ["project-1", "Project", "/repo", "repo", "main", now, now],
    });
    await client.execute({
      sql: "INSERT INTO project_script_shortcuts (id, project_id, name, command, working_dir, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      args: ["script-1", "project-1", "Build", "pnpm build", "packages/server", 0, now, now],
    });

    await applyMigrationFile(client, "0067_project_script_shortcut_details.sql");

    const row = await client.execute("SELECT cwd_mode FROM project_script_shortcuts WHERE id = 'script-1'");
    expect(row.rows[0]?.cwd_mode).toBe("custom");
  });

  it("creates, lists, updates, and deletes shortcuts", async () => {
    const { app, db } = createTestApp();
    const project = await createProject(db);
    try {
      const createRes = await app.request(`/api/projects/${project.projectId}/scripts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Build",
          description: "Compile server package",
          command: "pnpm build",
          cwdMode: "custom",
          workingDir: "packages/server",
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json() as any;
      expect(created.name).toBe("Build");
      expect(created.description).toBe("Compile server package");
      expect(created.cwdMode).toBe("custom");
      expect(created.workingDir).toBe("packages/server");
      expect(created.lastRun).toBeNull();

      const listRes = await app.request(`/api/projects/${project.projectId}/scripts`);
      expect(listRes.status).toBe(200);
      const list = await listRes.json() as any[];
      expect(list).toHaveLength(1);
      expect(list[0].command).toBe("pnpm build");

      const updateRes = await app.request(`/api/projects/${project.projectId}/scripts/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test Mine", description: null, command: "pnpm test:mine", cwdMode: "project", workingDir: null }),
      });
      expect(updateRes.status).toBe(200);
      const updated = await updateRes.json() as any;
      expect(updated.name).toBe("Test Mine");
      expect(updated.description).toBeNull();
      expect(updated.cwdMode).toBe("project");
      expect(updated.workingDir).toBeNull();

      const deleteRes = await app.request(`/api/projects/${project.projectId}/scripts/${created.id}`, {
        method: "DELETE",
      });
      expect(deleteRes.status).toBe(200);
      const afterDelete = await (await app.request(`/api/projects/${project.projectId}/scripts`)).json() as any[];
      expect(afterDelete).toEqual([]);
    } finally {
      project.cleanup();
    }
  });

  it("rejects unsafe or missing shortcut fields", async () => {
    const { app, db } = createTestApp();
    const project = await createProject(db);
    try {
      const missingName = await app.request(`/api/projects/${project.projectId}/scripts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "pnpm build" }),
      });
      expect(missingName.status).toBe(400);

      const escapingDir = await app.request(`/api/projects/${project.projectId}/scripts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Escape", command: "pnpm build", workingDir: "../outside" }),
      });
      expect(escapingDir.status).toBe(400);
      const body = await escapingDir.json() as any;
      expect(body.error).toContain("inside the project root");

      const missingCustomDir = await app.request(`/api/projects/${project.projectId}/scripts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Custom", command: "pnpm build", cwdMode: "custom" }),
      });
      expect(missingCustomDir.status).toBe(400);
    } finally {
      project.cleanup();
    }
  });

  it("streams output and records last run status for this server session", async () => {
    const { app, db } = createTestApp();
    const project = await createProject(db);
    try {
      const createRes = await app.request(`/api/projects/${project.projectId}/scripts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Echo", command: "echo hello-script" }),
      });
      const created = await createRes.json() as any;

      const runRes = await app.request(`/api/projects/${project.projectId}/scripts/${created.id}/run`, { method: "POST" });
      expect(runRes.status).toBe(200);
      const text = await runRes.text();
      expect(text).toContain("hello-script");
      expect(text).toContain("\"type\":\"exit\"");
      expect(text).toContain("\"exitCode\":0");

      const list = await (await app.request(`/api/projects/${project.projectId}/scripts`)).json() as any[];
      expect(list[0].lastRun.status).toBe("success");
      expect(list[0].lastRun.exitCode).toBe(0);
      expect(list[0].lastRun.startedAt).toBeTruthy();
    } finally {
      project.cleanup();
    }
  });
});
