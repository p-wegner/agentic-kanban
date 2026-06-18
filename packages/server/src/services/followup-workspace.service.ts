import { randomUUID } from "node:crypto";
import { isTerminalStatusIdView, isTerminalStatusName } from "@agentic-kanban/shared";
import type { Database } from "../db/index.js";
import * as gitService from "./git.service.js";
import { resolveAgentSettings } from "./agent-settings.service.js";
import type { SessionManager } from "./session.manager.js";
import type { BoardEvents } from "./board-events.js";
import { DEFAULT_BUILDER_GUARDRAILS, PREF_BUILDER_GUARDRAILS } from "../constants/preference-keys.js";
import {
  getDependentsOf,
  getProjectStatusesForFollowup,
  getProjectForFollowup,
  getBlockingDepsForIssue,
  getDepIssueStatusRows,
  getWorkspacesForIssue,
  getIssueById,
  insertFollowupWorkspace,
  updateIssueStatus,
  updateWorkspaceStatus,
} from "../repositories/followup-workspace.repository.js";

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
  const dependents = await getDependentsOf(mergedIssueId, database);

  if (dependents.length === 0) return;

  const statuses = await getProjectStatusesForFollowup(projectId, database);
  const doneStatusIds = new Set(statuses.filter(s => isTerminalStatusName(s.name)).map(s => s.id));
  const todoStatus = statuses.find(s => s.name === "Todo") ?? statuses[0];
  const project = await getProjectForFollowup(projectId, database);
  if (!project[0]) return;
  if (!project[0].defaultBranch) {
    console.warn(`[followup-workspace] default branch is not configured for project ${projectId}; skipping auto-start follow-ups`);
    return;
  }

  for (const dep of dependents) {
    const allDeps = await getBlockingDepsForIssue(dep.issueId, database);

    const depIssueIds = allDeps.map(d => d.dependsOnId);
    if (depIssueIds.length === 0) continue;

    const depIssueRows = await getDepIssueStatusRows(depIssueIds, database);

    const allResolved = depIssueRows.every(i => isTerminalStatusIdView(i, doneStatusIds));
    if (!allResolved) continue;

    const existingWs = await getWorkspacesForIssue(dep.issueId, database);
    const hasActive = existingWs.some(w => w.status !== "closed");
    if (hasActive) continue;

    const followupIssue = await getIssueById(dep.issueId, database);
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

      await insertFollowupWorkspace({
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
      }, database);

      const inProgressStatus = statuses.find(s => s.name === "In Progress") ?? todoStatus;
      await updateIssueStatus(dep.issueId, { statusId: inProgressStatus.id, updatedAt: now, statusChangedAt: now }, database);

      const { agentCommand, agentArgs, claudeProfile, profile, provider } = resolveAgentSettings(prefMap);
      const prompt = `${followupIssue[0].title}\n\n${followupIssue[0].description ?? ""}`.trim();

      await getSessionManager().startSession({
        workspaceId: wsId,
        prompt,
        agentCommand,
        agentArgs,
        claudeProfile,
        profile,
        provider: provider === "codex" ? "codex" : "claude-code",
        triggerType: "auto-start",
        systemInstructions: prefMap.get(PREF_BUILDER_GUARDRAILS) ?? DEFAULT_BUILDER_GUARDRAILS,
      });
      await updateWorkspaceStatus(wsId, { status: "active", updatedAt: now }, database);

      console.log(`[followup-workspace] auto-started follow-up workspace for issue ${followupIssue[0].issueNumber ?? dep.issueId}`);
      options?.boardEvents?.broadcast(projectId, "workspace_merged");
    } catch (err) {
      console.warn(`[followup-workspace] failed to auto-start follow-up for issue ${dep.issueId}:`, err);
    }
  }
}
