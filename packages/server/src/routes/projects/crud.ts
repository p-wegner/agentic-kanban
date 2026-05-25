import { Hono } from "hono";
import { projects, projectStatuses, issues, workspaces, preferences, agentSkills, repos, scheduledRuns, issueTags } from "@agentic-kanban/shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, sep, join } from "node:path";
import { branchExists, detectRepoInfo } from "../../services/git-info.service.js";
import type { Database } from "../../db/index.js";
import { deleteWorkspaceCascade } from "../../repositories/workspace.repository.js";
import { initializeProjectStatuses } from "../../repositories/issue.repository.js";
import { GITIGNORE_TEMPLATES } from "./templates.js";

export function createCrudRoutes(database: Database) {
  const router = new Hono();

  router.get("/", async (c) => {
    const result = await database.select().from(projects);
    return c.json(result);
  });

  router.post("/", async (c) => {
    const body = await c.req.json();
    const now = new Date().toISOString();
    const id = randomUUID();

    if (!body.repoPath) {
      return c.json({ error: "repoPath is required" }, 400);
    }

    let repoInfo;
    try {
      repoInfo = await detectRepoInfo(body.repoPath);
    } catch (err) {
      return c.json(
        { error: `Invalid repo: ${err instanceof Error ? err.message : String(err)}` },
        400,
      );
    }

    const name = body.name || repoInfo.repoName;

    const existing = await database
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.repoPath, repoInfo.repoPath))
      .limit(1);
    if (existing.length > 0) {
      return c.json({ error: `Project "${existing[0].name}" is already registered at this path` }, 409);
    }

    await database.insert(projects).values({
      id,
      name,
      description: body.description ?? null,
      color: body.color ?? null,
      repoPath: repoInfo.repoPath,
      repoName: repoInfo.repoName,
      defaultBranch: repoInfo.defaultBranch,
      remoteUrl: repoInfo.remoteUrl,
      createdAt: now,
      updatedAt: now,
    });

    await initializeProjectStatuses(id, now, database);

    if (body.gitignoreTemplate && GITIGNORE_TEMPLATES[body.gitignoreTemplate]) {
      const gitignorePath = join(repoInfo.repoPath, ".gitignore");
      if (!existsSync(gitignorePath)) {
        try {
          writeFileSync(gitignorePath, GITIGNORE_TEMPLATES[body.gitignoreTemplate], "utf8");
        } catch { /* non-fatal */ }
      }
    }

    if (body.generateReadme) {
      const readmePath = join(repoInfo.repoPath, "README.md");
      if (!existsSync(readmePath)) {
        try {
          writeFileSync(readmePath, `# ${name}\n`, "utf8");
        } catch { /* non-fatal */ }
      }
    }

    return c.json({ id, name, repoPath: repoInfo.repoPath, defaultBranch: repoInfo.defaultBranch }, 201);
  });

  router.post("/create", async (c) => {
    const body = await c.req.json();
    if (!body.name || !body.name.trim()) {
      return c.json({ error: "name is required" }, 400);
    }

    const name = body.name.trim();

    let targetPath: string;
    if (body.path && body.path.trim()) {
      targetPath = resolve(body.path.trim());
    } else {
      if (/[/\\<>:"|?*\x00]/.test(name)) {
        return c.json({ error: 'Project name contains invalid characters. Avoid: / \\ < > : " | ? *' }, 400);
      }

      const baseDirRows = await database
        .select({ value: preferences.value })
        .from(preferences)
        .where(eq(preferences.key, "projects_base_path"))
        .limit(1);
      const baseDir = baseDirRows[0]?.value?.trim();
      if (!baseDir) {
        return c.json({ error: "No base directory configured. Set 'Projects base directory' in Settings › Project, or provide an explicit path." }, 400);
      }
      targetPath = resolve(join(baseDir, name));

      const resolvedBase = resolve(baseDir);
      if (!targetPath.startsWith(resolvedBase + sep) && targetPath !== resolvedBase) {
        return c.json({ error: `Invalid project name: "${name}" would escape the base directory.` }, 400);
      }
    }

    if (existsSync(targetPath)) {
      return c.json({ error: `Directory already exists: ${targetPath}. To use an existing directory, use "Import existing" instead.` }, 409);
    }

    try {
      mkdirSync(targetPath, { recursive: true });
    } catch (err) {
      return c.json({ error: `Failed to create directory: ${err instanceof Error ? err.message : String(err)}` }, 400);
    }

    try {
      execSync("git init", { cwd: targetPath, stdio: "pipe" });
    } catch (err: any) {
      try { rmSync(targetPath, { recursive: true, force: true }); } catch {}
      return c.json({ error: `git init failed: ${err.stderr ? String(err.stderr).trim() : String(err)}` }, 400);
    }

    const existing = await database
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.repoPath, targetPath))
      .limit(1);
    if (existing.length > 0) {
      return c.json({ error: `Project "${existing[0].name}" is already registered at this path` }, 409);
    }

    let repoInfo;
    try {
      repoInfo = await detectRepoInfo(targetPath);
    } catch (err) {
      return c.json({ error: `Failed to read repo info: ${err instanceof Error ? err.message : String(err)}` }, 400);
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    const projectName = body.name?.trim() || repoInfo.repoName;

    await database.insert(projects).values({
      id,
      name: projectName,
      description: body.description ?? null,
      color: body.color ?? null,
      repoPath: repoInfo.repoPath,
      repoName: repoInfo.repoName,
      defaultBranch: repoInfo.defaultBranch,
      remoteUrl: repoInfo.remoteUrl,
      createdAt: now,
      updatedAt: now,
    });

    await initializeProjectStatuses(id, now, database);

    return c.json({ id, name: projectName, repoPath: repoInfo.repoPath, defaultBranch: repoInfo.defaultBranch }, 201);
  });

  router.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const now = new Date().toISOString();

    const updates: Record<string, unknown> = { updatedAt: now };
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.color !== undefined) updates.color = body.color;
    if (body.setupScript !== undefined) updates.setupScript = body.setupScript || null;
    if (body.setupBlocking !== undefined) updates.setupBlocking = !!body.setupBlocking;
    if (body.setupEnabled !== undefined) updates.setupEnabled = !!body.setupEnabled;
    if (body.teardownScript !== undefined) updates.teardownScript = body.teardownScript || null;
    if (body.defaultBranch !== undefined) {
      const projectRows = await database
        .select({ repoPath: projects.repoPath })
        .from(projects)
        .where(eq(projects.id, id))
        .limit(1);
      if (projectRows.length === 0) {
        return c.json({ error: "Project not found" }, 404);
      }

      const nextDefaultBranch = typeof body.defaultBranch === "string"
        ? body.defaultBranch.trim()
        : null;
      if (nextDefaultBranch) {
        const exists = await branchExists(projectRows[0].repoPath, nextDefaultBranch);
        if (!exists) {
          return c.json({ error: `Branch "${nextDefaultBranch}" does not exist in this repo` }, 400);
        }
        updates.defaultBranch = nextDefaultBranch;
      } else {
        updates.defaultBranch = null;
      }
    }

    await database.update(projects).set(updates).where(eq(projects.id, id));
    return c.json({ id });
  });

  router.delete("/:id", async (c) => {
    const projectId = c.req.param("id");

    const projectRows = await database.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
    if (projectRows.length === 0) {
      return c.json({ error: "Project not found" }, 404);
    }

    const projectIssues = await database.select({ id: issues.id }).from(issues).where(eq(issues.projectId, projectId));
    if (projectIssues.length > 0) {
      const issueIds = projectIssues.map((i) => i.id);
      await database.delete(issueTags).where(inArray(issueTags.issueId, issueIds));
      const wsRows = await database.select({ id: workspaces.id }).from(workspaces).where(inArray(workspaces.issueId, issueIds));
      for (const ws of wsRows) {
        await deleteWorkspaceCascade(ws.id, database);
      }
      await database.delete(issues).where(inArray(issues.id, issueIds));
    }

    await database.delete(scheduledRuns).where(eq(scheduledRuns.projectId, projectId));
    await database.delete(agentSkills).where(eq(agentSkills.projectId, projectId));
    await database.delete(repos).where(eq(repos.projectId, projectId));
    await database.delete(projectStatuses).where(eq(projectStatuses.projectId, projectId));
    await database.delete(preferences).where(and(eq(preferences.key, "activeProjectId"), eq(preferences.value, projectId)));
    await database.delete(projects).where(eq(projects.id, projectId));

    return c.json({ success: true });
  });

  return router;
}
