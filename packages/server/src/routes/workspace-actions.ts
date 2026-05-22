import { Hono } from "hono";
import { db } from "../db/index.js";
import { workspaces, sessions, issues, projects, preferences, diffComments, projectStatuses, issueDependencies } from "@agentic-kanban/shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as gitService from "../services/git.service.js";
import { killProcessesInDir } from "../services/process-cleanup.js";
import { runScript } from "../services/script-runner.js";
import type { SessionManager } from "../services/session.manager.js";
import type { BoardEvents } from "../services/board-events.js";
import type { Database } from "../db/index.js";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = resolve(__dirname, "../scripts/mock-agent.ts");
// Resolve tsx from server's node_modules so the mock agent works from any CWD (e.g. worktrees)
const TSX_LOADER = resolve(__dirname, "../../node_modules/tsx/dist/loader.mjs");
const TSX_URL = pathToFileURL(TSX_LOADER).href;
const MOCK_AGENT_COMMAND = `node --import ${TSX_URL} "${MOCK_AGENT_PATH}"`;

/**
 * Resolve repo info from workspace → issue → project chain.
 */
async function resolveProjectRepo(
  workspaceId: string,
  database: Database = db,
): Promise<{ repoPath: string; defaultBranch: string }> {
  const wsRows = await database
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (wsRows.length === 0) {
    throw new Error("Workspace not found");
  }

  const issueRows = await database
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, wsRows[0].issueId))
    .limit(1);
  if (issueRows.length === 0) {
    throw new Error("Issue not found");
  }

  const projectRows = await database
    .select({ repoPath: projects.repoPath, defaultBranch: projects.defaultBranch })
    .from(projects)
    .where(eq(projects.id, issueRows[0].projectId))
    .limit(1);
  if (projectRows.length === 0) {
    throw new Error("Project not found");
  }

  return {
    repoPath: projectRows[0].repoPath,
    defaultBranch: projectRows[0].defaultBranch,
  };
}

async function resolveProjectId(
  workspaceId: string,
  database: Database = db,
): Promise<string | null> {
  const wsRows = await database.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (wsRows.length === 0) return null;
  const issueRows = await database.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, wsRows[0].issueId)).limit(1);
  if (issueRows.length === 0) return null;
  return issueRows[0].projectId;
}

export function createWorkspaceActionsRoute(
  getSessionManager: () => SessionManager,
  database: Database = db,
  options?: { boardEvents?: BoardEvents },
) {
  const router = new Hono();

  // POST /api/workspaces/:id/setup — create git worktree (no-op if already set up)
  router.post("/:id/setup", async (c) => {
    const id = c.req.param("id");

    // Look up workspace
    const rows = await database.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    if (rows.length === 0) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const workspace = rows[0];

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

    const rows = await database.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    if (rows.length === 0) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const workspace = rows[0];
    if (!workspace.workingDir) {
      return c.json({ error: "Workspace not set up" }, 400);
    }

    try {
      const prefRows = await database.select().from(preferences);
      const prefMap = new Map(prefRows.map(r => [r.key, r.value]));

      const agentCommand = prefMap.get("agent_command") || "claude";
      const skipPerms = prefMap.get("skip_permissions") === "true";
      const baseArgs = prefMap.get("agent_args") || "";
      const agentArgs = skipPerms
        ? (baseArgs ? baseArgs + " --dangerously-skip-permissions" : "--dangerously-skip-permissions")
        : baseArgs;

      const fullCommand = agentArgs ? `${agentCommand} ${agentArgs}` : agentCommand;

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

    const rows = await database.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    if (rows.length === 0) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    // Auto-build prompt from issue when not provided
    if (!body.prompt) {
      const ws = rows[0];
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
      // Read agent settings from preferences
      const prefRows = await database.select().from(preferences);
      const prefMap = new Map(prefRows.map(r => [r.key, r.value]));

      // Determine agent command: explicit body > mock_agent pref / env > agent_command pref > default
      let agentCommand = body.agentCommand || undefined;
      if (!agentCommand) {
        const useMock = prefMap.get("mock_agent") === "true" || process.env.MOCK_AGENT === "1";
        if (useMock) {
          agentCommand = MOCK_AGENT_COMMAND;
        } else {
          agentCommand = prefMap.get("agent_command") || undefined;
        }
      }
      const skipPerms = prefMap.get("skip_permissions") === "true";
      const baseArgs = prefMap.get("agent_args") || "";
      const agentArgs = skipPerms
        ? (baseArgs ? baseArgs + " --dangerously-skip-permissions" : "--dangerously-skip-permissions")
        : (baseArgs || undefined);
      const claudeProfile = prefMap.get("claude_profile") || undefined;
      const resumeWithNewModel = prefMap.get("resume_with_new_model") === "true";
      const permissionPromptToolPref = prefMap.get("permission_prompt_tool");
      const permissionPromptTool = permissionPromptToolPref === "true"
        ? "mcp__agentic-kanban__approve_tool_use"
        : (permissionPromptToolPref && permissionPromptToolPref !== "false" ? permissionPromptToolPref : undefined);

      const promptStr = body.prompt as string;
      const truncatedPrompt = promptStr.length > 80 ? promptStr.slice(0, 80) + "..." : promptStr;
      console.log(`[workspace-actions] launch: workspaceId=${id} prompt="${truncatedPrompt}" agentCommand=${agentCommand ?? "default"} agentArgs=${agentArgs ?? "none"} profile=${claudeProfile ?? "none"} resumeFromId=${body.resumeFromId ?? "none"} multiTurn=${body.multiTurn !== false} resumeWithNewModel=${resumeWithNewModel}`);

      // Read planMode from workspace record
      const wsRows = await database.select({ planMode: workspaces.planMode }).from(workspaces).where(eq(workspaces.id, id)).limit(1);
      const planMode = wsRows.length > 0 ? wsRows[0].planMode : false;

      const resumeFromId = typeof body.resumeFromId === "string" ? body.resumeFromId : undefined;
      const sessionId = await getSessionManager().startSession(id, promptStr, agentCommand, agentArgs, resumeFromId, claudeProfile, body.multiTurn !== false, permissionPromptTool, planMode, resumeWithNewModel);

      const now = new Date().toISOString();
      await database.update(workspaces).set({ status: "active", claudeProfile: claudeProfile ?? null, agentCommand: agentCommand ?? null, updatedAt: now }).where(eq(workspaces.id, id));

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
        const prefRows = await database.select().from(preferences);
        const prefMap = new Map(prefRows.map((r) => [r.key, r.value]));
        const useMock = prefMap.get("mock_agent") === "true" || process.env.MOCK_AGENT === "1";
        const agentCommand = useMock ? MOCK_AGENT_COMMAND : (prefMap.get("agent_command") || undefined);
        const skipPerms = prefMap.get("skip_permissions") === "true";
        const baseArgs = prefMap.get("agent_args") || "";
        const agentArgs = skipPerms
          ? (baseArgs ? baseArgs + " --dangerously-skip-permissions" : "--dangerously-skip-permissions")
          : (baseArgs || undefined);
        const claudeProfile = prefMap.get("claude_profile") || undefined;
        const resumeWithNewModel = prefMap.get("resume_with_new_model") === "true";
        const wsRows = await database.select({ planMode: workspaces.planMode }).from(workspaces).where(eq(workspaces.id, id)).limit(1);
        const planMode = wsRows.length > 0 ? wsRows[0].planMode : false;

        const sessionId = await getSessionManager().startSession(
          id,
          body.content,
          agentCommand,
          agentArgs,
          running.id,
          claudeProfile,
          true,
          undefined,
          planMode,
          resumeWithNewModel,
        );
        const now = new Date().toISOString();
        await database.update(workspaces).set({ status: "active", claudeProfile: claudeProfile ?? null, agentCommand: agentCommand ?? null, updatedAt: now }).where(eq(workspaces.id, id));
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

    const now = new Date().toISOString();
    await database.update(workspaces).set({ status: "idle", updatedAt: now }).where(eq(workspaces.id, id));

    // Broadcast board event
    const projectId = await resolveProjectId(id, database);
    if (projectId) options?.boardEvents?.broadcast(projectId, "session_stopped");

    return c.json({ stopped });
  });

  // GET /api/workspaces/:id/diff — get git diff
  router.get("/:id/diff", async (c) => {
    const id = c.req.param("id");

    const rows = await database.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    if (rows.length === 0) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const workspace = rows[0];
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

    const rows = await database.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    if (rows.length === 0) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const workspace = rows[0];

    try {
      // Resolve project for teardown script
      const issueRows = await database.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, workspace.issueId)).limit(1);
      const projectRows = issueRows.length > 0
        ? await database.select().from(projects).where(eq(projects.id, issueRows[0].projectId)).limit(1)
        : [];
      const project = projectRows[0] ?? null;

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
        await database
          .update(workspaces)
          .set({ status: "closed", closedAt: now, updatedAt: now })
          .where(eq(workspaces.id, id));

        // Move issue to Done — work is complete after merge
        try {
          const projectId = await resolveProjectId(id, database);
          if (projectId) {
            const statuses = await database.select().from(projectStatuses).where(eq(projectStatuses.projectId, projectId));
            const doneStatus = statuses.find(s => s.name === "Done") ?? statuses.find(s => s.name === "AI Reviewed");
            if (doneStatus) {
              await database.update(issues).set({ statusId: doneStatus.id, updatedAt: now, statusChangedAt: now }).where(eq(issues.id, workspace.issueId));
            }
          }
        } catch (err) {
          console.warn("[workspaces] Failed to move issue to Done:", err);
        }

        const projectId = await resolveProjectId(id, database);
        if (projectId) options?.boardEvents?.broadcast(projectId, "workspace_merged");

        return c.json({ id, mergeOutput: "Direct workspace closed (no merge needed)" });
      }

      // Optional learning step: run an agent session to extract insights before merge
      const prefRowsLearning = await database.select().from(preferences);
      const prefMapLearning = new Map(prefRowsLearning.map(r => [r.key, r.value]));
      if (prefMapLearning.get("learning_step_before_merge") === "true" && workspace.workingDir && getSessionManager) {
        try {
          const learningPrompt = `/learning-step\n\nRun the learning step skill to extract insights from recent session transcripts and update docs/hooks before this workspace is merged.`;
          const agentCmd = prefMapLearning.get("agent_command") || undefined;
          const agentArgs = prefMapLearning.get("agent_args") || undefined;
          const claudeProfile = prefMapLearning.get("claude_profile") || undefined;
          const sm = getSessionManager();
          const learningSessId = await sm.startSession(id, learningPrompt, agentCmd, agentArgs ? agentArgs.split(" ") : undefined, undefined, claudeProfile);
          console.log(`[workspace-actions] learning step started: session=${learningSessId}`);
          // Wait up to 3 minutes for the learning session to complete
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
              console.log("[workspace-actions] learning step timed out after 3m, proceeding with merge");
              resolve();
            }, 3 * 60 * 1000);
            const poll = setInterval(async () => {
              const sessRows = await database.select({ status: sessions.status }).from(sessions).where(eq(sessions.id, learningSessId)).limit(1);
              if (sessRows.length > 0 && sessRows[0].status !== "running") {
                clearInterval(poll);
                clearTimeout(timeout);
                console.log(`[workspace-actions] learning step finished: status=${sessRows[0].status}`);
                resolve();
              }
            }, 5000);
          });
        } catch (err) {
          console.warn("[workspace-actions] learning step failed (non-fatal):", err);
        }
      }

      // Check for merge conflicts before attempting merge
      if (workspace.workingDir) {
        const { repoPath: projectRepo } = await resolveProjectRepo(id, database);
        const projectRows = await database.select({ defaultBranch: projects.defaultBranch }).from(projects).where(eq(projects.repoPath, projectRepo)).limit(1);
        const baseBranch = workspace.baseBranch || projectRows[0]?.defaultBranch || "main";
        const conflicts = await gitService.detectConflicts(workspace.workingDir, baseBranch);
        if (conflicts.hasConflicts) {
          return c.json({ error: "Merge conflicts detected", conflictingFiles: conflicts.conflictingFiles }, 409);
        }
      }

      const { repoPath } = await resolveProjectRepo(id, database);
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
      await database
        .update(workspaces)
        .set({ status: "closed", workingDir: null, closedAt: now, updatedAt: now })
        .where(eq(workspaces.id, id));

      // Auto-move issue to "Done"
      try {
        const projectId = await resolveProjectId(id, database);
        if (projectId) {
          const statuses = await database.select().from(projectStatuses).where(eq(projectStatuses.projectId, projectId));
          const doneStatus = statuses.find(s => s.name === "Done");
          if (doneStatus) {
            await database.update(issues).set({ statusId: doneStatus.id, updatedAt: now, statusChangedAt: now }).where(eq(issues.id, workspace.issueId));
          }
        }
      } catch (err) {
        console.warn("[workspaces] Failed to move issue to Done:", err);
      }

      // Broadcast board event
      const projectId = await resolveProjectId(id, database);
      if (projectId) options?.boardEvents?.broadcast(projectId, "workspace_merged");

      // Auto-start follow-up issues if setting enabled
      try {
        const prefRows2 = await database.select().from(preferences);
        const prefMap2 = new Map(prefRows2.map(r => [r.key, r.value]));
        if (prefMap2.get("auto_start_followup") === "true" && projectId) {
          await autoStartFollowups(workspace.issueId, projectId, database, getSessionManager, prefMap2, options);
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
    const rows = await database.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    if (rows.length === 0) {
      return c.json({ error: "Workspace not found" }, 404);
    }
    const workspace = rows[0];
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

    const rows = await database.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    if (rows.length === 0) {
      return c.json({ error: "Workspace not found" }, 404);
    }
    const workspace = rows[0];
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
    const rows = await database.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    if (rows.length === 0) {
      return c.json({ error: "Workspace not found" }, 404);
    }
    const workspace = rows[0];
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
    const rows = await database.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    if (rows.length === 0) {
      return c.json({ error: "Workspace not found" }, 404);
    }
    const workspace = rows[0];
    if (!workspace.workingDir) {
      return c.json({ error: "Workspace not set up" }, 400);
    }

    try {
      // Get conflicting files from the in-progress rebase/merge
      let conflictingFiles: string[] = [];
      try {
        const unmerged = await gitService.getDiff(workspace.workingDir, "HEAD");
        // Parse file names from the diff output — but simpler to just use diff --name-only
        const { execFile } = await import("node:child_process");
        const output = await new Promise<string>((res, rej) => {
          execFile("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: workspace.workingDir! }, (err, stdout) => {
            if (err) rej(err); else res(stdout.toString());
          });
        });
        conflictingFiles = output.trim().split("\n").filter(Boolean);
      } catch { /* no conflicts or not in merge state */ }

      const { defaultBranch } = await resolveProjectRepo(id, database);
      const baseBranch = workspace.baseBranch || defaultBranch;

      const prompt = `Resolve the merge/rebase conflicts in this workspace.

Conflicting files:
${conflictingFiles.map(f => `- ${f}`).join("\n")}

For each conflicting file:
1. Read the file and examine the conflict markers (<<<<<<<, =======, >>>>>>>)
2. Understand the intent of both changes
3. Resolve the conflict by keeping the correct code from both sides — prefer the feature branch changes unless the base branch change is clearly needed
4. Remove all conflict markers
5. Stage the resolved file with: git add <filename> (use the actual filename)

After resolving all conflicts:
- If this was a rebase: run "git rebase --continue"
- If this was a merge: run "git commit --no-edit"

Base branch: ${baseBranch}`;

      // Read preferences for agent launch
      const prefRows = await database.select().from(preferences);
      const prefMap = new Map(prefRows.map(r => [r.key, r.value]));
      const useMock = prefMap.get("mock_agent") === "true" || process.env.MOCK_AGENT === "1";
      const agentCommand = useMock ? MOCK_AGENT_COMMAND : (prefMap.get("agent_command") || undefined);
      const skipPerms = prefMap.get("skip_permissions") === "true";
      const baseArgs = prefMap.get("agent_args") || "";
      const agentArgs = skipPerms
        ? (baseArgs ? baseArgs + " --dangerously-skip-permissions" : "--dangerously-skip-permissions")
        : (baseArgs || undefined);
      const claudeProfile = prefMap.get("claude_profile") || undefined;

      const sessionId = await getSessionManager().startSession(id, prompt, agentCommand, agentArgs, undefined, claudeProfile, true);

      const now = new Date().toISOString();
      await database.update(workspaces).set({ status: "fixing", updatedAt: now }).where(eq(workspaces.id, id));

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

    const wsRows = await database.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    if (wsRows.length === 0) {
      return c.json({ error: "Workspace not found" }, 404);
    }

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

    const result = await database
      .select()
      .from(sessions)
      .where(eq(sessions.workspaceId, id));

    return c.json(result);
  });

  // POST /api/workspaces/:id/open-editor — open the workspace directory in VS Code
  router.post("/:id/open-editor", async (c) => {
    const id = c.req.param("id");

    const rows = await database.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    if (rows.length === 0) return c.json({ error: "Workspace not found" }, 404);

    const { workingDir } = rows[0];
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

/**
 * After an issue is merged, find issues that depended on it and are now unblocked.
 * An issue is unblocked when all its depends_on/blocked_by dependencies are Done.
 * For unblocked issues that have no active workspace, create a workspace and launch agent.
 */
async function autoStartFollowups(
  mergedIssueId: string,
  projectId: string,
  database: Database,
  getSessionManager: () => SessionManager,
  prefMap: Map<string, string>,
  options?: { boardEvents?: BoardEvents },
): Promise<void> {
  // Find issues that depend on the merged issue
  const dependents = await database
    .select({ issueId: issueDependencies.issueId, type: issueDependencies.type })
    .from(issueDependencies)
    .where(and(
      eq(issueDependencies.dependsOnId, mergedIssueId),
      inArray(issueDependencies.type, ["depends_on", "blocked_by"]),
    ));

  if (dependents.length === 0) return;

  // Load Done/Cancelled statuses for the project
  const statuses = await database.select().from(projectStatuses).where(eq(projectStatuses.projectId, projectId));
  const terminalNames = new Set(["Done", "Cancelled"]);
  const doneStatusIds = new Set(statuses.filter(s => terminalNames.has(s.name)).map(s => s.id));
  const todoStatus = statuses.find(s => s.name === "Todo") ?? statuses[0];
  const project = await database.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project[0]) return;

  for (const dep of dependents) {
    // Check all dependencies of this issue — if all are Done/Cancelled, it's unblocked
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

    // Check this issue doesn't already have an active workspace
    const existingWs = await database
      .select({ id: workspaces.id, status: workspaces.status })
      .from(workspaces)
      .where(eq(workspaces.issueId, dep.issueId));
    const hasActive = existingWs.some(w => w.status !== "closed");
    if (hasActive) continue;

    // Get the follow-up issue details
    const followupIssue = await database.select().from(issues).where(eq(issues.id, dep.issueId)).limit(1);
    if (!followupIssue[0]) continue;

    // Create workspace + launch agent for the follow-up issue
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

      // Move issue to In Progress
      const inProgressStatus = statuses.find(s => s.name === "In Progress") ?? todoStatus;
      await database.update(issues).set({ statusId: inProgressStatus.id, updatedAt: now, statusChangedAt: now }).where(eq(issues.id, dep.issueId));

      const useMock = prefMap.get("mock_agent") === "true" || process.env.MOCK_AGENT === "1";
      const agentCommand = useMock ? MOCK_AGENT_COMMAND : (prefMap.get("agent_command") || undefined);
      const skipPerms = prefMap.get("skip_permissions") === "true";
      const baseArgs = prefMap.get("agent_args") || "";
      const agentArgs = skipPerms
        ? (baseArgs ? baseArgs + " --dangerously-skip-permissions" : "--dangerously-skip-permissions")
        : (baseArgs || undefined);
      const claudeProfile = prefMap.get("claude_profile") || undefined;
      const prompt = `${followupIssue[0].title}\n\n${followupIssue[0].description ?? ""}`.trim();

      await getSessionManager().startSession(wsId, prompt, agentCommand, agentArgs, undefined, claudeProfile);
      await database.update(workspaces).set({ status: "active", updatedAt: now }).where(eq(workspaces.id, wsId));

      console.log(`[workspace-actions] auto-started follow-up workspace for issue ${followupIssue[0].issueNumber ?? dep.issueId}`);
      options?.boardEvents?.broadcast(projectId, "workspace_merged");
    } catch (err) {
      console.warn(`[workspace-actions] failed to auto-start follow-up for issue ${dep.issueId}:`, err);
    }
  }
}

/** Parse basic stats from unified diff output. */
function parseDiffStats(diff: string): { filesChanged: number; insertions: number; deletions: number } {
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ") && !line.startsWith("+++ /dev/null")) {
      filesChanged++;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      insertions++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions++;
    }
  }

  return { filesChanged, insertions, deletions };
}
