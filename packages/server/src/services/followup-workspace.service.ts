import { randomUUID } from "node:crypto";
import { workspaces, sessions, issues, projects, projectStatuses, issueDependencies } from "@agentic-kanban/shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import type { Database } from "../db/index.js";
import * as gitService from "./git.service.js";
import { resolveAgentSettings } from "./agent-settings.service.js";
import type { SessionManager } from "./session.manager.js";
import type { BoardEvents } from "./board-events.js";

/**
 * After an issue is merged, find issues that depended on it and are now unblocked.
 * An issue is unblocked when all its depends_on/blocked_by dependencies are Done.
 * For unblocked issues that have no active workspace, create a workspace and launch agent.
 */
export async function autoStartFollowups(
  mergedIssueId: string,
  projectId: string,
  database: Database,
  getSessionManager: () => SessionManager,
  prefMap: Map<string, string>,
  options?: { boardEvents?: BoardEvents },
): Promise<void> {
  const dependents = await database
    .select({ issueId: issueDependencies.issueId, type: issueDependencies.type })
    .from(issueDependencies)
    .where(and(
      eq(issueDependencies.dependsOnId, mergedIssueId),
      inArray(issueDependencies.type, ["depends_on", "blocked_by"]),
    ));

  if (dependents.length === 0) return;

  const statuses = await database.select().from(projectStatuses).where(eq(projectStatuses.projectId, projectId));
  const terminalNames = new Set(["Done", "Cancelled"]);
  const doneStatusIds = new Set(statuses.filter(s => terminalNames.has(s.name)).map(s => s.id));
  const todoStatus = statuses.find(s => s.name === "Todo") ?? statuses[0];
  const project = await database.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project[0]) return;
  if (!project[0].defaultBranch) {
    console.warn(`[followup-workspace] default branch is not configured for project ${projectId}; skipping auto-start follow-ups`);
    return;
  }

  for (const dep of dependents) {
    const allDeps = await database
      .select({ dependsOnId: issueDependencies.dependsOnId, type: issueDependencies.type })
      .from(issueDependencies)
      .where(and(
        eq(issueDependencies.issueId, dep.issueId),
        inArray(issueDependencies.type, ["depends_on", "blocked_by"]),
      ));

    const depIssueIds = allDeps.map(d => d.dependsOnId);
    if (depIssueIds.length === 0) continue;

    const depIssueRows = await database
      .select({ id: issues.id, statusId: issues.statusId })
      .from(issues)
      .where(inArray(issues.id, depIssueIds));

    const allResolved = depIssueRows.every(i => doneStatusIds.has(i.statusId));
    if (!allResolved) continue;

    const existingWs = await database
      .select({ id: workspaces.id, status: workspaces.status })
      .from(workspaces)
      .where(eq(workspaces.issueId, dep.issueId));
    const hasActive = existingWs.some(w => w.status !== "closed");
    if (hasActive) continue;

    const followupIssue = await database.select().from(issues).where(eq(issues.id, dep.issueId)).limit(1);
    if (!followupIssue[0]) continue;

    try {
      const sanitized = followupIssue[0].title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50);
      const branch = `feature/ak-${followupIssue[0].issueNumber ?? "f"}-${sanitized}`;
      const wsId = randomUUID();
      const now = new Date().toISOString();

      const worktreePath = await gitService.createWorktree(project[0].repoPath, branch, project[0].defaultBranch);

      await database.insert(workspaces).values({
        id: wsId,
        issueId: dep.issueId,
        branch,
        status: "idle",
        workingDir: worktreePath,
        baseBranch: project[0].defaultBranch,
        isDirect: false,
        planMode: false,
        createdAt: now,
        updatedAt: now,
      });

      const inProgressStatus = statuses.find(s => s.name === "In Progress") ?? todoStatus;
      await database.update(issues).set({ statusId: inProgressStatus.id, updatedAt: now, statusChangedAt: now }).where(eq(issues.id, dep.issueId));

      const { agentCommand, agentArgs, claudeProfile, profile, provider } = resolveAgentSettings(prefMap);
      const prompt = `${followupIssue[0].title}\n\n${followupIssue[0].description ?? ""}`.trim();

      await getSessionManager().startSession({ workspaceId: wsId, prompt, agentCommand, agentArgs, claudeProfile, profile, provider: provider === "codex" ? "codex" : "claude-code", triggerType: "auto-start" });
      await database.update(workspaces).set({ status: "active", updatedAt: now }).where(eq(workspaces.id, wsId));

      console.log(`[followup-workspace] auto-started follow-up workspace for issue ${followupIssue[0].issueNumber ?? dep.issueId}`);
      options?.boardEvents?.broadcast(projectId, "workspace_merged");
    } catch (err) {
      console.warn(`[followup-workspace] failed to auto-start follow-up for issue ${dep.issueId}:`, err);
    }
  }
}
