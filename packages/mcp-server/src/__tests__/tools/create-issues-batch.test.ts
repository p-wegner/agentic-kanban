import { describe, it, expect, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "@agentic-kanban/shared/schema";
import { registerCreateIssuesBatch } from "../../tools/create-issues-batch.js";
import { createToolHarness, parseResult } from "../helpers/tool-harness.js";
import { applyMigrationsToClient, type TestDb } from "../helpers/test-db.js";
import { seedProject } from "../helpers/seed.js";
import type { ToolDeps } from "../../tools/deps.js";

const tempDirs: string[] = [];
function setupTool(register: (server: any, deps: ToolDeps) => void) {
  const dir = mkdtempSync(join(tmpdir(), "ak-mcp-batch-"));
  tempDirs.push(dir);
  const client = createClient({ url: `file:${join(dir, "test.db")}` });
  applyMigrationsToClient(client);
  const db = drizzle(client, { schema }) as TestDb;
  const deps: ToolDeps = {
    db,
    schema,
    notifyBoard: vi.fn(),
    getDiffShortstat: vi.fn(async () => ({ filesChanged: 0, insertions: 0, deletions: 0 })),
  };
  const { server, getHandler } = createToolHarness();
  register(server, deps);
  return { invoke: getHandler(), db, deps };
}

afterAll(() => {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

describe("create_issues_batch tool", () => {
  it("creates N issues with consecutive issue numbers in one call", async () => {
    const { invoke, db, deps } = setupTool(registerCreateIssuesBatch);
    const { projectId } = await seedProject(db);

    const result = await invoke({
      projectId,
      issues: [
        { title: "A" },
        { title: "B", priority: "high" },
        { title: "C" },
        { title: "D" },
        { title: "E" },
      ],
    });
    const data = parseResult(result);

    expect(data.issues).toHaveLength(5);
    const numbers = data.issues.map((i: any) => i.issueNumber);
    expect(numbers).toEqual([1, 2, 3, 4, 5]);

    const rows = await db.select().from(schema.issues).where(eq(schema.issues.projectId, projectId));
    expect(rows).toHaveLength(5);
    expect(deps.notifyBoard).toHaveBeenCalledWith(projectId, "mcp_create_issues_batch");
  });

  it("rolls back on validation failure — no issues persisted", async () => {
    const { invoke, db } = setupTool(registerCreateIssuesBatch);
    const { projectId } = await seedProject(db);

    const result = await invoke({
      projectId,
      issues: [{ title: "ok" }, { title: "" }, { title: "also ok" }],
    });
    expect(result.content[0].text).toContain("issues[1].title is required");

    const rows = await db.select().from(schema.issues).where(eq(schema.issues.projectId, projectId));
    expect(rows).toHaveLength(0);
  });

  it("continues numbering from existing max", async () => {
    const { invoke, db } = setupTool(registerCreateIssuesBatch);
    const { projectId, statusIds } = await seedProject(db);

    await db.insert(schema.issues).values({
      id: "pre-1", issueNumber: 7, title: "pre", priority: "medium",
      sortOrder: 0, statusId: statusIds.Todo, projectId,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    const result = await invoke({
      projectId,
      issues: [{ title: "X" }, { title: "Y" }],
    });
    const data = parseResult(result);
    expect(data.issues.map((i: any) => i.issueNumber)).toEqual([8, 9]);
  });
});
