import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { showdowns, workspaces, issues, projects, agentSkills } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import type { SessionManager } from "./session.manager.js";
import type { BoardEvents } from "./board-events.js";
import { createWorkspaceCrudService } from "./workspace-crud.service.js";
import type { ShowdownContestant, ShowdownContestantResult, ShowdownResponse } from "@agentic-kanban/shared";
import { WorkspaceError } from "./workspace-internals.js";

const LABELS = ["A", "B", "C", "D"] as const;

export function createShowdownService(deps: {
  database: Database;
  getSessionManager?: () => SessionManager;
  boardEvents?: BoardEvents;
}) {
  const { database, boardEvents } = deps;
  const crudService = createWorkspaceCrudService(deps);

  async function createShowdown(
    issueId: string,
    contestants: ShowdownContestant[],
  ): Promise<ShowdownResponse> {
    if (contestants.length < 2 || contestants.length > 4) {
      throw new WorkspaceError("Showdown requires 2–4 contestants", "BAD_REQUEST");
    }

    // Resolve issue + project
    const issueRows = await database
      .select({ id: issues.id, projectId: issues.projectId, issueNumber: issues.issueNumber, title: issues.title })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    if (issueRows.length === 0) throw new WorkspaceError("Issue not found", "NOT_FOUND");
    const issue = issueRows[0];

    const projectRows = await database
      .select({ defaultBranch: projects.defaultBranch })
      .from(projects)
      .where(eq(projects.id, issue.projectId))
      .limit(1);
    if (projectRows.length === 0) throw new WorkspaceError("Project not found", "NOT_FOUND");
    const defaultBranch = projectRows[0].defaultBranch;

    const now = new Date().toISOString();
    const showdownId = randomUUID();

    await database.insert(showdowns).values({
      id: showdownId,
      issueId,
      status: "active",
      winnerWorkspaceId: null,
      createdAt: now,
      updatedAt: now,
    });

    // Create workspaces for each contestant
    const issueNum = issue.issueNumber ?? issueId.slice(0, 8);
    const createdWorkspaces: { workspaceId: string; label: string; branch: string; skillName: string | null; model: string | null }[] = [];

    for (let i = 0; i < contestants.length; i++) {
      const label = LABELS[i];
      const contestant = contestants[i];
      const branchSuffix = `issue-${issueNum}-showdown-${label}`;
      const branch = `feature/${branchSuffix}`;

      // Build workspace via crud service
      const result = await crudService.createWorkspace({
        issueId,
        branch,
        baseBranch: defaultBranch ?? undefined,
        skillId: contestant.skillId,
        skillName: contestant.skillName,
        model: contestant.model,
        profile: contestant.profile,
        requiresReview: false,
      });

      // Tag workspace with showdown info
      await database.update(workspaces).set({
        showdownId,
        showdownLabel: label,
      }).where(eq(workspaces.id, result.id));

      // Resolve skill name for response
      let skillName: string | null = contestant.skillName ?? null;
      if (!skillName && contestant.skillId) {
        const skillRows = await database.select({ name: agentSkills.name }).from(agentSkills).where(eq(agentSkills.id, contestant.skillId)).limit(1);
        skillName = skillRows[0]?.name ?? null;
      }

      createdWorkspaces.push({
        workspaceId: result.id,
        label,
        branch: result.branch,
        skillName,
        model: contestant.model ?? null,
      });
    }

    // Broadcast board update
    boardEvents?.broadcast(issue.projectId, "workspace_created");

    return {
      id: showdownId,
      issueId,
      status: "active",
      winnerWorkspaceId: null,
      contestants: createdWorkspaces.map(w => ({
        workspaceId: w.workspaceId,
        label: w.label,
        branch: w.branch,
        status: "active",
        skillName: w.skillName,
        model: w.model,
        diffStats: null,
      })),
      createdAt: now,
      updatedAt: now,
    };
  }

  async function getShowdown(showdownId: string): Promise<ShowdownResponse | null> {
    const rows = await database
      .select()
      .from(showdowns)
      .where(eq(showdowns.id, showdownId))
      .limit(1);
    if (rows.length === 0) return null;
    const showdown = rows[0];
    return enrichShowdown(showdown);
  }

  async function getShowdownByIssue(issueId: string): Promise<ShowdownResponse | null> {
    const rows = await database
      .select()
      .from(showdowns)
      .where(eq(showdowns.issueId, issueId))
      .orderBy(showdowns.createdAt)
      .limit(1);
    if (rows.length === 0) return null;
    return enrichShowdown(rows[0]);
  }

  async function enrichShowdown(showdown: typeof showdowns.$inferSelect): Promise<ShowdownResponse> {
    const wsRows = await database
      .select({
        id: workspaces.id,
        branch: workspaces.branch,
        status: workspaces.status,
        showdownLabel: workspaces.showdownLabel,
        skillId: workspaces.skillId,
        model: workspaces.model,
        diffStatCacheFilesChanged: workspaces.diffStatCacheFilesChanged,
        diffStatCacheInsertions: workspaces.diffStatCacheInsertions,
        diffStatCacheDeletions: workspaces.diffStatCacheDeletions,
      })
      .from(workspaces)
      .where(eq(workspaces.showdownId, showdown.id));

    const skillIds = wsRows.map(w => w.skillId).filter(Boolean) as string[];
    const skillMap = new Map<string, string>();
    if (skillIds.length > 0) {
      const skills = await database.select({ id: agentSkills.id, name: agentSkills.name }).from(agentSkills).where(inArray(agentSkills.id, skillIds));
      for (const s of skills) skillMap.set(s.id, s.name);
    }

    const contestants: ShowdownContestantResult[] = wsRows
      .sort((a, b) => (a.showdownLabel ?? "").localeCompare(b.showdownLabel ?? ""))
      .map(w => ({
        workspaceId: w.id,
        label: w.showdownLabel ?? "?",
        branch: w.branch,
        status: w.status,
        skillName: w.skillId ? (skillMap.get(w.skillId) ?? null) : null,
        model: w.model ?? null,
        diffStats: w.diffStatCacheFilesChanged !== null
          ? { filesChanged: w.diffStatCacheFilesChanged ?? 0, insertions: w.diffStatCacheInsertions ?? 0, deletions: w.diffStatCacheDeletions ?? 0 }
          : null,
      }));

    return {
      id: showdown.id,
      issueId: showdown.issueId,
      status: showdown.status,
      winnerWorkspaceId: showdown.winnerWorkspaceId,
      contestants,
      createdAt: showdown.createdAt,
      updatedAt: showdown.updatedAt,
    };
  }

  async function pickWinner(showdownId: string, winnerWorkspaceId: string): Promise<ShowdownResponse> {
    const rows = await database.select().from(showdowns).where(eq(showdowns.id, showdownId)).limit(1);
    if (rows.length === 0) throw new WorkspaceError("Showdown not found", "NOT_FOUND");

    const showdown = rows[0];
    if (showdown.status === "decided") {
      throw new WorkspaceError("Showdown already decided", "BAD_REQUEST");
    }

    // Verify winner workspace belongs to this showdown
    const winnerRows = await database
      .select({ id: workspaces.id, showdownId: workspaces.showdownId, issueId: workspaces.issueId })
      .from(workspaces)
      .where(eq(workspaces.id, winnerWorkspaceId))
      .limit(1);
    if (winnerRows.length === 0 || winnerRows[0].showdownId !== showdownId) {
      throw new WorkspaceError("Workspace does not belong to this showdown", "BAD_REQUEST");
    }

    const now = new Date().toISOString();
    await database.update(showdowns).set({
      status: "decided",
      winnerWorkspaceId,
      updatedAt: now,
    }).where(eq(showdowns.id, showdownId));

    // Delete all loser workspaces (cascade via delete endpoint)
    const allWsRows = await database
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.showdownId, showdownId));

    const losers = allWsRows.filter(w => w.id !== winnerWorkspaceId);
    for (const loser of losers) {
      try {
        const { createWorkspaceService } = await import("./workspace.service.js");
        const svc = createWorkspaceService(deps);
        await svc.deleteWorkspace(loser.id);
      } catch (err) {
        console.warn(`[showdown] Failed to delete loser workspace ${loser.id}:`, err instanceof Error ? err.message : String(err));
      }
    }

    // Broadcast update
    const issueRows = await database.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, showdown.issueId)).limit(1);
    if (issueRows.length > 0) {
      boardEvents?.broadcast(issueRows[0].projectId, "board_changed");
    }

    return (await getShowdown(showdownId))!;
  }

  return { createShowdown, getShowdown, getShowdownByIssue, pickWinner };
}
