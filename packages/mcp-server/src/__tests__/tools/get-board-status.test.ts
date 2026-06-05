import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { registerGetBoardStatus } from "../../tools/get-board-status.js";
import { setupTool, parseResult } from "../helpers/tool-harness.js";
import { seedProject, seedIssue } from "../helpers/seed.js";

describe("get_board_status tool", () => {
  it("returns zeroed totals and an empty issue list for a project with no issues", async () => {
    const { invoke, db } = setupTool(registerGetBoardStatus);
    const { projectId } = await seedProject(db);

    const data = parseResult(await invoke({ projectId }));

    expect(data.project.id).toBe(projectId);
    expect(data.totals).toEqual({ totalIssues: 0, inProgress: 0, activeWorkspaces: 0, runningSessions: 0 });
    expect(data.issues).toEqual([]);
  });

  it("reports in-progress issues with workspace state and computed diff stats", async () => {
    const getDiffShortstat = vi.fn(async () => ({ filesChanged: 3, insertions: 40, deletions: 5 }));
    const { invoke, db } = setupTool(registerGetBoardStatus, { getDiffShortstat });
    const { projectId, statusIds } = await seedProject(db);
    const { id: issueId } = await seedIssue(db, projectId, statusIds["In Progress"], { title: "WIP", issueNumber: 7 });

    const now = new Date().toISOString();
    const workspaceId = randomUUID();
    await db.insert(schema.workspaces).values({
      id: workspaceId, issueId, branch: "feature/ak-7", workingDir: "/tmp/repo/.worktrees/ak-7",
      baseBranch: "main", isDirect: false, status: "active", provider: "claude",
      createdAt: now, updatedAt: now,
    });

    const data = parseResult(await invoke({ projectId }));

    expect(data.totals.totalIssues).toBe(1);
    expect(data.totals.inProgress).toBe(1);
    expect(data.totals.activeWorkspaces).toBe(1);
    expect(data.issues).toHaveLength(1);

    const entry = data.issues[0];
    expect(entry.issueNumber).toBe(7);
    expect(entry.workspace.branch).toBe("feature/ak-7");
    expect(entry.diffStats).toEqual({ filesChanged: 3, insertions: 40, deletions: 5 });
    expect(getDiffShortstat).toHaveBeenCalledWith("/tmp/repo/.worktrees/ak-7", "main");
  });

  it("excludes Done/Cancelled issues by default and includes them when includeClosed is true", async () => {
    const { invoke, db } = setupTool(registerGetBoardStatus);
    const { projectId, statusIds } = await seedProject(db);

    await seedIssue(db, projectId, statusIds["In Progress"], { title: "Active", issueNumber: 1 });
    await seedIssue(db, projectId, statusIds["Done"], { title: "Shipped", issueNumber: 2 });
    await seedIssue(db, projectId, statusIds["Cancelled"], { title: "Dropped", issueNumber: 3 });

    // Default (includeClosed=false): only the active issue is returned.
    const defaultData = parseResult(await invoke({ projectId }));
    expect(defaultData.totals.totalIssues).toBe(1);
    expect(defaultData.issues).toHaveLength(1);
    expect(defaultData.issues[0].issueNumber).toBe(1);

    // With includeClosed=true: all three issues are returned.
    const closedData = parseResult(await invoke({ projectId, includeClosed: true }));
    expect(closedData.totals.totalIssues).toBe(3);
    expect(closedData.issues).toHaveLength(3);
  });

  it("reflects updated Done count immediately after an issue is merged (no cache in MCP path)", async () => {
    const { eq } = await import("drizzle-orm");
    const { invoke, db } = setupTool(registerGetBoardStatus);
    const { projectId, statusIds } = await seedProject(db);

    const { id: issueId } = await seedIssue(db, projectId, statusIds["In Review"], { title: "Pending merge", issueNumber: 5 });

    // Before merge: issue is In Review, not visible without includeClosed.
    let data = parseResult(await invoke({ projectId, includeClosed: true }));
    expect(data.totals.totalIssues).toBe(1);
    expect(data.issues[0].statusName).toBe("In Review");

    // Simulate merge: update DB status to Done (same as what merge-workflow does).
    await db.update(schema.issues).set({ statusId: statusIds["Done"] }).where(eq(schema.issues.id, issueId));

    // MCP reads DB directly — no cache, so count updates immediately.
    data = parseResult(await invoke({ projectId, includeClosed: true }));
    expect(data.totals.totalIssues).toBe(1);
    expect(data.issues[0].statusName).toBe("Done");

    // Without includeClosed the Done issue must not appear.
    data = parseResult(await invoke({ projectId }));
    expect(data.totals.totalIssues).toBe(0);
    expect(data.issues).toHaveLength(0);
  });
});
