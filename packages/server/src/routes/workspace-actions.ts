import { Hono } from "hono";
import { db } from "../db/index.js";
import { workspaces, sessions, issues, projects, preferences, diffComments, projectStatuses } from "@agentic-kanban/shared/schema";
import { eq, and } from "drizzle-orm";
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
import { spawn } from "node:child_process";

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
    const body = await c.req.json();

    if (!body.prompt) {
      return c.json({ error: "prompt is required" }, 400);
    }

    const rows = await database.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    if (rows.length === 0) {
      return c.json({ error: "Workspace not found" }, 404);
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

      const truncatedPrompt = body.prompt.length > 80 ? body.prompt.slice(0, 80) + "..." : body.prompt;
      console.log(`[workspace-actions] launch: workspaceId=${id} prompt="${truncatedPrompt}" agentCommand=${agentCommand ?? "default"} agentArgs=${agentArgs ?? "none"} profile=${claudeProfile ?? "none"} resumeFromId=${body.resumeFromId ?? "none"} multiTurn=${body.multiTurn !== false} resumeWithNewModel=${resumeWithNewModel}`);

      // Read planMode from workspace record
      const wsRows = await database.select({ planMode: workspaces.planMode }).from(workspaces).where(eq(workspaces.id, id)).limit(1);
      const planMode = wsRows.length > 0 ? wsRows[0].planMode : false;

      const sessionId = await getSessionManager().startSession(id, body.prompt, agentCommand, agentArgs, body.resumeFromId, claudeProfile, body.multiTurn !== false, permissionPromptTool, planMode, resumeWithNewModel);

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
    if (!workspace.workingDir) {
      return c.json({ error: "Workspace not set up" }, 400);
    }

    try {
      let diff: string;
      let conflicts: { hasConflicts: boolean; conflictingFiles: string[] } | null = null;
      if (workspace.isDirect) {
        diff = await gitService.getWorkingTreeDiff(workspace.workingDir);
      } else {
        const { defaultBranch } = await resolveProjectRepo(id, database);
        const baseBranch = workspace.baseBranch || defaultBranch;
        diff = await gitService.getDiff(workspace.workingDir, baseBranch);
        conflicts = await gitService.detectConflicts(workspace.workingDir, baseBranch);
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
      if (workspace.workingDir) {
        try {
          const killed = await killProcessesInDir(workspace.workingDir);
          if (killed > 0) console.log(`[workspace-actions] killed ${killed} process(es) in ${workspace.workingDir}`);
        } catch { /* ignore */ }
        if (project?.teardownScript) {
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
      await database.update(workspaces).set({ status: "active", updatedAt: now }).where(eq(workspaces.id, id));

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

  return router;
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
