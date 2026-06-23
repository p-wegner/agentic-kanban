import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq, or } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { registerDeleteIssue } from "../../tools/delete-issue.js";
import { registerDeleteWorkspace } from "../../tools/delete-workspace.js";
import { parseResult, setupTool } from "../helpers/tool-harness.js";
import { seedIssue, seedProject } from "../helpers/seed.js";
import type { TestDb } from "../helpers/test-db.js";

async function seedWorkspace(db: TestDb, issueId: string): Promise<string> {
  const workspaceId = randomUUID();
  const now = new Date().toISOString();
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    issueId,
    branch: `feature/${workspaceId}`,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  return workspaceId;
}

async function seedWorkspaceChildren(
  db: TestDb,
  projectId: string,
  issueId: string,
  workspaceId: string,
): Promise<string> {
  const now = new Date().toISOString();
  const sessionId = randomUUID();
  await db.insert(schema.sessions).values({
    id: sessionId,
    workspaceId,
    status: "running",
    startedAt: now,
  });
  await db.insert(schema.sessionMessages).values({
    sessionId,
    type: "stdout",
    data: "hello",
    createdAt: now,
  });
  await db.insert(schema.diffComments).values({
    id: randomUUID(),
    workspaceId,
    filePath: "src/file.ts",
    side: "new",
    body: "comment",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.issueArtifacts).values({
    id: randomUUID(),
    issueId,
    workspaceId,
    type: "text",
    content: "workspace artifact",
    createdAt: now,
  });
  await db.insert(schema.issueComments).values({
    id: randomUUID(),
    issueId,
    workspaceId,
    kind: "note",
    author: "agent",
    body: "workspace comment",
    createdAt: now,
  });
  await db.insert(schema.repos).values({
    id: randomUUID(),
    workspaceId,
    projectId,
    path: `C:/tmp/${workspaceId}`,
    createdAt: now,
  });
  await db.insert(schema.testRetryDecisions).values({
    id: randomUUID(),
    sessionId,
    workspaceId,
    testName: "retry me",
    decision: "flake",
    confidence: 0.9,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.workflowTransitions).values({
    id: randomUUID(),
    workspaceId,
    toNodeId: "review",
    summary: "advanced",
    triggeredBy: "agent",
    createdAt: now,
  });
  return sessionId;
}

describe("delete cascade tools", () => {
  it("delete_workspace removes every workspace-scoped child row through the shared cascade", async () => {
    const { invoke, db, deps } = setupTool(registerDeleteWorkspace);
    const { projectId, statusIds } = await seedProject(db);
    const issue = await seedIssue(db, projectId, statusIds["In Progress"]);
    const workspaceId = await seedWorkspace(db, issue.id);
    const sessionId = await seedWorkspaceChildren(db, projectId, issue.id, workspaceId);

    const result = await invoke({ workspaceId });

    expect(parseResult(result)).toEqual({ id: workspaceId, deleted: true });
    expect(deps.notifyBoard).toHaveBeenCalledWith(projectId, "mcp_delete_workspace");
    expect(await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId))).toHaveLength(0);
    expect(await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId))).toHaveLength(0);
    expect(await db.select().from(schema.sessionMessages).where(eq(schema.sessionMessages.sessionId, sessionId))).toHaveLength(0);
    expect(await db.select().from(schema.workflowTransitions).where(eq(schema.workflowTransitions.workspaceId, workspaceId))).toHaveLength(0);
    expect(await db.select().from(schema.testRetryDecisions).where(eq(schema.testRetryDecisions.workspaceId, workspaceId))).toHaveLength(0);
    expect(await db.select().from(schema.diffComments).where(eq(schema.diffComments.workspaceId, workspaceId))).toHaveLength(0);
    expect(await db.select().from(schema.issueArtifacts).where(eq(schema.issueArtifacts.workspaceId, workspaceId))).toHaveLength(0);
    expect(await db.select().from(schema.issueComments).where(eq(schema.issueComments.workspaceId, workspaceId))).toHaveLength(0);
    expect(await db.select().from(schema.repos).where(eq(schema.repos.workspaceId, workspaceId))).toHaveLength(0);
    expect(await db.select().from(schema.issues).where(eq(schema.issues.id, issue.id))).toHaveLength(1);
  });

  it("delete_issue removes issue-scoped rows and workspace children through the shared cascade", async () => {
    const { invoke, db, deps } = setupTool(registerDeleteIssue);
    const { projectId, statusIds } = await seedProject(db);
    const issue = await seedIssue(db, projectId, statusIds["In Progress"], { issueNumber: 1 });
    const otherIssue = await seedIssue(db, projectId, statusIds["Todo"], { issueNumber: 2 });
    const workspaceId = await seedWorkspace(db, issue.id);
    const sessionId = await seedWorkspaceChildren(db, projectId, issue.id, workspaceId);
    const now = new Date().toISOString();
    const tagId = randomUUID();

    await db.insert(schema.issueArtifacts).values({
      id: randomUUID(),
      issueId: issue.id,
      workspaceId: null,
      type: "text",
      content: "issue artifact",
      createdAt: now,
    });
    await db.insert(schema.issueComments).values({
      id: randomUUID(),
      issueId: issue.id,
      workspaceId: null,
      kind: "note",
      author: "user",
      body: "issue comment",
      createdAt: now,
    });
    await db.insert(schema.issueTimeEntries).values({
      id: randomUUID(),
      issueId: issue.id,
      minutes: 15,
      note: null,
      createdAt: now,
    });
    await db.insert(schema.showdowns).values({
      id: randomUUID(),
      issueId: issue.id,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.issueDependencies).values({
      id: randomUUID(),
      issueId: issue.id,
      dependsOnId: otherIssue.id,
      type: "depends_on",
      createdAt: now,
    });
    await db.insert(schema.issueDependencies).values({
      id: randomUUID(),
      issueId: otherIssue.id,
      dependsOnId: issue.id,
      type: "blocked_by",
      createdAt: now,
    });
    await db.insert(schema.tags).values({ id: tagId, name: "cascade", color: null, createdAt: now });
    await db.insert(schema.issueTags).values({ id: randomUUID(), issueId: issue.id, tagId });

    const result = await invoke({ issueId: issue.id });

    expect(parseResult(result)).toEqual({ id: issue.id, deleted: true });
    expect(deps.notifyBoard).toHaveBeenCalledWith(projectId, "mcp_delete_issue");
    expect(await db.select().from(schema.issues).where(eq(schema.issues.id, issue.id))).toHaveLength(0);
    expect(await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId))).toHaveLength(0);
    expect(await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId))).toHaveLength(0);
    expect(await db.select().from(schema.issueArtifacts).where(eq(schema.issueArtifacts.issueId, issue.id))).toHaveLength(0);
    expect(await db.select().from(schema.issueComments).where(eq(schema.issueComments.issueId, issue.id))).toHaveLength(0);
    expect(await db.select().from(schema.issueTimeEntries).where(eq(schema.issueTimeEntries.issueId, issue.id))).toHaveLength(0);
    expect(await db.select().from(schema.showdowns).where(eq(schema.showdowns.issueId, issue.id))).toHaveLength(0);
    expect(await db.select().from(schema.issueTags).where(eq(schema.issueTags.issueId, issue.id))).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schema.issueDependencies)
        .where(or(eq(schema.issueDependencies.issueId, issue.id), eq(schema.issueDependencies.dependsOnId, issue.id))),
    ).toHaveLength(0);
    expect(await db.select().from(schema.issues).where(eq(schema.issues.id, otherIssue.id))).toHaveLength(1);
  });
});
