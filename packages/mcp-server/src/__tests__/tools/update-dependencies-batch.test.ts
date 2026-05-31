import { describe, it, expect, afterAll, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "@agentic-kanban/shared/schema";
import { registerUpdateDependenciesBatch } from "../../tools/update-dependencies-batch.js";
import { createToolHarness, parseResult } from "../helpers/tool-harness.js";
import { applyMigrationsToClient, type TestDb } from "../helpers/test-db.js";
import { seedProject, seedIssue } from "../helpers/seed.js";
import type { ToolDeps } from "../../tools/deps.js";

const tempDirs: string[] = [];
function setupToolWithFileDb(register: (server: any, deps: ToolDeps) => void) {
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

describe("update_dependencies_batch tool", () => {
  it("adds multiple edges idempotently — already-existing skipped not failed", async () => {
    const { invoke, db } = setupToolWithFileDb(registerUpdateDependenciesBatch);
    const { projectId, statusIds } = await seedProject(db);
    const a = await seedIssue(db, projectId, statusIds.Todo, { title: "A", issueNumber: 1 });
    const b = await seedIssue(db, projectId, statusIds.Todo, { title: "B", issueNumber: 2 });
    const c = await seedIssue(db, projectId, statusIds.Todo, { title: "C", issueNumber: 3 });

    const first = parseResult(await invoke({
      edges: [
        { issueId: a.id, dependsOnId: b.id, action: "add" },
        { issueId: a.id, dependsOnId: c.id, action: "add" },
      ],
    }));
    expect(first.added).toBe(2);
    expect(first.removed).toBe(0);
    expect(first.skipped).toHaveLength(0);

    // Re-add same → skipped
    const second = parseResult(await invoke({
      edges: [
        { issueId: a.id, dependsOnId: b.id, action: "add" },
        { issueId: a.id, dependsOnId: c.id, action: "add" },
      ],
    }));
    expect(second.added).toBe(0);
    expect(second.skipped).toHaveLength(2);
    expect(second.skipped[0].reason).toBe("already exists");
  });

  it("removes existing and skips non-existent removes", async () => {
    const { invoke, db } = setupToolWithFileDb(registerUpdateDependenciesBatch);
    const { projectId, statusIds } = await seedProject(db);
    const a = await seedIssue(db, projectId, statusIds.Todo, { title: "A", issueNumber: 1 });
    const b = await seedIssue(db, projectId, statusIds.Todo, { title: "B", issueNumber: 2 });

    await invoke({ edges: [{ issueId: a.id, dependsOnId: b.id, action: "add" }] });

    const result = parseResult(await invoke({
      edges: [
        { issueId: a.id, dependsOnId: b.id, action: "remove" },
        { issueId: a.id, dependsOnId: b.id, action: "remove" },
      ],
    }));
    expect(result.removed).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe("dependency does not exist");
  });

  it("rejects a batch that introduces a cycle", async () => {
    const { invoke, db } = setupToolWithFileDb(registerUpdateDependenciesBatch);
    const { projectId, statusIds } = await seedProject(db);
    const a = await seedIssue(db, projectId, statusIds.Todo, { title: "A", issueNumber: 1 });
    const b = await seedIssue(db, projectId, statusIds.Todo, { title: "B", issueNumber: 2 });

    const result = await invoke({
      edges: [
        { issueId: a.id, dependsOnId: b.id, action: "add" },
        { issueId: b.id, dependsOnId: a.id, action: "add" },
      ],
    });
    expect(result.content[0].text).toContain("cycle");

    const deps = await db.select().from(schema.issueDependencies);
    expect(deps).toHaveLength(0);
  });

  it("rejects self-dependency", async () => {
    const { invoke, db } = setupToolWithFileDb(registerUpdateDependenciesBatch);
    const { projectId, statusIds } = await seedProject(db);
    const a = await seedIssue(db, projectId, statusIds.Todo, { title: "A", issueNumber: 1 });

    const result = await invoke({
      edges: [{ issueId: a.id, dependsOnId: a.id, action: "add" }],
    });
    expect(result.content[0].text).toContain("cannot depend on itself");
  });
});
