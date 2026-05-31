import { afterAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "@agentic-kanban/shared/schema";
import { registerCreateSubIssue } from "../../tools/create-sub-issue.js";
import { createToolHarness, parseResult } from "../helpers/tool-harness.js";
import { seedIssue, seedProject } from "../helpers/seed.js";
import { applyMigrationsToClient, type TestDb } from "../helpers/test-db.js";
import type { ToolDeps } from "../../tools/deps.js";

const tempDirs: string[] = [];
function setupFileTool() {
  const dir = mkdtempSync(join(tmpdir(), "ak-mcp-sub-issue-"));
  tempDirs.push(dir);
  const client = createClient({ url: `file:${join(dir, "test.db")}` });
  applyMigrationsToClient(client);
  const db = drizzle(client, { schema }) as TestDb;
  const deps: ToolDeps = {
    db,
    schema,
    notifyBoard: vi.fn(),
    getDiff: vi.fn(async () => ""),
    getDiffShortstat: vi.fn(async () => ({ filesChanged: 0, insertions: 0, deletions: 0 })),
  };
  const { server, getHandler } = createToolHarness();
  registerCreateSubIssue(server, deps);
  return { invoke: getHandler(), db, deps };
}

afterAll(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe("create_sub_issue tool", () => {
  it("creates a child issue and child_of dependency in one call", async () => {
    const { invoke, db, deps } = setupFileTool();
    const { projectId, statusIds } = await seedProject(db);
    const parent = await seedIssue(db, projectId, statusIds.Todo, { title: "Parent", issueNumber: 7 });

    const data = parseResult(await invoke({
      parentIssueId: parent.id,
      title: "Child task",
      description: "Acceptance criteria here",
      priority: "high",
    }));

    expect(data.title).toBe("Child task");
    expect(data.issueNumber).toBe(8);
    expect(data.parentIssueId).toBe(parent.id);
    expect(data.dependencyType).toBe("child_of");

    const issues = await db.select().from(schema.issues).where(eq(schema.issues.id, data.id));
    expect(issues).toHaveLength(1);
    expect(issues[0].description).toBe("Acceptance criteria here");
    expect(issues[0].projectId).toBe(projectId);

    const depsRows = await db.select().from(schema.issueDependencies).where(eq(schema.issueDependencies.id, data.dependencyId));
    expect(depsRows).toHaveLength(1);
    expect(depsRows[0]).toMatchObject({
      issueId: data.id,
      dependsOnId: parent.id,
      type: "child_of",
    });
    expect(deps.notifyBoard).toHaveBeenCalledWith(projectId, "mcp_create_sub_issue");
    expect(deps.notifyBoard).toHaveBeenCalledWith(projectId, "mcp_dependency_added");
  });
});
