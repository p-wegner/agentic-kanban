import { Hono } from "hono";
import { db } from "../db/index.js";
import { workspaces, sessions, issues, preferences, diffComments, agentSkills } from "@agentic-kanban/shared/schema";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as gitService from "../services/git.service.js";
import { killProcessesInDir } from "../services/process-cleanup.js";
import { runScript } from "../services/script-runner.js";
import type { SessionManager } from "../services/session.manager.js";
import type { BoardEvents } from "../services/board-events.js";
import type { Database } from "../db/index.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { resolveProjectRepo, resolveProjectFull, resolveProjectId, moveIssueToDone, getWorkspaceById, updateWorkspaceStatus } from "../repositories/workspace.repository.js";
import { loadAgentSettings, toExecutorProvider, type AgentSettings } from "../services/agent-settings.service.js";
import { buildImplementPrompt } from "../services/plan-mode.service.js";
import { PREF_AUTO_START_FOLLOWUP } from "../constants/preference-keys.js";
import { autoStartFollowups } from "../services/followup-workspace.service.js";
import { parseDiffStats } from "../services/board-aggregation.service.js";
import { getConflictingFiles, buildConflictResolutionPrompt, runLearningStep } from "../services/merge-helpers.service.js";
import type { ProviderName } from "../services/agent-provider.js";

function applyWorkspaceAgentSelection(settings: AgentSettings, workspace: typeof workspaces.$inferSelect): AgentSettings {
  const provider = workspace.provider;
  if (provider !== "claude" && provider !== "codex" && provider !== "copilot") return settings;

  const profileName = workspace.claudeProfile || undefined;
  const agentArgs = provider === "claude"
    ? settings.agentArgs
    : settings.agentArgs
      ?.split(/\s+/)
      .filter((arg) => arg && arg !== "--dangerously-skip-permissions")
      .join(" ") || undefined;
  return {
    ...settings,
    agentArgs,
    provider,
    claudeProfile: provider === "claude" ? profileName : undefined,
    profile: profileName ? { provider: provider as ProviderName, name: profileName } : undefined,
  };
}

export function createWorkspaceActionsRoute(
  getSessionManager: () => SessionManager,
  database: Database = db,
  options?: { boardEvents?: BoardEvents; fixAndMergeSessionIds?: Set<string> },
) {
  const router = new Hono();

  // POST /api/workspaces/:id/setup — create git worktree (no-op if already set up)
  router.post("/:id/setup", async (c) => {
    const id = c.req.param("id");

    const workspace = await getWorkspaceById(id, database);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);

    // Already set up — return existing info
    if (workspace.workingDir) {
      return c.json({ id, workingDir: workspace.workingDir });
    }

    try {
      const { repoPath, defaultBranch } = await resolveProjectRepo(id, database);
      const baseBranch = workspace.baseBranch || defaultBranch;
      console.log(`[workspace-actions] setup: workspaceId=${id} branch=${workspace.branch} repoPath=${repoPath} baseBranch=${baseBranch}`);

      const worktreePath = await gitService.createWorktree(repoPath, workspace.branch, baseBranch);
      console.log(`[workspace-actions] setup complete: workspaceId=${id} worktreePath=${worktreePath}`);

      const now = new Date().toISOString();
      await database
        .update(workspaces)
        .set({ workingDir: worktreePath, baseBranch, updatedAt: now })
        .where(eq(workspaces.id, id));

      // Broadcast board event
      const projectId = await resolveProjectId(id, database);
      if (projectId) options?.boardEvents?.broadcast(projectId, "workspace_setup");

      return c.json({ id, workingDir: worktreePath });
    } catch (err) {
      return c.json(
        { error: `Worktree setup failed: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }
  });

  // POST /api/workspaces/:id/terminal — open a terminal in the workspace directory
  router.post("/:id/terminal", async (c) => {
    const id = c.req.param("id");

    const workspace = await getWorkspaceById(id, database);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);
    if (!workspace.workingDir) {
      return c.json({ error: "Workspace not set up" }, 400);
    }

    try {
      const { agentCommand, agentArgs } = await loadAgentSettings(database);
      const resolvedCommand = agentCommand || "claude";
      const fullCommand = agentArgs ? `${resolvedCommand} ${agentArgs}` : resolvedCommand;

      if (process.platform === "win32") {
        // Write a temp batch file to avoid quoting/escaping issues with nested cmd.exe
        const tmpScript = join(tmpdir(), `terminal-${id}.cmd`);
        writeFileSync(tmpScript, `@cd /d "${workspace.workingDir}"\r\n@${fullCommand}\r\n`);
        spawn("cmd.exe", ["/c", "start", `Terminal - ${workspace.branch}`, tmpScript], {
          detached: true,
          stdio: "ignore",
        }).unref();
      } else {
        spawn("x-terminal-emulator", [
          "-e", `bash -c 'cd "${workspace.workingDir}" && ${fullCommand}; exec bash'`,
        ], {
          detached: true,
          stdio: "ignore",
        }).unref();
      }

      console.log(`[workspace-actions] terminal: workspaceId=${id} workingDir=${workspace.workingDir} command=${fullCommand}`);
      return c.json({ ok: true, workingDir: workspace.workingDir, command: fullCommand });
    } catch (err) {
      return c.json(
        { error: `Terminal launch failed: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }
  });

  // POST /api/workspaces/:id/launch — start agent session
  router.post("/:id/launch", async (c) => {
    const id = c.req.param("id");
    let body: Record<string, unknown> = {};
    try { body = await c.req.json(); } catch { /* empty body is fine */ }

    const ws0 = await getWorkspaceById(id, database);
    if (!ws0) return c.json({ error: "Workspace not found" }, 404);

    // Auto-build prompt from issue when not provided
    if (!body.prompt) {
      const ws = ws0;
      const issueRows = await database
        .select({ title: issues.title, description: issues.description })
        .from(issues)
        .where(eq(issues.id, ws.issueId))
        .limit(1);
      if (issueRows.length === 0) {
        return c.json({ error: "prompt is required" }, 400);
      }
      const iss = issueRows[0];
      body = { ...body, prompt: iss.description ? `${iss.title}\n\n${iss.description}` : iss.title };
    }

    try {
      const { agentCommand, agentArgs, claudeProfile, profile: agentProfile, provider: agentProvider, resumeWithNewModel, permissionPromptTool } =
        applyWorkspaceAgentSelection(await loadAgentSettings(database, body.agentCommand as string | undefined), ws0);

      const promptStr = body.prompt as string;
      const truncatedPrompt = promptStr.length > 80 ? promptStr.slice(0, 80) + "..." : promptStr;
      console.log(`[workspace-actions] launch: workspaceId=${id} prompt="${truncatedPrompt}" agentCommand=${agentCommand ?? "default"} agentArgs=${agentArgs ?? "none"} profile=${claudeProfile ?? "none"} resumeFromId=${body.resumeFromId ?? "none"} resumeWithNewModel=${resumeWithNewModel}`);

      const planMode = ws0.planMode ?? false;

      const resumeFromId = typeof body.resumeFromId === "string" ? body.resumeFromId : undefined;
      const sessionId = await getSessionManager().startSession({ workspaceId: id, prompt: promptStr, agentCommand, agentArgs, resumeFromId, claudeProfile, provider: toExecutorProvider(agentProvider), multiTurn: false, permissionPromptTool, planMode, resumeWithNewModel, triggerType: "chat", profile: agentProfile });

      await updateWorkspaceStatus(id, "active", { claudeProfile: claudeProfile ?? null, agentCommand: agentCommand ?? null, provider: agentProvider }, database);

      // Broadcast board event
      const projectId = await resolveProjectId(id, database);
      if (projectId) options?.boardEvents?.broadcast(projectId, "session_launched");

      return c.json({ sessionId }, 201);
    } catch (err) {
      return c.json(
        { error: `Launch failed: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }
  });

  // POST /api/workspaces/:id/turn — send follow-up message to active session (multi-turn)
  // If the agent process is gone (stale session), launches a new session with --resume
  router.post("/:id/turn", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();

    if (!body.content) {
      return c.json({ error: "content is required" }, 400);
    }

    // Find running session for this workspace; fall back to most recent completed session for stale-resume
    const allSessions = await database
      .select()
      .from(sessions)
      .where(eq(sessions.workspaceId, id));

    const running = allSessions.find(s => s.status === "running")
      ?? allSessions.filter(s => s.status === "completed" || s.status === "stopped")
           .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))[0];

    if (!running) {
      return c.json({ error: "No session found for this workspace" }, 404);
    }

    const result = running.status === "running"
      ? getSessionManager().sendTurn(running.id, body.content)
      : { ok: false as const, error: "Agent process has exited", stale: true };
    if (!result.ok) {
      if ((result as any).stale) {
        // Process is gone — launch a new session with --resume
        const wsForTurn = await getWorkspaceById(id, database);
        if (!wsForTurn) return c.json({ error: "Workspace not found" }, 404);
        const planMode = wsForTurn?.planMode ?? false;
        const { agentCommand, agentArgs, claudeProfile, profile, provider, resumeWithNewModel } =
          applyWorkspaceAgentSelection(await loadAgentSettings(database), wsForTurn);

        const sessionId = await getSessionManager().startSession({ workspaceId: id, prompt: body.content, agentCommand, agentArgs, resumeFromId: running.id, claudeProfile, profile, provider: toExecutorProvider(provider), multiTurn: false, planMode, resumeWithNewModel, triggerType: "chat" });
        await updateWorkspaceStatus(id, "active", { claudeProfile: claudeProfile ?? null, agentCommand: agentCommand ?? null, provider: provider }, database);
        const projectId = await resolveProjectId(id, database);
        if (projectId) options?.boardEvents?.broadcast(projectId, "session_launched");
        return c.json({ sessionId, resumed: true }, 201);
      }
      return c.json({ error: result.error }, 409);
    }

    return c.json({ ok: true });
  });

  // POST /api/workspaces/:id/stop — kill current session
  router.post("/:id/stop", async (c) => {
    const id = c.req.param("id");
    console.log(`[workspace-actions] stop: workspaceId=${id}`);

    // Find running sessions for this workspace
    const runningSessions = await database
      .select()
      .from(sessions)
      .where(eq(sessions.workspaceId, id));

    let stopped = false;
    for (const session of runningSessions) {
      if (session.status === "running") {
        await getSessionManager().stopSession(session.id);
        stopped = true;
      }
    }

    await updateWorkspaceStatus(id, "idle", {}, database);

    // Broadcast board event
    const projectId = await resolveProjectId(id, database);
    if (projectId) options?.boardEvents?.broadcast(projectId, "session_stopped");

    return c.json({ stopped });
  });

  // POST /api/workspaces/:id/implement-plan — accept a pending plan and start implementation
  router.post("/:id/implement-plan", async (c) => {
    const id = c.req.param("id");
    const ws0 = await getWorkspaceById(id, database);
    if (!ws0) return c.json({ error: "Workspace not found" }, 404);
    if (!ws0.pendingPlanPath) return c.json({ error: "No pending plan to implement" }, 409);

    try {
      const { agentCommand, agentArgs, claudeProfile, profile: agentProfile, provider: agentProvider, permissionPromptTool } =
        applyWorkspaceAgentSelection(await loadAgentSettings(database, undefined), ws0);

      const sessionId = await getSessionManager().startSession({
        workspaceId: id,
        prompt: buildImplementPrompt(),
        agentCommand,
        agentArgs,
        claudeProfile,
        provider: toExecutorProvider(agentProvider),
        multiTurn: false,
        permissionPromptTool,
        planMode: false,
        triggerType: "plan-implement",
        profile: agentProfile,
      });

      const now = new Date().toISOString();
      await database.update(workspaces).set({ status: "active", pendingPlanPath: null, claudeProfile: claudeProfile ?? null, agentCommand: agentCommand ?? null, provider: agentProvider, updatedAt: now }).where(eq(workspaces.id, id));

      const projectId = await resolveProjectId(id, database);
      if (projectId) options?.boardEvents?.broadcast(projectId, "session_launched");

      return c.json({ sessionId }, 201);
    } catch (err) {
      return c.json({ error: `Implement-plan failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // GET /api/workspaces/:id/latest-commit — get latest commit SHA and message
  router.get("/:id/latest-commit", async (c) => {
    const id = c.req.param("id");
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);
    if (!workspace.workingDir) return c.json({ sha: null, message: null });
    const commit = await gitService.getLatestCommit(workspace.workingDir);
    if (!commit) return c.json({ sha: null, message: null });
    return c.json(commit);
  });

  // GET /api/workspaces/:id/diff — get git diff
  router.get("/:id/diff", async (c) => {
    const id = c.req.param("id");

    const workspace = await getWorkspaceById(id, database);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);
    if (!workspace.workingDir && !workspace.branch) {
      return c.json({ error: "Workspace not set up" }, 400);
    }

    try {
      let diff = "";
      let conflicts: { hasConflicts: boolean; conflictingFiles: string[] } | null = null;
      const { repoPath, defaultBranch } = await resolveProjectRepo(id, database);
      const baseBranch = workspace.baseBranch || defaultBranch;

      if (workspace.isDirect) {
        diff = workspace.workingDir
          ? await gitService.getWorkingTreeDiff(workspace.workingDir)
          : "";
      } else {
        // Try the worktree first; fall back to main repo if the worktree is prunable/broken
        let usedWorktree = false;
        if (workspace.workingDir) {
          try {
            diff = await gitService.getDiff(workspace.workingDir, baseBranch);
            conflicts = await gitService.detectConflicts(workspace.workingDir, baseBranch);
            usedWorktree = true;
          } catch {
            // Worktree directory exists but is not a valid git repo — fall through to branch-based diff
          }
        }
        if (!usedWorktree) {
          if (workspace.branch) {
            diff = await gitService.getDiffFromRepo(repoPath, workspace.branch, baseBranch);
          } else {
            diff = "";
          }
        }
      }
      const stats = parseDiffStats(diff);
      const comments = await database
        .select()
        .from(diffComments)
        .where(eq(diffComments.workspaceId, id));
      console.log(`[workspace-actions] diff: workspaceId=${id} isDirect=${workspace.isDirect} files=${stats.filesChanged} +${stats.insertions} -${stats.deletions} conflicts=${conflicts?.hasConflicts ?? "n/a"} comments=${comments.length}`);
      return c.json({ diff, stats, comments, conflicts });
    } catch (err) {
      return c.json(
        { error: `Diff failed: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }
  });

  // POST /api/workspaces/:id/merge — merge branch, cleanup, close
  router.post("/:id/merge", async (c) => {
    const id = c.req.param("id");

    const workspace = await getWorkspaceById(id, database);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);

    try {
      const { project, repoPath, defaultBranch } = await resolveProjectFull(id, database);

      // Pre-merge cleanup: kill processes and run teardown script (best effort)
      // Skip process cleanup for direct workspaces — their workingDir is the main repo, killing would take down the dev server
      if (workspace.workingDir && !workspace.isDirect) {
        try {
          const killed = await killProcessesInDir(workspace.workingDir);
          if (killed > 0) console.log(`[workspace-actions] killed ${killed} process(es) in ${workspace.workingDir}`);
        } catch { /* ignore */ }
        if (project?.teardownScript && project.setupEnabled !== false) {
          try {
            const r = await runScript(project.teardownScript, workspace.workingDir, `teardown:${id}`);
            console.log(`[workspace-actions] teardown script: ${r.ok ? "ok" : "failed"} — ${r.output.slice(0, 100)}`);
          } catch { /* ignore */ }
        }
      }

      // Direct workspace: no merge needed, just close
      if (workspace.isDirect) {
        const now = new Date().toISOString();
        await updateWorkspaceStatus(id, "closed", { closedAt: now }, database);

        await moveIssueToDone(id, workspace.issueId, now, database, true);

        const projectId = await resolveProjectId(id, database);
        if (projectId) options?.boardEvents?.broadcast(projectId, "workspace_merged");

        return c.json({ id, mergeOutput: "Direct workspace closed (no merge needed)" });
      }

      // Load preferences once for learning step + auto-start checks
      const prefRows = await database.select().from(preferences);
      const prefMap = new Map(prefRows.map(r => [r.key, r.value]));

      // Optional learning step: run an agent session to extract insights before merge
      if (workspace.workingDir && getSessionManager) {
        await runLearningStep(id, prefMap, database, getSessionManager);
      }

      // Check for merge conflicts before attempting merge
      if (workspace.workingDir) {
        const baseBranch = workspace.baseBranch || defaultBranch;
        const conflicts = await gitService.detectConflicts(workspace.workingDir, baseBranch);
        if (conflicts.hasConflicts) {
          return c.json({ error: "Merge conflicts detected", conflictingFiles: conflicts.conflictingFiles }, 409);
        }
      }

      console.log(`[workspace-actions] merge: workspaceId=${id} branch=${workspace.branch} repoPath=${repoPath}`);

      // Before merging, sync the branch ref to the worktree's HEAD.
      // If the agent committed in detached HEAD, the branch pointer lags behind.
      if (workspace.workingDir) {
        const synced = await gitService.syncBranchToHead(workspace.workingDir, workspace.branch);
        if (synced) {
          console.log(`[workspace-actions] merge: synced branch ${workspace.branch} to worktree HEAD (was detached or ahead)`);
        }
      }

      const result = await gitService.mergeBranch(repoPath, workspace.branch);

      // Cleanup worktree if it exists
      if (workspace.workingDir) {
        try {
          await gitService.removeWorktree(repoPath, workspace.workingDir);
        } catch {
          // Best effort — worktree may already be removed
        }
      }

      // Delete the merged branch (best effort)
      try {
        await gitService.deleteBranch(repoPath, workspace.branch);
        console.log(`[workspace-actions] deleted branch ${workspace.branch}`);
      } catch {
        // Branch may not exist or may not be fully merged — ignore
      }

      const now = new Date().toISOString();
      await updateWorkspaceStatus(id, "closed", { workingDir: null, closedAt: now }, database);

      await moveIssueToDone(id, workspace.issueId, now, database);

      // Broadcast board event
      const projectId = await resolveProjectId(id, database);
      if (projectId) options?.boardEvents?.broadcast(projectId, "workspace_merged");

      // Auto-start follow-up issues if setting enabled
      try {
        if (prefMap.get(PREF_AUTO_START_FOLLOWUP) === "true" && projectId) {
          await autoStartFollowups(workspace.issueId, projectId, database, getSessionManager, prefMap, options);
        }
      } catch (err) {
        console.warn("[workspace-actions] auto_start_followup check failed:", err);
      }

      return c.json({ id, mergeOutput: result });
    } catch (err) {
      return c.json(
        { error: `Merge failed: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }
  });

  // GET /api/workspaces/:id/conflicts — on-demand conflict detection
  router.get("/:id/conflicts", async (c) => {
    const id = c.req.param("id");
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);
    if (!workspace.workingDir || workspace.isDirect) {
      return c.json({ hasConflicts: false, conflictingFiles: [] });
    }
    try {
      const { defaultBranch } = await resolveProjectRepo(id, database);
      const baseBranch = workspace.baseBranch || defaultBranch;
      const result = await gitService.detectConflicts(workspace.workingDir, baseBranch);
      return c.json(result);
    } catch (err) {
      return c.json({ error: `Conflict detection failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // POST /api/workspaces/:id/update-base — rebase or merge base branch into workspace
  router.post("/:id/update-base", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const mode = body.mode === "merge" ? "merge" : "rebase";

    const workspace = await getWorkspaceById(id, database);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);
    if (!workspace.workingDir || workspace.isDirect) {
      return c.json({ error: "Not supported for direct workspaces" }, 400);
    }
    if (workspace.status === "closed") {
      return c.json({ error: "Workspace is closed" }, 400);
    }

    try {
      const { defaultBranch } = await resolveProjectRepo(id, database);
      const baseBranch = workspace.baseBranch || defaultBranch;

      let result: { success: boolean; conflictingFiles?: string[]; error?: string };
      if (mode === "merge") {
        result = await gitService.mergeBaseIntoBranch(workspace.workingDir, baseBranch);
      } else {
        result = await gitService.rebaseOntoBase(workspace.workingDir, baseBranch, workspace.branch);
      }

      console.log(`[workspace-actions] update-base: workspaceId=${id} mode=${mode} success=${result.success} conflicts=${result.conflictingFiles?.length ?? 0}`);

      // Broadcast board event
      const projectId = await resolveProjectId(id, database);
      if (projectId) options?.boardEvents?.broadcast(projectId, "board_changed");

      return c.json(result);
    } catch (err) {
      return c.json({ error: `Update base failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // POST /api/workspaces/:id/abort-rebase — abort in-progress rebase
  router.post("/:id/abort-rebase", async (c) => {
    const id = c.req.param("id");
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);
    if (!workspace.workingDir) {
      return c.json({ error: "Workspace not set up" }, 400);
    }

    try {
      await gitService.abortRebase(workspace.workingDir);
      const projectId = await resolveProjectId(id, database);
      if (projectId) options?.boardEvents?.broadcast(projectId, "board_changed");
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: `Abort rebase failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // POST /api/workspaces/:id/resolve-conflicts — launch AI agent to resolve conflicts
  router.post("/:id/resolve-conflicts", async (c) => {
    const id = c.req.param("id");
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);
    if (!workspace.workingDir) {
      return c.json({ error: "Workspace not set up" }, 400);
    }
    if (workspace.status === "fixing") {
      return c.json({ error: "Conflict resolution already in progress" }, 409);
    }

    try {
      const conflictingFiles = await getConflictingFiles(workspace.workingDir);

      const { defaultBranch } = await resolveProjectRepo(id, database);
      const baseBranch = workspace.baseBranch || defaultBranch;

      const prompt = buildConflictResolutionPrompt(conflictingFiles, baseBranch);

      const { agentCommand, agentArgs, claudeProfile, profile, provider } =
        applyWorkspaceAgentSelection(await loadAgentSettings(database), workspace);

      const sessionId = await getSessionManager().startSession({ workspaceId: id, prompt, agentCommand, agentArgs, claudeProfile, profile, provider: toExecutorProvider(provider), multiTurn: true, triggerType: "fix-conflicts" });
      options?.fixAndMergeSessionIds?.add(sessionId);

      await updateWorkspaceStatus(id, "fixing", {}, database);

      const projectId = await resolveProjectId(id, database);
      if (projectId) options?.boardEvents?.broadcast(projectId, "session_launched");

      return c.json({ sessionId });
    } catch (err) {
      return c.json({ error: `Resolve conflicts failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // GET /api/workspaces/:id/comments — list diff comments
  router.get("/:id/comments", async (c) => {
    const id = c.req.param("id");
    const filePath = c.req.query("filePath");

    const conditions = [eq(diffComments.workspaceId, id)];
    if (filePath) {
      conditions.push(eq(diffComments.filePath, filePath));
    }

    const result = await database
      .select()
      .from(diffComments)
      .where(and(...conditions));
    return c.json(result);
  });

  // POST /api/workspaces/:id/comments — create diff comment
  router.post("/:id/comments", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();

    if (!body.filePath || !body.body) {
      return c.json({ error: "filePath and body are required" }, 400);
    }

    const wsCheck = await getWorkspaceById(id, database);
    if (!wsCheck) return c.json({ error: "Workspace not found" }, 404);

    const now = new Date().toISOString();
    const comment = {
      id: randomUUID(),
      workspaceId: id,
      filePath: body.filePath,
      lineNumOld: body.lineNumOld ?? null,
      lineNumNew: body.lineNumNew ?? null,
      side: body.side || "new",
      body: body.body,
      createdAt: now,
      updatedAt: now,
    };

    await database.insert(diffComments).values(comment);
    return c.json(comment, 201);
  });

  // PATCH /api/workspaces/:id/comments/:commentId — update diff comment
  router.patch("/:id/comments/:commentId", async (c) => {
    const id = c.req.param("id");
    const commentId = c.req.param("commentId");
    const body = await c.req.json();

    if (!body.body) {
      return c.json({ error: "body is required" }, 400);
    }

    const rows = await database
      .select()
      .from(diffComments)
      .where(and(eq(diffComments.id, commentId), eq(diffComments.workspaceId, id)))
      .limit(1);

    if (rows.length === 0) {
      return c.json({ error: "Comment not found" }, 404);
    }

    const now = new Date().toISOString();
    await database
      .update(diffComments)
      .set({ body: body.body, updatedAt: now })
      .where(eq(diffComments.id, commentId));

    return c.json({ id: commentId });
  });

  // DELETE /api/workspaces/:id/comments/:commentId — delete diff comment
  router.delete("/:id/comments/:commentId", async (c) => {
    const id = c.req.param("id");
    const commentId = c.req.param("commentId");

    const rows = await database
      .select()
      .from(diffComments)
      .where(and(eq(diffComments.id, commentId), eq(diffComments.workspaceId, id)))
      .limit(1);

    if (rows.length === 0) {
      return c.json({ error: "Comment not found" }, 404);
    }

    await database.delete(diffComments).where(eq(diffComments.id, commentId));
    return c.json({ success: true });
  });

  // GET /api/workspaces/:id/sessions — list sessions
  router.get("/:id/sessions", async (c) => {
    const id = c.req.param("id");

    const wsSessions = await getWorkspaceById(id, database);
    const skillId = wsSessions?.skillId ?? null;
    let skillName: string | null = null;
    if (skillId) {
      const skillRows = await database
        .select({ name: agentSkills.name })
        .from(agentSkills)
        .where(eq(agentSkills.id, skillId))
        .limit(1);
      skillName = skillRows[0]?.name ?? null;
    }

    const result = await database
      .select()
      .from(sessions)
      .where(eq(sessions.workspaceId, id));

    return c.json(result.map(s => ({ ...s, skillName })));
  });

  // POST /api/workspaces/:id/open-editor — open the workspace directory in VS Code
  router.post("/:id/open-editor", async (c) => {
    const id = c.req.param("id");

    const wsEditor = await getWorkspaceById(id, database);
    if (!wsEditor) return c.json({ error: "Workspace not found" }, 404);

    const { workingDir } = wsEditor;
    if (!workingDir) return c.json({ error: "Workspace has no working directory" }, 422);

    // Verify VS Code is available
    const which = spawnSync("code", ["--version"], { shell: true, windowsHide: true });
    if (which.status !== 0) {
      return c.json({ error: "VS Code (code) is not installed or not in PATH" }, 422);
    }

    spawn("code", [workingDir], { shell: true, windowsHide: true, detached: true }).unref();

    return c.json({ ok: true });
  });

  return router;
}
