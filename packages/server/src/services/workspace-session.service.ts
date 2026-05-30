import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, sessions, sessionMessages, workspaces } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import type { SessionManager } from "./session.manager.js";
import type { BoardEvents } from "./board-events.js";
import { loadAgentSettings, toExecutorProvider } from "./agent-settings.service.js";
import {
  getWorkspaceById,
  resolveProjectId,
  resolveProjectRepo,
  updateWorkspaceStatus,
} from "../repositories/workspace.repository.js";
import {
  findResumableSession,
  getWorkspaceSessions,
  getWorkspaceSkillName,
} from "../repositories/session.repository.js";
import { getPreference } from "../repositories/preferences.repository.js";
import { buildImplementPrompt, buildRejectPrompt, writePlanFile, PLAN_FILE } from "./plan-mode.service.js";
import { stopBisectSession } from "./bisect.service.js";
import {
  WorkspaceError,
  applyWorkspaceAgentSelection,
  type TurnResult,
  type GitService,
} from "./workspace-internals.js";
import * as realGitService from "./git.service.js";

export function createWorkspaceSessionService(deps: {
  database: Database;
  getSessionManager?: () => SessionManager;
  boardEvents?: BoardEvents;
  gitService?: GitService;
}) {
  const { database, getSessionManager, boardEvents } = deps;
  const gitService = deps.gitService ?? realGitService;

  async function launchSession(id: string, body: Record<string, unknown> = {}) {
    const ws0 = await getWorkspaceById(id, database);
    if (!ws0) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!getSessionManager) throw new WorkspaceError("Session manager not available", "BAD_REQUEST");

    let prompt = body.prompt as string | undefined;
    if (!prompt) {
      const issueRows = await database
        .select({ title: issues.title, description: issues.description })
        .from(issues)
        .where(eq(issues.id, ws0.issueId))
        .limit(1);
      if (issueRows.length === 0) {
        throw new WorkspaceError("Cannot build prompt: issue not found", "NOT_FOUND");
      }
      const iss = issueRows[0];
      prompt = iss.description ? `${iss.title}\n\n${iss.description}` : iss.title;
    }

    const { agentCommand, agentArgs, claudeProfile, profile: agentProfile, provider: agentProvider, resumeWithNewModel, permissionPromptTool } =
      applyWorkspaceAgentSelection(await loadAgentSettings(database, body.agentCommand as string | undefined), ws0);

    const truncatedPrompt = prompt.length > 80 ? prompt.slice(0, 80) + "..." : prompt;
    const skipPermissions = typeof body.skipPermissions === "boolean" ? body.skipPermissions : undefined;

    console.log(`[workspace-service] launch: workspaceId=${id} prompt="${truncatedPrompt}" agentCommand=${agentCommand ?? "default"} agentArgs=${agentArgs ?? "none"} profile=${claudeProfile ?? "none"} resumeFromId=${body.resumeFromId ?? "none"} resumeWithNewModel=${resumeWithNewModel} skipPermissions=${skipPermissions ?? "default"}`);

    // Auto-rebase onto baseBranch on continue (not first launch, not direct workspaces)
    if (!ws0.isDirect && ws0.workingDir) {
      const autoRebasePref = await getPreference("auto_rebase_on_continue", database);
      if (autoRebasePref === "true") {
        const priorSessions = await getWorkspaceSessions(id, database);
        if (priorSessions.length > 0) {
          const { defaultBranch } = await resolveProjectRepo(id, database);
          const baseBranch = ws0.baseBranch || defaultBranch;
          if (baseBranch) {
            console.log(`[workspace-session] auto-rebase on launch: workspaceId=${id} baseBranch=${baseBranch}`);
            const rebaseResult = await gitService.rebaseOntoBase(ws0.workingDir, baseBranch, ws0.branch);
            if (!rebaseResult.success) {
              try { await gitService.abortRebase(ws0.workingDir); } catch { /* best effort */ }
              throw new WorkspaceError(
                `Auto-rebase onto '${baseBranch}' failed before starting agent. ` +
                  `Resolve conflicts manually or disable auto_rebase_on_continue. ` +
                  `Conflicting files: ${(rebaseResult.conflictingFiles ?? []).join(", ")}`,
                "CONFLICT",
                { conflictingFiles: rebaseResult.conflictingFiles ?? [], rebaseError: rebaseResult.error },
              );
            }
            console.log(`[workspace-session] auto-rebase succeeded on launch: workspaceId=${id}`);
          }
        }
      }
    }

    const planMode = ws0.planMode ?? false;
    const resumeFromId = typeof body.resumeFromId === "string" ? body.resumeFromId : undefined;

    const sessionId = await getSessionManager().startSession({
      workspaceId: id, prompt, agentCommand, agentArgs, resumeFromId, claudeProfile,
      provider: toExecutorProvider(agentProvider), multiTurn: false, permissionPromptTool,
      planMode, resumeWithNewModel, triggerType: "chat", profile: agentProfile, skipPermissions,
    });

    await updateWorkspaceStatus(id, "active", {
      claudeProfile: claudeProfile ?? null,
      agentCommand: agentCommand ?? null,
      provider: agentProvider,
    }, database);

    const projectId = await resolveProjectId(id, database);
    if (projectId) boardEvents?.broadcast(projectId, "session_launched");

    return { sessionId };
  }

  async function sendTurn(id: string, content: string): Promise<TurnResult> {
    if (!getSessionManager) throw new WorkspaceError("Session manager not available", "BAD_REQUEST");

    const resumable = await findResumableSession(id, database);
    if (!resumable) {
      throw new WorkspaceError("No session found for this workspace", "NOT_FOUND");
    }

    if (resumable.session.status === "running") {
      const result = getSessionManager().sendTurn(resumable.session.id, content);
      if (!result.ok) {
        throw new WorkspaceError(result.error || "Agent is busy", "CONFLICT");
      }
      return { type: "sent" };
    }

    const ws0 = await getWorkspaceById(id, database);
    if (!ws0) throw new WorkspaceError("Workspace not found", "NOT_FOUND");

    // Auto-rebase onto baseBranch before resuming (sendTurn is always a continue scenario)
    if (!ws0.isDirect && ws0.workingDir) {
      const autoRebasePref = await getPreference("auto_rebase_on_continue", database);
      if (autoRebasePref === "true") {
        const { defaultBranch } = await resolveProjectRepo(id, database);
        const baseBranch = ws0.baseBranch || defaultBranch;
        if (baseBranch) {
          console.log(`[workspace-session] auto-rebase on turn: workspaceId=${id} baseBranch=${baseBranch}`);
          const rebaseResult = await gitService.rebaseOntoBase(ws0.workingDir, baseBranch, ws0.branch);
          if (!rebaseResult.success) {
            try { await gitService.abortRebase(ws0.workingDir); } catch { /* best effort */ }
            throw new WorkspaceError(
              `Auto-rebase onto '${baseBranch}' failed before starting agent. ` +
                `Resolve conflicts manually or disable auto_rebase_on_continue. ` +
                `Conflicting files: ${(rebaseResult.conflictingFiles ?? []).join(", ")}`,
              "CONFLICT",
              { conflictingFiles: rebaseResult.conflictingFiles ?? [], rebaseError: rebaseResult.error },
            );
          }
          console.log(`[workspace-session] auto-rebase succeeded on turn: workspaceId=${id}`);
        }
      }
    }

    const planMode = ws0.planMode ?? false;
    const { agentCommand, agentArgs, claudeProfile, profile, provider, resumeWithNewModel, permissionPromptTool } =
      applyWorkspaceAgentSelection(await loadAgentSettings(database), ws0);

    const sessionId = await getSessionManager().startSession({
      workspaceId: id, prompt: content, agentCommand, agentArgs,
      resumeFromId: resumable.session.id, claudeProfile, profile,
      provider: toExecutorProvider(provider), multiTurn: false, planMode,
      resumeWithNewModel, permissionPromptTool, triggerType: "chat",
    });

    await updateWorkspaceStatus(id, "active", {
      claudeProfile: claudeProfile ?? null,
      agentCommand: agentCommand ?? null,
      provider,
    }, database);

    const projectId = await resolveProjectId(id, database);
    if (projectId) boardEvents?.broadcast(projectId, "session_launched");

    return { type: "resumed", sessionId };
  }

  async function stopWorkspace(id: string): Promise<{ stopped: boolean }> {
    const runningSessions = await database
      .select()
      .from(sessions)
      .where(eq(sessions.workspaceId, id));

    let stopped = false;
    if (getSessionManager) {
      for (const session of runningSessions) {
        if (session.status === "running") {
          if (session.executor === "auto-bisect" && stopBisectSession(session.id)) {
            stopped = true;
            continue;
          }
          await getSessionManager().stopSession(session.id);
          stopped = true;
        }
      }
    }

    await updateWorkspaceStatus(id, "idle", {}, database);

    const projectId = await resolveProjectId(id, database);
    if (projectId) boardEvents?.broadcast(projectId, "session_stopped");

    return { stopped };
  }

  async function implementPlan(id: string, updatedPlanContent?: string): Promise<{ sessionId: string }> {
    const ws0 = await getWorkspaceById(id, database);
    if (!ws0) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!ws0.pendingPlanPath) throw new WorkspaceError("No pending plan to implement", "CONFLICT");
    if (!getSessionManager) throw new WorkspaceError("Session manager not available", "BAD_REQUEST");

    // If the user edited the plan, overwrite PLAN.md before the agent runs
    if (updatedPlanContent !== undefined && ws0.workingDir) {
      writePlanFile(ws0.workingDir, updatedPlanContent);
    }

    const { agentCommand, agentArgs, claudeProfile, profile: agentProfile, provider: agentProvider, permissionPromptTool } =
      applyWorkspaceAgentSelection(await loadAgentSettings(database, undefined), ws0);

    const sessionId = await getSessionManager().startSession({
      workspaceId: id, prompt: buildImplementPrompt(), agentCommand, agentArgs, claudeProfile,
      provider: toExecutorProvider(agentProvider), multiTurn: false, permissionPromptTool,
      planMode: false, triggerType: "plan-implement", profile: agentProfile,
    });

    const now = new Date().toISOString();
    await database.update(workspaces).set({
      status: "active", pendingPlanPath: null,
      claudeProfile: claudeProfile ?? null, agentCommand: agentCommand ?? null,
      provider: agentProvider, updatedAt: now,
    }).where(eq(workspaces.id, id));

    // Audit trail: record approval as a session message
    const approvalMsg = updatedPlanContent !== undefined
      ? "[Plan gate] User approved plan with edits and started implementation."
      : "[Plan gate] User approved plan and started implementation.";
    await database.insert(sessionMessages).values({
      sessionId,
      type: "stdout",
      data: approvalMsg,
      exitCode: null,
    }).catch((err) => console.warn("[plan-gate] audit message insert failed:", err));

    const projectId = await resolveProjectId(id, database);
    if (projectId) boardEvents?.broadcast(projectId, "session_launched");

    return { sessionId };
  }

  async function rejectPlan(id: string, feedback: string): Promise<{ sessionId: string }> {
    const ws0 = await getWorkspaceById(id, database);
    if (!ws0) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!ws0.pendingPlanPath) throw new WorkspaceError("No pending plan to reject", "CONFLICT");
    if (!getSessionManager) throw new WorkspaceError("Session manager not available", "BAD_REQUEST");

    const { agentCommand, agentArgs, claudeProfile, profile: agentProfile, provider: agentProvider, permissionPromptTool } =
      applyWorkspaceAgentSelection(await loadAgentSettings(database, undefined), ws0);

    const sessionId = await getSessionManager().startSession({
      workspaceId: id, prompt: buildRejectPrompt(feedback), agentCommand, agentArgs, claudeProfile,
      provider: toExecutorProvider(agentProvider), multiTurn: false, permissionPromptTool,
      planMode: true, triggerType: "plan-reject", profile: agentProfile,
    });

    const now = new Date().toISOString();
    await database.update(workspaces).set({
      status: "active", pendingPlanPath: null, planMode: true,
      claudeProfile: claudeProfile ?? null, agentCommand: agentCommand ?? null,
      provider: agentProvider, updatedAt: now,
    }).where(eq(workspaces.id, id));

    // Audit trail: record rejection as a session message
    await database.insert(sessionMessages).values({
      sessionId,
      type: "stdout",
      data: `[Plan gate] User rejected plan. Feedback: ${feedback}`,
      exitCode: null,
    }).catch((err) => console.warn("[plan-gate] audit message insert failed:", err));

    const projectId = await resolveProjectId(id, database);
    if (projectId) boardEvents?.broadcast(projectId, "session_launched");

    return { sessionId };
  }

  async function getPlanContent(id: string): Promise<{ content: string | null; path: string | null }> {
    const ws0 = await getWorkspaceById(id, database);
    if (!ws0) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!ws0.pendingPlanPath || !ws0.workingDir) return { content: null, path: null };

    const planFilePath = join(ws0.workingDir, PLAN_FILE);
    if (!existsSync(planFilePath)) return { content: null, path: ws0.pendingPlanPath };

    try {
      const content = readFileSync(planFilePath, "utf-8");
      return { content, path: ws0.pendingPlanPath };
    } catch {
      return { content: null, path: ws0.pendingPlanPath };
    }
  }

  async function openTerminal(id: string): Promise<{ workingDir: string; command: string }> {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!workspace.workingDir) throw new WorkspaceError("Workspace not set up", "BAD_REQUEST");

    const { agentCommand, agentArgs } = await loadAgentSettings(database);
    const resolvedCommand = agentCommand || "claude";
    const fullCommand = agentArgs ? `${resolvedCommand} ${agentArgs}` : resolvedCommand;

    if (process.platform === "win32") {
      const tmpScript = join(tmpdir(), `terminal-${id}.cmd`);
      writeFileSync(tmpScript, `@cd /d "${workspace.workingDir}"\r\n@${fullCommand}\r\n`);
      spawn("cmd.exe", ["/c", "start", `Terminal - ${workspace.branch}`, tmpScript], {
        detached: true, stdio: "ignore",
      }).unref();
    } else {
      spawn("x-terminal-emulator", [
        "-e", `bash -c 'cd "${workspace.workingDir}" && ${fullCommand}; exec bash'`,
      ], { detached: true, stdio: "ignore" }).unref();
    }

    console.log(`[workspace-service] terminal: workspaceId=${id} workingDir=${workspace.workingDir} command=${fullCommand}`);
    return { workingDir: workspace.workingDir, command: fullCommand };
  }

  async function openEditor(id: string): Promise<void> {
    const ws = await getWorkspaceById(id, database);
    if (!ws) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!ws.workingDir) throw new WorkspaceError("Workspace has no working directory", "BAD_REQUEST");

    const which = spawnSync("code", ["--version"], { shell: true, windowsHide: true });
    if (which.status !== 0) {
      throw new WorkspaceError("VS Code (code) is not installed or not in PATH", "BAD_REQUEST");
    }

    spawn("code", [ws.workingDir], { shell: true, windowsHide: true, detached: true }).unref();
  }

  async function getSessions(workspaceId: string) {
    const ws = await getWorkspaceById(workspaceId, database);
    const skillName = await getWorkspaceSkillName(ws?.skillId ?? null, database);
    const result = await getWorkspaceSessions(workspaceId, database);
    return result.map(s => ({ ...s, skillName }));
  }

  return { launchSession, sendTurn, stopWorkspace, implementPlan, rejectPlan, getPlanContent, openTerminal, openEditor, getSessions };
}
