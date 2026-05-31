import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { createIssuesRoute } from "../routes/issues.js";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import type { TestDb } from "./helpers/test-db.js";

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api/issues", createIssuesRoute(db));
  });
}

async function seedIssueWorkspace(database: TestDb, workingDir: string) {
  const now = "2026-05-30T09:00:00.000Z";
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await database.insert(schema.projects).values({
    id: projectId,
    name: "phase-artifact-save",
    repoPath: "/tmp/phase-artifact-save",
    repoName: "phase-artifact-save",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  await database.insert(schema.projectStatuses).values({
    id: statusId,
    projectId,
    name: "In Progress",
    sortOrder: 0,
    isDefault: true,
    createdAt: now,
  });
  await database.insert(schema.issues).values({
    id: issueId,
    issueNumber: 8,
    title: "Persist Save Failure",
    priority: "medium",
    sortOrder: 0,
    statusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  await database.insert(schema.workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/spec-save",
    workingDir,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });

  return { issueId, workspaceId };
}

describe("issue artifact routes", () => {
  it("does not save a phase artifact row when worktree file writing fails", async () => {
    const { app, db } = createTestApp();
    const tempDir = mkdtempSync(join(tmpdir(), "ak-phase-artifact-save-"));
    try {
      const invalidWorktreePath = join(tempDir, "not-a-directory");
      writeFileSync(invalidWorktreePath, "file blocks directory creation", "utf-8");
      const { issueId, workspaceId } = await seedIssueWorkspace(db, invalidWorktreePath);

      const res = await app.request(`/api/issues/${issueId}/artifacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "text",
          mimeType: "text/markdown",
          caption: "phase-artifact:specify",
          content: "# spec\n\nRequirements.",
          workspaceId,
        }),
      });

      expect(res.status).toBe(500);
      const rows = await db.select().from(schema.issueArtifacts).where(eq(schema.issueArtifacts.issueId, issueId));
      expect(rows).toHaveLength(0);
      expect(readFileSync(invalidWorktreePath, "utf-8")).toBe("file blocks directory creation");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
