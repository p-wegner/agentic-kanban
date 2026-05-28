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
});
