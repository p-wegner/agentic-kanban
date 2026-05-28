import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { issues, sessions, workspaces } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import type { SessionManager } from "./session.manager.js";
import type { BoardEvents } from "./board-events.js";
import { loadAgentSettings, toExecutorProvider } from "./agent-settings.service.js";
import {
  getWorkspaceById,
  resolveProjectId,
  updateWorkspaceStatus,
} from "../repositories/workspace.repository.js";
import {
  findResumableSession,
  getWorkspaceSessions,
  getWorkspaceSkillName,
} from "../repositories/session.repository.js";
import { buildImplementPrompt } from "./plan-mode.service.js";
import {
  WorkspaceError,
  applyWorkspaceAgentSelection,
  type TurnResult,
} from "./workspace-internals.js";

export function createWorkspaceSessionService(deps: {
  database: Database;
  getSessionManager?: () => SessionManager;
  boardEvents?: BoardEvents;
}) {
  const { database, getSessionManager, boardEvents } = deps;

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

  async function implementPlan(id: string): Promise<{ sessionId: string }> {
    const ws0 = await getWorkspaceById(id, database);
    if (!ws0) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!ws0.pendingPlanPath) throw new WorkspaceError("No pending plan to implement", "CONFLICT");
    if (!getSessionManager) throw new WorkspaceError("Session manager not available", "BAD_REQUEST");

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

    const projectId = await resolveProjectId(id, database);
    if (projectId) boardEvents?.broadcast(projectId, "session_launched");

    return { sessionId };
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

  return { launchSession, sendTurn, stopWorkspace, implementPlan, openTerminal, openEditor, getSessions };
}
