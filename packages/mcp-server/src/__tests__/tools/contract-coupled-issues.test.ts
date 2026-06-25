import { describe, it, expect, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq, inArray } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { registerContractCoupledIssues } from "../../tools/contract-coupled-issues.js";
import { createToolHarness, parseResult } from "../helpers/tool-harness.js";
import { applyMigrationsToClient, type TestDb } from "../helpers/test-db.js";
import { seedProject, seedIssue } from "../helpers/seed.js";
import type { ToolDeps } from "../../tools/deps.js";

const tempDirs: string[] = [];

function setupToolWithFileDb(register: (server: any, deps: ToolDeps) => void) {
  const dir = mkdtempSync(join(tmpdir(), "ak-mcp-contract-"));
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

async function insertDependency(
  db: TestDb,
  issueId: string,
  dependsOnId: string,
  type: "depends_on" | "blocked_by" | "related_to" | "duplicates" | "parent_of" | "child_of" | "coupled_with" = "depends_on",
) {
  await db.insert(schema.issueDependencies).values({
    id: randomUUID(),
    issueId,
    dependsOnId,
    type,
    createdAt: new Date().toISOString(),
  });
}

afterAll(() => {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

describe("contract_coupled_issues tool", () => {
  it("contracts a coupled component through the shared batch applier", async () => {
    const { invoke, db, deps } = setupToolWithFileDb(registerContractCoupledIssues);
    const { projectId, statusIds } = await seedProject(db);
    const lead = await seedIssue(db, projectId, statusIds.Todo, { title: "Lead", issueNumber: 1 });
    const member = await seedIssue(db, projectId, statusIds.Todo, { title: "Member", issueNumber: 2 });
    const external = await seedIssue(db, projectId, statusIds.Todo, { title: "External", issueNumber: 3 });
    await insertDependency(db, lead.id, member.id, "coupled_with");
    await insertDependency(db, member.id, external.id, "depends_on");

    const result = parseResult(await invoke({ issueIds: [lead.id, member.id], leadIssueId: lead.id }));

    expect(result.leadIssueId).toBe(lead.id);
    expect(result.added).toBe(2);
    expect(result.removed).toBe(2);
    expect(deps.notifyBoard).toHaveBeenCalledWith(projectId, "mcp_dependency_added");
    expect(deps.notifyBoard).toHaveBeenCalledWith(projectId, "mcp_issue_updated");

    const depsRows = await db.select().from(schema.issueDependencies);
    const normalizedDeps = depsRows
      .map((dep) => ({ issueId: dep.issueId, dependsOnId: dep.dependsOnId, type: dep.type }))
      .sort((a, b) => `${a.issueId}${a.dependsOnId}${a.type}`.localeCompare(`${b.issueId}${b.dependsOnId}${b.type}`));
    expect(normalizedDeps).toEqual([
      { issueId: member.id, dependsOnId: lead.id, type: "duplicates" },
      { issueId: lead.id, dependsOnId: external.id, type: "depends_on" },
    ].sort((a, b) => `${a.issueId}${a.dependsOnId}${a.type}`.localeCompare(`${b.issueId}${b.dependsOnId}${b.type}`)));

    const issues = await db.select().from(schema.issues).where(inArray(schema.issues.id, [lead.id, member.id]));
    const updatedLead = issues.find((issue) => issue.id === lead.id);
    const absorbedMember = issues.find((issue) => issue.id === member.id);
    expect(updatedLead?.description).toContain("### From #1: Lead");
    expect(updatedLead?.description).toContain("### From #2: Member");
    expect(absorbedMember?.statusId).toBe(statusIds.Cancelled);
    expect(absorbedMember?.description).toContain("Absorbed into #1");
  });

  it("rejects partial coupled component selections", async () => {
    const { invoke, db } = setupToolWithFileDb(registerContractCoupledIssues);
    const { projectId, statusIds } = await seedProject(db);
    const a = await seedIssue(db, projectId, statusIds.Todo, { title: "A", issueNumber: 1 });
    const b = await seedIssue(db, projectId, statusIds.Todo, { title: "B", issueNumber: 2 });
    const c = await seedIssue(db, projectId, statusIds.Todo, { title: "C", issueNumber: 3 });
    await insertDependency(db, a.id, b.id, "coupled_with");
    await insertDependency(db, b.id, c.id, "coupled_with");

    const result = await invoke({ issueIds: [a.id, b.id], leadIssueId: a.id });

    expect(result.content[0].text).toContain("exactly match");
    const depsRows = await db.select().from(schema.issueDependencies);
    expect(depsRows).toHaveLength(2);
  });

  it("rejects components with open workspaces before mutating", async () => {
    const { invoke, db } = setupToolWithFileDb(registerContractCoupledIssues);
    const { projectId, statusIds } = await seedProject(db);
    const a = await seedIssue(db, projectId, statusIds.Todo, { title: "A", issueNumber: 1 });
    const b = await seedIssue(db, projectId, statusIds.Todo, { title: "B", issueNumber: 2 });
    await insertDependency(db, a.id, b.id, "coupled_with");
    await db.insert(schema.workspaces).values({
      id: randomUUID(),
      issueId: b.id,
      status: "active",
      branch: "feature/open",
      workingDir: "/tmp/open",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = await invoke({ issueIds: [a.id, b.id], leadIssueId: a.id });

    expect(result.content[0].text).toContain("open workspaces");
    const stillTodo = await db.select().from(schema.issues).where(eq(schema.issues.id, b.id));
    expect(stillTodo[0].statusId).toBe(statusIds.Todo);
  });
});
