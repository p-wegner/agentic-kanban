/**
 * Regression tests for AK-535: agents moving issues to terminal Done before merge
 * causes silent merge loss — the issue disappears from the board but the branch
 * was never merged into the default branch.
 *
 * Guard: both move_issue and update_issue must reject a terminal-status move
 * (Done / Cancelled) when the issue has an open workspace that has not been merged.
 */
import { describe, it, expect } from "vitest";
import * as schema from "@agentic-kanban/shared/schema";
import { registerMoveIssue } from "../../tools/move-issue.js";
import { registerUpdateIssue } from "../../tools/update-issue.js";
import { setupTool, parseResult } from "../helpers/tool-harness.js";
import { seedProject, seedIssue } from "../helpers/seed.js";
import { randomUUID } from "node:crypto";

async function seedOpenWorkspace(
  db: ReturnType<typeof setupTool>["db"],
  issueId: string,
  overrides: Partial<{ status: string; mergedAt: string | null }> = {},
) {
  const now = new Date().toISOString();
  const workspaceId = randomUUID();
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/ak-99-test",
    workingDir: "/repo/.worktrees/feature_ak-99-test",
    baseBranch: "master",
    isDirect: false,
    status: overrides.status ?? "idle",
    mergedAt: overrides.mergedAt ?? null,
    readyForMerge: true,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });
  return workspaceId;
}

describe("terminal-Done guard — move_issue", () => {
  it("blocks move to Done when issue has an open unmerged workspace", async () => {
    const { invoke, db } = setupTool(registerMoveIssue);
    const { projectId, statusIds } = await seedProject(db);
    const { id: issueId } = await seedIssue(db, projectId, statusIds["In Review"]);
    await seedOpenWorkspace(db, issueId, { status: "idle" });

    const result = await invoke({ issueId, statusName: "Done" });
    const text = result.content[0].text;
    // Must return an error, not a success
    const parsed = JSON.parse(text);
    expect(parsed.error).toBeDefined();
    expect(parsed.code).toBe("OPEN_WORKSPACE_NOT_MERGED");
  });

  it("blocks move to Cancelled when issue has an active workspace", async () => {
    const { invoke, db } = setupTool(registerMoveIssue);
    const { projectId, statusIds } = await seedProject(db);
    const { id: issueId } = await seedIssue(db, projectId, statusIds["In Progress"]);
    await seedOpenWorkspace(db, issueId, { status: "active" });

    const result = await invoke({ issueId, statusName: "Cancelled" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBeDefined();
    expect(parsed.code).toBe("OPEN_WORKSPACE_NOT_MERGED");
  });

  it("allows move to Done when workspace is already closed (merged)", async () => {
    const { invoke, db } = setupTool(registerMoveIssue);
    const { projectId, statusIds } = await seedProject(db);
    const { id: issueId } = await seedIssue(db, projectId, statusIds["In Review"]);
    // Closed workspace: already merged
    const now = new Date().toISOString();
    await db.insert(schema.workspaces).values({
      id: randomUUID(),
      issueId,
      branch: "feature/ak-99-test",
      isDirect: false,
      status: "closed",
      mergedAt: now,
      readyForMerge: false,
      provider: "claude",
      createdAt: now,
      updatedAt: now,
    });

    const result = await invoke({ issueId, statusName: "Done" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBeUndefined();
    expect(parsed.movedTo).toBe("Done");
  });

  it("allows move to Done for an issue with no workspaces", async () => {
    const { invoke, db } = setupTool(registerMoveIssue);
    const { projectId, statusIds } = await seedProject(db);
    const { id: issueId } = await seedIssue(db, projectId, statusIds["In Review"]);

    const result = await invoke({ issueId, statusName: "Done" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBeUndefined();
    expect(parsed.movedTo).toBe("Done");
  });

  it("allows move to In Progress with an open workspace (non-terminal move)", async () => {
    const { invoke, db } = setupTool(registerMoveIssue);
    const { projectId, statusIds } = await seedProject(db);
    const { id: issueId } = await seedIssue(db, projectId, statusIds["Todo"]);
    await seedOpenWorkspace(db, issueId, { status: "idle" });

    const result = await invoke({ issueId, statusName: "In Progress" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBeUndefined();
    expect(parsed.movedTo).toBe("In Progress");
  });

  it("allows move to Done when workspace is closed but has no mergedAt (direct workspace close)", async () => {
    const { invoke, db } = setupTool(registerMoveIssue);
    const { projectId, statusIds } = await seedProject(db);
    const { id: issueId } = await seedIssue(db, projectId, statusIds["In Review"]);
    const now = new Date().toISOString();
    await db.insert(schema.workspaces).values({
      id: randomUUID(),
      issueId,
      branch: "feature/ak-99-direct",
      isDirect: true,
      status: "closed",
      mergedAt: null,
      readyForMerge: false,
      provider: "claude",
      createdAt: now,
      updatedAt: now,
    });

    const result = await invoke({ issueId, statusName: "Done" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBeUndefined();
    expect(parsed.movedTo).toBe("Done");
  });
});

describe("terminal-Done guard — update_issue", () => {
  it("blocks statusName=Done when issue has an open unmerged workspace", async () => {
    const { invoke, db } = setupTool(registerUpdateIssue);
    const { projectId, statusIds } = await seedProject(db);
    const { id: issueId } = await seedIssue(db, projectId, statusIds["In Review"]);
    await seedOpenWorkspace(db, issueId, { status: "idle" });

    const result = await invoke({ issueId, statusName: "Done" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBeDefined();
    expect(parsed.code).toBe("OPEN_WORKSPACE_NOT_MERGED");
  });

  it("allows statusName=Done when workspace is already closed", async () => {
    const { invoke, db } = setupTool(registerUpdateIssue);
    const { projectId, statusIds } = await seedProject(db);
    const { id: issueId } = await seedIssue(db, projectId, statusIds["In Review"]);
    const now = new Date().toISOString();
    await db.insert(schema.workspaces).values({
      id: randomUUID(),
      issueId,
      branch: "feature/test",
      isDirect: false,
      status: "closed",
      mergedAt: now,
      readyForMerge: false,
      provider: "claude",
      createdAt: now,
      updatedAt: now,
    });

    const result = await invoke({ issueId, statusName: "Done" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBeUndefined();
    expect(parsed.updated).toContain("statusId");
  });

  it("allows updating other fields without status change even with open workspace", async () => {
    const { invoke, db } = setupTool(registerUpdateIssue);
    const { projectId, statusIds } = await seedProject(db);
    const { id: issueId } = await seedIssue(db, projectId, statusIds["In Progress"]);
    await seedOpenWorkspace(db, issueId, { status: "active" });

    const result = await invoke({ issueId, priority: "high" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBeUndefined();
    expect(parsed.updated).toContain("priority");
  });
});
