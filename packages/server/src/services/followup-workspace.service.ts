import { randomUUID } from "node:crypto";
import { isTerminalStatusIdView, isTerminalStatusName } from "@agentic-kanban/shared";
import { suggestBranchName } from "@agentic-kanban/shared/lib/branch";
import type { Database } from "../db/index.js";
import * as gitService from "./git.service.js";
import { resolveAgentSettings, toExecutorProvider } from "./agent-settings.service.js";
import type { SessionManager } from "./session.manager.js";
import type { BoardEvents } from "./board-events.js";
import { DEFAULT_BUILDER_GUARDRAILS, PREF_BUILDER_GUARDRAILS } from "../constants/preference-keys.js";
import { hasSkipAutoStartTag } from "../repositories/dependency-auto-chain.repository.js";
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

/** Issues carrying this tag are an explicit opt-out of monitor/cascade auto-start. */
const SKIP_AUTO_START_TAG = "no-auto-start";

/** Statuses a dependent issue must be sitting in for a followup auto-start to be valid.
 * Anything else — including a Cancelled issue whose deps happen to resolve — is NOT
 * an implicit "not Done means startable" case; it must be an explicit backlog status. */
const STARTABLE_STATUS_NAMES = new Set(["Todo", "Backlog"]);

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
  const startableStatusIds = new Set(statuses.filter(s => STARTABLE_STATUS_NAMES.has(s.name)).map(s => s.id));
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

    // A dependent issue that was moved out of the backlog — most notably Cancelled —
    // must not be resurrected just because its blockers finished merging (#219). Only an
    // explicit Todo/Backlog status is a valid launch point; "not Done" is not "startable".
    if (!startableStatusIds.has(followupIssue[0].statusId)) continue;
    if (await hasSkipAutoStartTag(dep.issueId, SKIP_AUTO_START_TAG, database)) continue;

    try {
      // #220 ask 2: this was a THIRD private branch-name derivation. It sliced the slug
      // at 50 chars instead of 40 and skipped the `-+ -> -` collapse, so for the
      // ticket's own fixture title it produced
      // `feature/ak-176-176-follow-up-simplify-updatebase-s-leading-seeded` where
      // `suggestBranchName` produces `...-updatebase-s-lead` — a different branch for the
      // same issue, which is exactly what defeats a guard keyed on the derived name.
      const branch = suggestBranchName(followupIssue[0]);
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
        // #503: was `provider === "codex" ? "codex" : "claude-code"`, which sent BOTH
        // copilot and pi follow-ups to Claude. `provider` here is a ProviderName from
        // resolveAgentSettings, so the mapping is exactly toExecutorProvider's job.
        provider: toExecutorProvider(provider),
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
