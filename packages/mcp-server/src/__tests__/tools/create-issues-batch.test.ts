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
    getDiff: vi.fn(async () => ""),
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

  it("links created issues to parent with child_of when parentIssueId is provided", async () => {
    const { invoke, db } = setupTool(registerCreateIssuesBatch);
    const { projectId, statusIds } = await seedProject(db);

    await db.insert(schema.issues).values({
      id: "parent-1", issueNumber: 1, title: "Parent", priority: "medium",
      sortOrder: 0, statusId: statusIds.Todo, projectId,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    const result = await invoke({
      projectId,
      parentIssueId: "parent-1",
      issues: [{ title: "Child A" }, { title: "Child B" }],
    });
    const data = parseResult(result);
    expect(data.issues).toHaveLength(2);

    const deps = await db.select().from(schema.issueDependencies).where(eq(schema.issueDependencies.dependsOnId, "parent-1"));
    expect(deps).toHaveLength(2);
    expect(deps.every((dep) => dep.type === "child_of")).toBe(true);
  });

  it("seeds issues AND dependency edges atomically in one transaction (#765)", async () => {
    const { invoke, db, deps } = setupTool(registerCreateIssuesBatch);
    const { projectId } = await seedProject(db);

    // Fan-out epic: #0 base engine, #1 blocks #2 (wave ticket depends on engine).
    const result = await invoke({
      projectId,
      issues: [{ title: "Engine" }, { title: "Renderer" }, { title: "Wave spawner" }],
      dependencies: [
        { issueIndex: 1, dependsOnIndex: 0 },
        { issueIndex: 2, dependsOnIndex: 0, type: "blocked_by" },
      ],
    });
    const data = parseResult(result);
    expect(data.issues).toHaveLength(3);
    expect(data.dependenciesCreated).toBe(2);

    const idByNumber = new Map(data.issues.map((i: any) => [i.title, i.id]));
    const edges = await db.select().from(schema.issueDependencies);
    expect(edges).toHaveLength(2);

    const rendererEdge = edges.find((e) => e.issueId === idByNumber.get("Renderer"));
    expect(rendererEdge?.dependsOnId).toBe(idByNumber.get("Engine"));
    expect(rendererEdge?.type).toBe("depends_on");

    const waveEdge = edges.find((e) => e.issueId === idByNumber.get("Wave spawner"));
    expect(waveEdge?.dependsOnId).toBe(idByNumber.get("Engine"));
    expect(waveEdge?.type).toBe("blocked_by");

    expect(deps.notifyBoard).toHaveBeenCalledWith(projectId, "mcp_dependency_added");
  });

  it("accepts a coupled_with edge declared at creation (#918) — symmetric, no cycle check", async () => {
    const { invoke, db } = setupTool(registerCreateIssuesBatch);
    const { projectId } = await seedProject(db);

    // Two coupled vertical slices declared together. coupled_with is symmetric, so even a
    // mutual pair must NOT be rejected as a cycle (only directional edges cycle).
    const result = await invoke({
      projectId,
      issues: [{ title: "Panel UI" }, { title: "Panel endpoint" }],
      dependencies: [{ issueIndex: 0, dependsOnIndex: 1, type: "coupled_with" }],
    });
    const data = parseResult(result);
    expect(data.dependenciesCreated).toBe(1);

    const edges = await db.select().from(schema.issueDependencies);
    expect(edges).toHaveLength(1);
    expect(edges[0].type).toBe("coupled_with");
  });

  it("rolls back issues when a dependency index is out of range — nothing persisted", async () => {
    const { invoke, db } = setupTool(registerCreateIssuesBatch);
    const { projectId } = await seedProject(db);

    const result = await invoke({
      projectId,
      issues: [{ title: "A" }, { title: "B" }],
      dependencies: [{ issueIndex: 1, dependsOnIndex: 5 }],
    });
    expect(result.content[0].text).toContain("dependsOnIndex 5 out of range");

    const rows = await db.select().from(schema.issues).where(eq(schema.issues.projectId, projectId));
    expect(rows).toHaveLength(0);
    const edges = await db.select().from(schema.issueDependencies);
    expect(edges).toHaveLength(0);
  });

  it("rejects a self-dependency edge without persisting anything", async () => {
    const { invoke, db } = setupTool(registerCreateIssuesBatch);
    const { projectId } = await seedProject(db);

    const result = await invoke({
      projectId,
      issues: [{ title: "A" }],
      dependencies: [{ issueIndex: 0, dependsOnIndex: 0 }],
    });
    expect(result.content[0].text).toContain("cannot depend on itself");

    const rows = await db.select().from(schema.issues).where(eq(schema.issues.projectId, projectId));
    expect(rows).toHaveLength(0);
  });

  it("rejects a duplicate edge up-front instead of crashing the transaction", async () => {
    const { invoke, db } = setupTool(registerCreateIssuesBatch);
    const { projectId } = await seedProject(db);

    const result = await invoke({
      projectId,
      issues: [{ title: "A" }, { title: "B" }],
      dependencies: [
        { issueIndex: 1, dependsOnIndex: 0 },
        { issueIndex: 1, dependsOnIndex: 0 },
      ],
    });
    expect(result.content[0].text).toContain("duplicate edge");

    const rows = await db.select().from(schema.issues).where(eq(schema.issues.projectId, projectId));
    expect(rows).toHaveLength(0);
    const edges = await db.select().from(schema.issueDependencies);
    expect(edges).toHaveLength(0);
  });

  it("persists tags on batch-created issues, creating unknown tags on the fly", async () => {
    const { invoke, db } = setupTool(registerCreateIssuesBatch);
    const { projectId } = await seedProject(db);

    const result = await invoke({
      projectId,
      issues: [
        { title: "Meta epic", tags: ["no-auto-start"] },
        { title: "Child", tags: ["feature", "frontend"] },
        { title: "Untagged" },
      ],
    });
    const data = parseResult(result);
    const idByTitle = new Map(data.issues.map((i: any) => [i.title, i.id]));

    // Tags were created.
    const allTags = await db.select().from(schema.tags);
    expect(allTags.map((t) => t.name).sort()).toEqual(["feature", "frontend", "no-auto-start"]);

    // Meta epic carries exactly no-auto-start — the tag that suppresses auto-start.
    const metaTags = await db.select({ name: schema.tags.name })
      .from(schema.issueTags)
      .innerJoin(schema.tags, eq(schema.issueTags.tagId, schema.tags.id))
      .where(eq(schema.issueTags.issueId, idByTitle.get("Meta epic") as string));
    expect(metaTags.map((t) => t.name)).toEqual(["no-auto-start"]);

    // Child carries both of its tags; untagged issue has none.
    const childLinks = await db.select().from(schema.issueTags)
      .where(eq(schema.issueTags.issueId, idByTitle.get("Child") as string));
    expect(childLinks).toHaveLength(2);
    const untaggedLinks = await db.select().from(schema.issueTags)
      .where(eq(schema.issueTags.issueId, idByTitle.get("Untagged") as string));
    expect(untaggedLinks).toHaveLength(0);
  });

  it("reuses an existing tag (case-insensitive) instead of creating a duplicate", async () => {
    const { invoke, db } = setupTool(registerCreateIssuesBatch);
    const { projectId } = await seedProject(db);

    // A builtin tag already exists, as the seed would create.
    await db.insert(schema.tags).values({
      id: "builtin-no-auto-start", name: "no-auto-start", color: null,
      isBuiltin: true, createdAt: new Date().toISOString(),
    });

    const result = await invoke({
      projectId,
      issues: [{ title: "Meta", tags: ["No-Auto-Start"] }],
    });
    const data = parseResult(result);

    // No duplicate tag row was created.
    const allTags = await db.select().from(schema.tags);
    expect(allTags).toHaveLength(1);

    // The issue links to the pre-existing builtin tag.
    const links = await db.select().from(schema.issueTags)
      .where(eq(schema.issueTags.issueId, data.issues[0].id));
    expect(links).toHaveLength(1);
    expect(links[0].tagId).toBe("builtin-no-auto-start");
  });

  it("rejects a cycle across the batch's directional edges", async () => {
    const { invoke, db } = setupTool(registerCreateIssuesBatch);
    const { projectId } = await seedProject(db);

    const result = await invoke({
      projectId,
      issues: [{ title: "A" }, { title: "B" }],
      dependencies: [
        { issueIndex: 0, dependsOnIndex: 1 },
        { issueIndex: 1, dependsOnIndex: 0 },
      ],
    });
    expect(result.content[0].text).toContain("would create a cycle");

    const rows = await db.select().from(schema.issues).where(eq(schema.issues.projectId, projectId));
    expect(rows).toHaveLength(0);
  });
});
