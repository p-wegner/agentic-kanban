import { randomUUID } from "node:crypto";
import { issues, projects, preferences, workspaces, sessions, sessionMessages, diffComments, agentSkills } from "@agentic-kanban/shared/schema";
import { eq, inArray } from "drizzle-orm";
import type { Database } from "../db/index.js";
import type { SessionManager } from "./session.manager.js";
import type { BoardEvents } from "./board-events.js";
import type { ProviderName } from "./agent-provider.js";
import * as gitService from "./git.service.js";
import { runSetupScript } from "./setup-script.js";
import { writeAgentSkillFile, readLocalSkillPrompt } from "@agentic-kanban/shared/lib/agent-skill-files";
import { resolveAgentSettings, toExecutorProvider } from "./agent-settings.service.js";
import { moveIssueToInProgress } from "../repositories/workspace.repository.js";

// --- Error types for service-to-route communication ---

export class WorkspaceError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "BAD_REQUEST",
  ) {
    super(message);
  }
}

// --- Input / Output types ---

export interface CreateWorkspaceInput {
  issueId: string;
  branch?: string;
  isDirect?: boolean;
  baseBranch?: string;
  requiresReview?: boolean;
  thoroughReview?: boolean;
  planMode?: boolean;
  includeVisualProof?: boolean;
  skipSetup?: boolean;
  customPrompt?: string;
  skillId?: string;
  profile?: { provider?: string; name?: string };
  claudeProfile?: string;
}

export interface CreateWorkspaceResult {
  id: string;
  issueId: string;
  branch: string;
  workingDir: string | null;
  baseBranch: string | null;
  isDirect: boolean;
  planMode: boolean;
  includeVisualProof: boolean;
  status: string;
  provider: ProviderName;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

// --- Service factory ---

export function createWorkspaceService(deps: {
  database: Database;
  getSessionManager?: () => SessionManager;
  boardEvents?: BoardEvents;
}) {
  const { database, getSessionManager, boardEvents } = deps;

  async function createWorkspace(input: CreateWorkspaceInput): Promise<CreateWorkspaceResult> {
    const isDirect = input.isDirect === true;
    const requiresReview = input.requiresReview === true;
    const thoroughReview = input.thoroughReview === true;
    const planMode = input.planMode === true;
    const includeVisualProof = input.includeVisualProof === true;
    const now = new Date().toISOString();
    const id = randomUUID();
    let sessionId: string | undefined;
    let worktreePath: string | null = null;
    let baseBranch: string | null = null;
    let baseCommitSha: string | null = null;
    let branch: string = input.branch ?? "";
    let claudeProfile: string | undefined;
    let agentCommand: string | undefined;
    let resolvedProvider: ProviderName = "claude";

    try {
      // Resolve issue → project
      const issueRows = await database
        .select({ projectId: issues.projectId, title: issues.title, description: issues.description })
        .from(issues)
        .where(eq(issues.id, input.issueId))
        .limit(1);

      if (issueRows.length === 0) {
        throw new WorkspaceError("Issue not found", "NOT_FOUND");
      }

      const issue = issueRows[0];

      const projectRows = await database
        .select({ repoPath: projects.repoPath, defaultBranch: projects.defaultBranch })
        .from(projects)
        .where(eq(projects.id, issue.projectId))
        .limit(1);

      if (projectRows.length === 0) {
        throw new WorkspaceError("Project not found", "NOT_FOUND");
      }

      const project = projectRows[0];

      // Fetch setup script config
      const setupConfigRows = await database
        .select({ setupScript: projects.setupScript, setupBlocking: projects.setupBlocking, setupEnabled: projects.setupEnabled })
        .from(projects)
        .where(eq(projects.id, issue.projectId))
        .limit(1);
      const setupScript = setupConfigRows[0]?.setupScript;
      const setupBlocking = setupConfigRows[0]?.setupBlocking ?? true;
      const setupEnabled = setupConfigRows[0]?.setupEnabled ?? true;

      if (isDirect) {
        branch = await gitService.getCurrentBranch(project.repoPath);
        worktreePath = project.repoPath;
        baseBranch = null;
        baseCommitSha = await gitService.getHeadCommitSha(project.repoPath);
      } else {
        baseBranch = input.baseBranch || project.defaultBranch;
        if (!baseBranch) {
          throw new WorkspaceError(
            "No default branch configured for this project. Set a default branch in project settings or choose a base branch.",
            "BAD_REQUEST",
          );
        }
        worktreePath = await gitService.createWorktree(project.repoPath, branch, baseBranch ?? undefined);
      }

      // Run setup script for isolated git worktrees only
      if (!isDirect && setupScript && worktreePath && setupEnabled && !input.skipSetup) {
        if (setupBlocking) {
          try {
            const result = await runSetupScript(worktreePath, setupScript);
            if (result.exitCode === 0) {
              console.log(`[workspaces] setup complete: workspaceId=${id}`);
            } else {
              console.warn(`[workspaces] setup failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
            }
          } catch (err) {
            console.warn(`[workspaces] setup error: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          runSetupScript(worktreePath, setupScript).then(result => {
            if (result.exitCode === 0) {
              console.log(`[workspaces] parallel setup complete: workspaceId=${id}`);
            } else {
              console.warn(`[workspaces] parallel setup failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
            }
          }).catch(err => {
            console.warn(`[workspaces] parallel setup error: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      }

      // Build agent prompt
      let agentPrompt: string;
      if (input.customPrompt) {
        agentPrompt = input.customPrompt;
      } else {
        agentPrompt = issue.title;
        if (issue.description) {
          agentPrompt += `\n\n${issue.description}`;
        }
      }
      if (includeVisualProof) {
        const serverPort = process.env.KANBAN_SERVER_PORT || process.env.PORT || "3001";
        agentPrompt += `\n\nAfter completing the implementation, attach visual proof to this ticket. Use the playwright-cli skill to open the running app, take a screenshot of the working result, and post it as an artifact:\nPOST http://localhost:${serverPort}/api/issues/${input.issueId}/artifacts\nBody: { "type": "image", "mimeType": "image/png", "content": "<base64 data URL>", "caption": "Screenshot of the working result" }`;
      }

      // Write skill file for progressive disclosure
      const skillId: string | null = input.skillId || null;
      let skillName: string | null = null;
      if (skillId && worktreePath) {
        const skillRows = await database.select().from(agentSkills).where(eq(agentSkills.id, skillId)).limit(1);
        if (skillRows.length > 0) {
          const skill = skillRows[0];
          skillName = skill.name;
          const localPrompt = await readLocalSkillPrompt(project.repoPath, skill.name);
          const effectiveSkill = localPrompt ? { ...skill, prompt: localPrompt } : skill;
          await writeAgentSkillFile(worktreePath, effectiveSkill);
        }
      }

      // Resolve agent settings from preferences + body overrides
      const prefRows = await database.select().from(preferences);
      const prefMap = new Map(prefRows.map(r => [r.key, r.value]));

      const profileOverride = input.profile;
      const legacyProfileOverride = input.claudeProfile;
      if (profileOverride?.name) {
        if (profileOverride.provider === "codex") {
          prefMap.set("codex_profile", profileOverride.name);
          prefMap.set("provider", "codex");
        } else if (profileOverride.provider === "copilot") {
          prefMap.set("copilot_profile", profileOverride.name);
          prefMap.set("provider", "copilot");
        } else {
          prefMap.set("claude_profile", profileOverride.name);
          prefMap.set("provider", "claude");
        }
      } else if (legacyProfileOverride) {
        prefMap.set("claude_profile", legacyProfileOverride);
        prefMap.set("provider", "claude");
      }

      const { agentCommand: resolvedCommand, agentArgs, claudeProfile: resolvedProfile, profile: resolvedProfileSelection, provider, permissionPromptTool } = resolveAgentSettings(prefMap);
      resolvedProvider = provider;
      agentCommand = resolvedCommand;
      claudeProfile = resolvedProfileSelection?.name || legacyProfileOverride || prefMap.get("claude_profile") || undefined;

      // Insert workspace DB record
      await database.insert(workspaces).values({
        id,
        issueId: input.issueId,
        branch,
        workingDir: worktreePath,
        baseBranch,
        isDirect,
        baseCommitSha,
        requiresReview,
        thoroughReview,
        planMode,
        includeVisualProof,
        skillId,
        status: "active",
        claudeProfile: claudeProfile ?? null,
        agentCommand: agentCommand ?? null,
        provider: resolvedProvider,
        createdAt: now,
        updatedAt: now,
      });

      // Auto-move issue to "In Progress"
      await moveIssueToInProgress(input.issueId, issue.projectId, now, database);

      // Auto-launch agent
      if (getSessionManager) {
        const truncatedPrompt = agentPrompt.length > 80 ? agentPrompt.slice(0, 80) + "..." : agentPrompt;
        console.log(`[workspaces] auto-launch: workspaceId=${id} branch=${branch} isDirect=${isDirect} prompt="${truncatedPrompt}" agentCommand=${agentCommand ?? "default"}`);
        const executorProvider = toExecutorProvider(resolvedProvider);
        sessionId = await getSessionManager().startSession({
          workspaceId: id,
          prompt: agentPrompt,
          agentCommand,
          agentArgs,
          claudeProfile: resolvedProfile,
          permissionPromptTool,
          planMode,
          provider: executorProvider,
          triggerType: skillName ? `skill:${skillName}` : "agent",
          profile: resolvedProfileSelection,
        });
      }

      // Broadcast board event
      boardEvents?.broadcast(issue.projectId, "workspace_created");

      return {
        id,
        issueId: input.issueId,
        branch,
        workingDir: worktreePath,
        baseBranch,
        isDirect,
        planMode,
        includeVisualProof,
        status: "active",
        provider: resolvedProvider,
        sessionId,
        createdAt: now,
        updatedAt: now,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Re-throw domain errors (NOT_FOUND, BAD_REQUEST) — these are intentional
      if (err instanceof WorkspaceError) throw err;

      // Unexpected errors: still save workspace record with error info
      console.error(`[workspaces] create failed: ${errorMsg}`);

      try {
        await database.insert(workspaces).values({
          id,
          issueId: input.issueId,
          branch,
          workingDir: worktreePath,
          baseBranch,
          isDirect,
          baseCommitSha,
          requiresReview,
          thoroughReview,
          planMode,
          includeVisualProof,
          status: "active",
          claudeProfile: claudeProfile ?? null,
          agentCommand: agentCommand ?? null,
          provider: resolvedProvider,
          createdAt: now,
          updatedAt: now,
        });
      } catch {
        // DB insert may fail if worktree creation itself failed
      }

      return {
        id,
        issueId: input.issueId,
        branch,
        workingDir: worktreePath,
        baseBranch,
        isDirect,
        planMode,
        includeVisualProof,
        status: "active",
        provider: resolvedProvider,
        createdAt: now,
        updatedAt: now,
        error: errorMsg,
      };
    }
  }

  async function deleteWorkspace(workspaceId: string): Promise<void> {
    // Get session IDs for this workspace
    const wsSessions = await database
      .select({ id: sessions.id, status: sessions.status })
      .from(sessions)
      .where(eq(sessions.workspaceId, workspaceId));

    // Kill any running agents before deleting
    if (getSessionManager && wsSessions.some(s => s.status === "running")) {
      for (const s of wsSessions) {
        if (s.status === "running") {
          await getSessionManager().stopSession(s.id).catch(() => {});
        }
      }
    }

    // Get workspace data for worktree cleanup before deleting
    const wsRow = await database
      .select({ workingDir: workspaces.workingDir, isDirect: workspaces.isDirect, repoPath: projects.repoPath })
      .from(workspaces)
      .leftJoin(issues, eq(workspaces.issueId, issues.id))
      .leftJoin(projects, eq(issues.projectId, projects.id))
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    const workingDir = wsRow[0]?.workingDir;
    const isDirect = wsRow[0]?.isDirect;
    const repoPath = wsRow[0]?.repoPath;

    // Cascade delete: diff comments → session messages → sessions → workspace
    await database.delete(diffComments).where(eq(diffComments.workspaceId, workspaceId));
    if (wsSessions.length > 0) {
      const sessionIds = wsSessions.map(s => s.id);
      await database.delete(sessionMessages).where(inArray(sessionMessages.sessionId, sessionIds));
    }
    await database.delete(sessions).where(eq(sessions.workspaceId, workspaceId));
    await database.delete(workspaces).where(eq(workspaces.id, workspaceId));

    // Remove the worktree directory (non-direct workspaces only)
    if (workingDir && !isDirect && repoPath) {
      try {
        const { rm } = await import("node:fs/promises");
        await rm(workingDir, { recursive: true, force: true });
        await gitService.pruneWorktrees(repoPath).catch(() => {});
      } catch {
        // Best-effort — don't fail if worktree cleanup fails
      }
    }
  }

  async function markReadyForMerge(workspaceId: string): Promise<{ id: string; readyForMerge: boolean }> {
    const wsRows = await database
      .select({ issueId: workspaces.issueId })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (wsRows.length === 0) {
      throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    }

    const now = new Date().toISOString();
    await database.update(workspaces).set({ readyForMerge: true, updatedAt: now }).where(eq(workspaces.id, workspaceId));

    if (boardEvents) {
      const issueRows = await database
        .select({ projectId: issues.projectId })
        .from(issues)
        .where(eq(issues.id, wsRows[0].issueId))
        .limit(1);
      if (issueRows.length > 0) {
        boardEvents.broadcast(issueRows[0].projectId, "workspace_ready_for_merge");
      }
    }

    return { id: workspaceId, readyForMerge: true };
  }

  return { createWorkspace, deleteWorkspace, markReadyForMerge };
}
