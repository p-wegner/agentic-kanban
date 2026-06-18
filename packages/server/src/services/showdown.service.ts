import { randomUUID } from "node:crypto";
import { showdowns } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import type { SessionManager } from "./session.manager.js";
import type { BoardEvents } from "./board-events.js";
import { createWorkspaceCrudService } from "./workspace-crud.service.js";
import type { ShowdownContestant, ShowdownContestantResult, ShowdownResponse } from "@agentic-kanban/shared";
import { WorkspaceError } from "./workspace-internals.js";
import {
  getIssueForShowdown,
  getProjectDefaultBranch,
  insertShowdown,
  tagWorkspaceWithShowdown,
  getAgentSkillName,
  getShowdownById,
  getShowdownByIssueId,
  getShowdownWorkspaces,
  getAgentSkillNamesByIds,
  getShowdownWorkspaceMembership,
  setShowdownWinner,
  getShowdownWorkspaceIds,
  getIssueProjectId,
} from "../repositories/showdown.repository.js";

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
    const issue = await getIssueForShowdown(issueId, database);
    if (!issue) throw new WorkspaceError("Issue not found", "NOT_FOUND");

    const projectRow = await getProjectDefaultBranch(issue.projectId, database);
    if (!projectRow) throw new WorkspaceError("Project not found", "NOT_FOUND");
    const defaultBranch = projectRow.defaultBranch;

    const now = new Date().toISOString();
    const showdownId = randomUUID();

    await insertShowdown({
      id: showdownId,
      issueId,
      status: "active",
      winnerWorkspaceId: null,
      createdAt: now,
      updatedAt: now,
    }, database);

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
      await tagWorkspaceWithShowdown(result.id, showdownId, label, database);

      // Resolve skill name for response
      let skillName: string | null = contestant.skillName ?? null;
      if (!skillName && contestant.skillId) {
        skillName = await getAgentSkillName(contestant.skillId, database);
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
    const showdown = await getShowdownById(showdownId, database);
    if (!showdown) return null;
    return enrichShowdown(showdown);
  }

  async function getShowdownByIssue(issueId: string): Promise<ShowdownResponse | null> {
    const showdown = await getShowdownByIssueId(issueId, database);
    if (!showdown) return null;
    return enrichShowdown(showdown);
  }

  async function enrichShowdown(showdown: typeof showdowns.$inferSelect): Promise<ShowdownResponse> {
    const wsRows = await getShowdownWorkspaces(showdown.id, database);

    const skillIds = wsRows.map(w => w.skillId).filter(Boolean) as string[];
    const skillMap = new Map<string, string>();
    if (skillIds.length > 0) {
      const skills = await getAgentSkillNamesByIds(skillIds, database);
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
    const showdown = await getShowdownById(showdownId, database);
    if (!showdown) throw new WorkspaceError("Showdown not found", "NOT_FOUND");

    if (showdown.status === "decided") {
      throw new WorkspaceError("Showdown already decided", "BAD_REQUEST");
    }

    // Verify winner workspace belongs to this showdown
    const winner = await getShowdownWorkspaceMembership(winnerWorkspaceId, database);
    if (!winner || winner.showdownId !== showdownId) {
      throw new WorkspaceError("Workspace does not belong to this showdown", "BAD_REQUEST");
    }

    const now = new Date().toISOString();
    await setShowdownWinner(showdownId, winnerWorkspaceId, now, database);

    // Delete all loser workspaces (cascade via delete endpoint)
    const allWsRows = await getShowdownWorkspaceIds(showdownId, database);

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
    const issueRow = await getIssueProjectId(showdown.issueId, database);
    if (issueRow) {
      boardEvents?.broadcast(issueRow.projectId, "board_changed");
    }

    return (await getShowdown(showdownId))!;
  }

  return { createShowdown, getShowdown, getShowdownByIssue, pickWinner };
}
