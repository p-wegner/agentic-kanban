import { Hono } from "hono";
import { db } from "../db/index.js";
import { workspaces, issues, projects, preferences, sessions, sessionMessages, diffComments, projectStatuses, agentSkills } from "@agentic-kanban/shared/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as gitService from "../services/git.service.js";
import { runSetupScript } from "../services/setup-script.js";
import type { SessionManager } from "../services/session.manager.js";
import type { BoardEvents } from "../services/board-events.js";
import type { Database } from "../db/index.js";
import type { ProviderId } from "../services/agent-provider.js";
import { writeAgentSkillFile, readLocalSkillPrompt } from "@agentic-kanban/shared/lib/agent-skill-files";
import { resolveAgentSettings } from "../services/agent-settings.service.js";

export function createWorkspacesRoute(
  database: Database = db,
  getSessionManager?: () => SessionManager,
  options?: { boardEvents?: BoardEvents },
) {
  const router = new Hono();

  // POST /api/workspaces — create workspace with worktree + auto-launch agent
  router.post("/", async (c) => {
    const body = await c.req.json();
    const isDirect = body.isDirect === true;
    if (!body.issueId || (!body.branch && !isDirect)) {
      return c.json({ error: "issueId is required; branch is required unless isDirect is true" }, 400);
    }

    const requiresReview = body.requiresReview === true;
    const thoroughReview = body.thoroughReview === true;
    const planMode = body.planMode === true;
    const includeVisualProof = body.includeVisualProof === true;
    const now = new Date().toISOString();
    const id = randomUUID();
    let sessionId: string | undefined;
    let worktreePath: string | null = null;
    let baseBranch: string | null = null;
    let branch: string = body.branch;
    let claudeProfile: string | undefined;
    let agentCommand: string | undefined;

    try {
      // Resolve issue → project to get repoPath and defaultBranch
      const issueRows = await database
        .select({ projectId: issues.projectId, title: issues.title, description: issues.description })
        .from(issues)
        .where(eq(issues.id, body.issueId))
        .limit(1);

      if (issueRows.length === 0) {
        return c.json({ error: "Issue not found" }, 404);
      }

      const issue = issueRows[0];

      const projectRows = await database
        .select({ repoPath: projects.repoPath, defaultBranch: projects.defaultBranch })
        .from(projects)
        .where(eq(projects.id, issue.projectId))
        .limit(1);

      if (projectRows.length === 0) {
        return c.json({ error: "Project not found" }, 404);
      }

      const project = projectRows[0];

      // Fetch setup script config from project
      const setupConfigRows = await database
        .select({ setupScript: projects.setupScript, setupBlocking: projects.setupBlocking, setupEnabled: projects.setupEnabled })
        .from(projects)
        .where(eq(projects.id, issue.projectId))
        .limit(1);
      const setupScript = setupConfigRows[0]?.setupScript;
      const setupBlocking = setupConfigRows[0]?.setupBlocking ?? true;
      const setupEnabled = setupConfigRows[0]?.setupEnabled ?? true;
      const skipSetup = body.skipSetup === true;

      if (isDirect) {
        // Direct workspace: use main checkout, auto-detect branch
        branch = await gitService.getCurrentBranch(project.repoPath);
        worktreePath = project.repoPath;
        baseBranch = null;
      } else {
        // Normal workspace: create worktree
        baseBranch = body.baseBranch || project.defaultBranch;
        worktreePath = await gitService.createWorktree(project.repoPath, branch, baseBranch ?? undefined);
      }

      // Run setup script if configured and enabled
      if (setupScript && worktreePath && setupEnabled && !skipSetup) {
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
          // Parallel: fire-and-forget
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

      // Build prompt: use customPrompt override if provided, otherwise issue title + description
      let agentPrompt: string;
      if (body.customPrompt) {
        agentPrompt = body.customPrompt;
      } else {
        agentPrompt = issue.title;
        if (issue.description) {
          agentPrompt += `\n\n${issue.description}`;
        }
      }
      if (includeVisualProof) {
        const serverPort = process.env.KANBAN_SERVER_PORT || process.env.PORT || "3001";
        agentPrompt += `\n\nAfter completing the implementation, attach visual proof to this ticket. Use the playwright-cli skill to open the running app, take a screenshot of the working result, and post it as an artifact:\nPOST http://localhost:${serverPort}/api/issues/${body.issueId}/artifacts\nBody: { "type": "image", "mimeType": "image/png", "content": "<base64 data URL>", "caption": "Screenshot of the working result" }`;
      }

      // Write skill as a SKILL.md file for progressive disclosure (agent invokes on demand).
      // If the project has a locally installed version (.claude/skills/<name>/SKILL.md in repoPath),
      // use that prompt so users can customise it; otherwise fall back to the DB prompt.
      const skillId: string | null = body.skillId || null;
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

      // Read agent settings from preferences, then allow body.claudeProfile to override
      const prefRows = await database.select().from(preferences);
      const prefMap = new Map(prefRows.map(r => [r.key, r.value]));

      // Per-workspace profile overrides the global preference
      const profileOverride = (body.claudeProfile as string | undefined) || undefined;
      if (profileOverride) prefMap.set("claude_profile", profileOverride);

      const { agentCommand: resolvedCommand, agentArgs, claudeProfile: resolvedProfile, profile: resolvedProfileSelection, permissionPromptTool } = resolveAgentSettings(prefMap);
      agentCommand = resolvedCommand;
      // Keep the raw profile name (including "mock") on the workspace record for display, but pass
      // undefined to the session when it's the mock profile (resolvedProfile is already sanitized)
      claudeProfile = profileOverride || prefMap.get("claude_profile") || undefined;
      const provider = (prefMap.get("provider") || undefined) as ProviderId | undefined;

      // Insert DB record with workingDir and baseBranch
      await database.insert(workspaces).values({
        id,
        issueId: body.issueId,
        branch,
        workingDir: worktreePath,
        baseBranch,
        isDirect,
        requiresReview,
        thoroughReview,
        planMode,
        includeVisualProof,
        skillId,
        status: "active",
        claudeProfile: claudeProfile ?? null,
        agentCommand: agentCommand ?? null,
        createdAt: now,
        updatedAt: now,
      });

      // Auto-move issue to "In Progress" when workspace is created
      try {
        const statuses = await database
          .select()
          .from(projectStatuses)
          .where(eq(projectStatuses.projectId, issue.projectId));
        const inProgress = statuses.find(s => s.name === "In Progress");
        if (inProgress) {
          await database
            .update(issues)
            .set({ statusId: inProgress.id, updatedAt: now, statusChangedAt: now })
            .where(eq(issues.id, body.issueId));
        }
      } catch (err) {
        console.warn("[workspaces] Failed to move issue to In Progress:", err);
      }

      // Auto-launch agent if sessionManager is available
      if (getSessionManager) {
        const truncatedPrompt = agentPrompt.length > 80 ? agentPrompt.slice(0, 80) + "..." : agentPrompt;
        console.log(`[workspaces] auto-launch: workspaceId=${id} branch=${branch} isDirect=${isDirect} prompt="${truncatedPrompt}" agentCommand=${agentCommand ?? "default"}`);
        sessionId = await getSessionManager().startSession(id, agentPrompt, agentCommand, agentArgs, undefined, resolvedProfile, undefined, permissionPromptTool, planMode, undefined, provider, skillName ? `skill:${skillName}` : "agent", resolvedProfileSelection);
      }

      // Broadcast board event
      if (options?.boardEvents) {
        options.boardEvents.broadcast(issue.projectId, "workspace_created");
      }

      return c.json(
        {
          id,
          issueId: body.issueId,
          branch,
          workingDir: worktreePath,
          baseBranch,
          isDirect,
          planMode,
          status: "active",
          sessionId,
          createdAt: now,
          updatedAt: now,
        },
        201,
      );
    } catch (err) {
      // If worktree was created but launch failed, still return workspace with error info
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[workspaces] create failed: ${errorMsg}`);

      // Try to save workspace record even if launch failed
      try {
        await database.insert(workspaces).values({
          id,
          issueId: body.issueId,
          branch,
          workingDir: worktreePath,
          baseBranch,
          isDirect,
          requiresReview,
          thoroughReview,
          planMode,
          includeVisualProof,
          status: "active",
          claudeProfile: claudeProfile ?? null,
          agentCommand: agentCommand ?? null,
          createdAt: now,
          updatedAt: now,
        });
      } catch {
        // DB insert may fail if worktree creation itself failed — that's fine
      }

      return c.json(
        { id, issueId: body.issueId, branch, workingDir: worktreePath, baseBranch, isDirect, planMode, includeVisualProof, status: "active", error: errorMsg },
        201,
      );
    }
  });

  // GET /api/workspaces/:id
  router.get("/:id", async (c) => {
    const id = c.req.param("id");

    const result = await database
      .select({
        id: workspaces.id,
        issueId: workspaces.issueId,
        branch: workspaces.branch,
        workingDir: workspaces.workingDir,
        baseBranch: workspaces.baseBranch,
        isDirect: workspaces.isDirect,
        planMode: workspaces.planMode,
        includeVisualProof: workspaces.includeVisualProof,
        readyForMerge: workspaces.readyForMerge,
        status: workspaces.status,
        createdAt: workspaces.createdAt,
        updatedAt: workspaces.updatedAt,
        issueTitle: issues.title,
        issuePriority: issues.priority,
      })
      .from(workspaces)
      .innerJoin(issues, eq(workspaces.issueId, issues.id))
      .where(eq(workspaces.id, id));

    if (result.length === 0) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const row = result[0];
    return c.json({
      id: row.id,
      issueId: row.issueId,
      branch: row.branch,
      workingDir: row.workingDir,
      baseBranch: row.baseBranch,
      isDirect: row.isDirect,
      planMode: row.planMode,
      includeVisualProof: row.includeVisualProof,
      readyForMerge: row.readyForMerge,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      issue: { title: row.issueTitle, priority: row.issuePriority },
    });
  });

  // PATCH /api/workspaces/:id
  router.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const now = new Date().toISOString();

    const validStatuses = ["active", "reviewing", "idle", "closed"];
    if (body.status && !validStatuses.includes(body.status)) {
      return c.json({ error: "Invalid status. Must be active, reviewing, idle, or closed" }, 400);
    }

    const updates: Record<string, unknown> = { updatedAt: now };
    if (body.status !== undefined) updates.status = body.status;
    if (body.workingDir !== undefined) updates.workingDir = body.workingDir;

    await database.update(workspaces).set(updates).where(eq(workspaces.id, id));

    return c.json({ id });
  });

  // POST /api/workspaces/:id/ready-for-merge — mark workspace as reviewed and ready to merge
  router.post("/:id/ready-for-merge", async (c) => {
    const id = c.req.param("id");
    const wsRows = await database.select({ issueId: workspaces.issueId }).from(workspaces).where(eq(workspaces.id, id)).limit(1);
    if (wsRows.length === 0) return c.json({ error: "Workspace not found" }, 404);

    const now = new Date().toISOString();
    await database.update(workspaces).set({ readyForMerge: true, updatedAt: now }).where(eq(workspaces.id, id));

    if (options?.boardEvents) {
      const issueRows = await database.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, wsRows[0].issueId)).limit(1);
      if (issueRows.length > 0) {
        options.boardEvents.broadcast(issueRows[0].projectId, "workspace_ready_for_merge");
      }
    }

    return c.json({ id, readyForMerge: true });
  });

  // DELETE /api/workspaces/:id — cascade delete sessions and their messages
  router.delete("/:id", async (c) => {
    const id = c.req.param("id");
    // Get session IDs for this workspace
    const wsSessions = await database
      .select({ id: sessions.id, status: sessions.status })
      .from(sessions)
      .where(eq(sessions.workspaceId, id));

    // Kill any running agents before deleting sessions to prevent FK errors
    // from in-flight broadcast callbacks trying to insert session_messages after deletion
    if (getSessionManager && wsSessions.some(s => s.status === "running")) {
      for (const s of wsSessions) {
        if (s.status === "running") {
          await getSessionManager().stopSession(s.id).catch(() => {});
        }
      }
    }

    // Get workspace workingDir + project repoPath before deleting, to clean up the worktree directory
    const wsRow = await database
      .select({ workingDir: workspaces.workingDir, isDirect: workspaces.isDirect, repoPath: projects.repoPath })
      .from(workspaces)
      .leftJoin(issues, eq(workspaces.issueId, issues.id))
      .leftJoin(projects, eq(issues.projectId, projects.id))
      .where(eq(workspaces.id, id))
      .limit(1);
    const workingDir = wsRow[0]?.workingDir;
    const isDirect = wsRow[0]?.isDirect;
    const repoPath = wsRow[0]?.repoPath;

    // Delete diff comments, session messages (cascade via FK on delete), sessions, workspace
    await database.delete(diffComments).where(eq(diffComments.workspaceId, id));
    if (wsSessions.length > 0) {
      const sessionIds = wsSessions.map(s => s.id);
      await database.delete(sessionMessages).where(inArray(sessionMessages.sessionId, sessionIds));
    }
    await database.delete(sessions).where(eq(sessions.workspaceId, id));
    await database.delete(workspaces).where(eq(workspaces.id, id));

    // Remove the worktree directory (non-direct workspaces only)
    if (workingDir && !isDirect && repoPath) {
      try {
        const { rm } = await import("node:fs/promises");
        await rm(workingDir, { recursive: true, force: true });
        // Prune stale worktree references from git so the branch becomes reusable
        await gitService.pruneWorktrees(repoPath).catch(() => {});
      } catch {
        // Best-effort — don't fail the delete if worktree cleanup fails
      }
    }

    return c.json({ success: true });
  });

  return router;
}

export const workspacesRoute = createWorkspacesRoute();
