import { Hono } from "hono";
import { db } from "../db/index.js";
import { projects, projectStatuses, issues, workspaces, preferences, tags, issueTags } from "@agentic-kanban/shared/schema";
import { eq, sql, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { detectRepoInfo } from "../services/git-info.service.js";
import { listBranches, listWorktrees, getDiffShortstat, removeWorktree } from "../services/git.service.js";
import type { Database } from "../db/index.js";
import { resolve, sep, join } from "node:path";
import { buildWorkspaceSummaryMap, buildBlockedMap, buildTagMap, buildGraphEdges } from "../services/board-aggregation.service.js";
import { deleteWorkspaceCascade } from "../repositories/workspace.repository.js";
import { generateSetupScript, generateTeardownScript } from "../services/project-setup.service.js";

const GITIGNORE_TEMPLATES: Record<string, string> = {
  node: `node_modules/
dist/
build/
.env
.env.local
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
.DS_Store
`,
  python: `__pycache__/
*.py[cod]
*.egg-info/
dist/
build/
.venv/
venv/
.env
*.log
.DS_Store
`,
  java: `target/
*.class
*.jar
*.war
*.ear
.gradle/
build/
.env
*.log
.DS_Store
`,
  go: `*.exe
*.exe~
*.dll
*.so
*.dylib
*.test
*.out
vendor/
.env
.DS_Store
`,
  rust: `target/
Cargo.lock
*.pdb
.env
.DS_Store
`,
  ruby: `.bundle/
vendor/bundle/
*.gem
*.rbc
.env
log/
tmp/
.DS_Store
`,
  dotnet: `bin/
obj/
*.user
*.suo
.vs/
*.nupkg
.env
.DS_Store
`,
};

const DEFAULT_STATUSES = [
  { name: "Backlog", sortOrder: -1, isDefault: false },
  { name: "Todo", sortOrder: 0, isDefault: true },
  { name: "In Progress", sortOrder: 1, isDefault: false },
  { name: "In Review", sortOrder: 2, isDefault: false },
  { name: "AI Reviewed", sortOrder: 3, isDefault: false },
  { name: "Done", sortOrder: 4, isDefault: false },
  { name: "Cancelled", sortOrder: 5, isDefault: false },
];


export function createProjectsRoute(database: Database = db) {
  const router = new Hono();

  // GET /api/projects
  router.get("/", async (c) => {
    const result = await database.select().from(projects);
    return c.json(result);
  });

  // POST /api/projects
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

    // Reject duplicate repo paths
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

    for (const status of DEFAULT_STATUSES) {
      await database.insert(projectStatuses).values({
        id: randomUUID(),
        projectId: id,
        name: status.name,
        sortOrder: status.sortOrder,
        isDefault: status.isDefault,
        createdAt: now,
      });
    }

    // Write optional .gitignore
    if (body.gitignoreTemplate && GITIGNORE_TEMPLATES[body.gitignoreTemplate]) {
      const gitignorePath = join(repoInfo.repoPath, ".gitignore");
      if (!existsSync(gitignorePath)) {
        try {
          writeFileSync(gitignorePath, GITIGNORE_TEMPLATES[body.gitignoreTemplate], "utf8");
        } catch { /* non-fatal */ }
      }
    }

    // Write optional README.md
    if (body.generateReadme) {
      const readmePath = join(repoInfo.repoPath, "README.md");
      if (!existsSync(readmePath)) {
        try {
          writeFileSync(readmePath, `# ${name}\n`, "utf8");
        } catch { /* non-fatal */ }
      }
    }

    return c.json({ id, name, repoPath: repoInfo.repoPath }, 201);
  });

  // POST /api/projects/create — create a new directory as a git repo and register it
  router.post("/create", async (c) => {
    const body = await c.req.json();
    if (!body.name || !body.name.trim()) {
      return c.json({ error: "name is required" }, 400);
    }

    const name = body.name.trim();

    // Resolve target path: explicit path override or baseDir/name
    let targetPath: string;
    if (body.path && body.path.trim()) {
      targetPath = resolve(body.path.trim());
    } else {
      // Validate folder name when deriving path from name
      if (/[/\\<>:"|?*\x00]/.test(name)) {
        return c.json({ error: 'Project name contains invalid characters. Avoid: / \\ < > : " | ? *' }, 400);
      }

      // Read projects_base_path from preferences
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

      // Guard against path traversal (e.g. name = "../other")
      const resolvedBase = resolve(baseDir);
      if (!targetPath.startsWith(resolvedBase + sep) && targetPath !== resolvedBase) {
        return c.json({ error: `Invalid project name: "${name}" would escape the base directory.` }, 400);
      }
    }

    // Error if the directory already exists — use the Import tab for existing repos
    if (existsSync(targetPath)) {
      return c.json({ error: `Directory already exists: ${targetPath}. To use an existing directory, use "Import existing" instead.` }, 409);
    }

    try {
      mkdirSync(targetPath, { recursive: true });
    } catch (err) {
      return c.json({ error: `Failed to create directory: ${err instanceof Error ? err.message : String(err)}` }, 400);
    }

    // Run git init
    try {
      execSync("git init", { cwd: targetPath, stdio: "pipe" });
    } catch (err: any) {
      try { rmSync(targetPath, { recursive: true, force: true }); } catch {}
      return c.json({ error: `git init failed: ${err.stderr ? String(err.stderr).trim() : String(err)}` }, 400);
    }

    // Check for duplicate registration
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

    for (const status of DEFAULT_STATUSES) {
      await database.insert(projectStatuses).values({
        id: randomUUID(),
        projectId: id,
        name: status.name,
        sortOrder: status.sortOrder,
        isDefault: status.isDefault,
        createdAt: now,
      });
    }

    return c.json({ id, name: projectName, repoPath: repoInfo.repoPath }, 201);
  });

  // PATCH /api/projects/:id — update project fields
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

    await database.update(projects).set(updates).where(eq(projects.id, id));
    return c.json({ id });
  });

  // POST /api/projects/generate-setup-script — AI-generate a setup script for a project
  router.post("/generate-setup-script", async (c) => {
    let body: { projectId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (!body.projectId) {
      return c.json({ error: "projectId is required" }, 400);
    }

    let setupScript: string;
    try {
      setupScript = await generateSetupScript(body.projectId, database);
    } catch (err: any) {
      if (err.statusCode === 404) return c.json({ error: "Project not found" }, 404);
      const parts: string[] = [];
      if (err.message) parts.push(err.message);
      if (err.stderr) parts.push(String(err.stderr).trim());
      const msg = parts.length > 0 ? parts.join(" | ") : "claude CLI failed";
      console.error("[generate-setup-script] claude error:", msg);
      return c.json({ error: "AI generation failed", detail: msg }, 500);
    }
    return c.json({ setupScript });
  });

  // POST /api/projects/generate-teardown-script — AI-generate a teardown script for a project
  router.post("/generate-teardown-script", async (c) => {
    let body: { projectId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (!body.projectId) {
      return c.json({ error: "projectId is required" }, 400);
    }

    let teardownScript: string;
    try {
      teardownScript = await generateTeardownScript(body.projectId, database);
    } catch (err: any) {
      if (err.statusCode === 404) return c.json({ error: "Project not found" }, 404);
      const parts: string[] = [];
      if (err.message) parts.push(err.message);
      if (err.stderr) parts.push(String(err.stderr).trim());
      const msg = parts.length > 0 ? parts.join(" | ") : "claude CLI failed";
      console.error("[generate-teardown-script] claude error:", msg);
      return c.json({ error: "AI generation failed", detail: msg }, 500);
    }
    return c.json({ teardownScript });
  });

  // GET /api/projects/:id/statuses
  router.get("/:id/statuses", async (c) => {
    const projectId = c.req.param("id");
    const result = await database
      .select()
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, projectId))
      .orderBy(projectStatuses.sortOrder);
    return c.json(result);
  });

  // POST /api/projects/:id/statuses
  router.post("/:id/statuses", async (c) => {
    const projectId = c.req.param("id");
    const body = await c.req.json();
    const now = new Date().toISOString();
    const id = randomUUID();

    await database.insert(projectStatuses).values({
      id,
      projectId,
      name: body.name,
      sortOrder: body.sortOrder ?? 0,
      createdAt: now,
    });

    return c.json({ id, projectId, name: body.name }, 201);
  });

  // DELETE /api/projects/:id/statuses/:statusId
  router.delete("/:id/statuses/:statusId", async (c) => {
    const projectId = c.req.param("id");
    const statusId = c.req.param("statusId");

    const statusRows = await database
      .select()
      .from(projectStatuses)
      .where(and(eq(projectStatuses.id, statusId), eq(projectStatuses.projectId, projectId)));

    if (statusRows.length === 0) {
      return c.json({ error: "Status not found" }, 404);
    }

    // Prevent deleting a status that has issues
    const linkedIssues = await database
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.statusId, statusId))
      .limit(1);

    if (linkedIssues.length > 0) {
      return c.json({ error: "Cannot delete status with linked issues" }, 409);
    }

    await database.delete(projectStatuses).where(eq(projectStatuses.id, statusId));

    return c.json({ success: true });
  });

  // GET /api/projects/:id/branches
  router.get("/:id/branches", async (c) => {
    const projectId = c.req.param("id");
    const projectRows = await database
      .select({ id: projects.id, repoPath: projects.repoPath })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (projectRows.length === 0) {
      return c.json({ error: "Project not found" }, 404);
    }
    try {
      const branches = await listBranches(projectRows[0].repoPath);
      return c.json(branches);
    } catch (err) {
      return c.json(
        { error: `Failed to list branches: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }
  });

  // GET /api/projects/:id/stats — lightweight project stats (commit count, recent commits, issue counts)
  router.get("/:id/stats", async (c) => {
    const projectId = c.req.param("id");
    const projectRows = await database
      .select({ id: projects.id, repoPath: projects.repoPath, defaultBranch: projects.defaultBranch })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (projectRows.length === 0) return c.json({ error: "Project not found" }, 404);
    const { repoPath, defaultBranch } = projectRows[0];

    let commitCount = 0;
    let recentCommits: { hash: string; message: string; date: string }[] = [];
    try {
      const countOut = execSync(`git rev-list --count ${defaultBranch}`, { cwd: repoPath, timeout: 5000 }).toString().trim();
      commitCount = parseInt(countOut, 10) || 0;
      const logOut = execSync(`git log ${defaultBranch} --oneline --format="%H|%s|%cr" -10`, { cwd: repoPath, timeout: 5000 }).toString().trim();
      recentCommits = logOut.split("\n").filter(Boolean).map((line) => {
        const [hash, message, date] = line.split("|");
        return { hash: hash?.slice(0, 7) ?? "", message: message ?? "", date: date ?? "" };
      });
    } catch { /* git unavailable or no commits */ }

    // Issue counts by status name
    const issueRows = await database
      .select({ statusName: projectStatuses.name, count: sql<number>`count(*)` })
      .from(issues)
      .leftJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(eq(issues.projectId, projectId))
      .groupBy(projectStatuses.name);
    const issueCounts: Record<string, number> = {};
    for (const row of issueRows) if (row.statusName != null) issueCounts[row.statusName] = Number(row.count);

    return c.json({ commitCount, recentCommits, issueCounts });
  });

  // GET /api/projects/:id/worktrees
  router.get("/:id/worktrees", async (c) => {
    const projectId = c.req.param("id");

    const projectRows = await database
      .select({ repoPath: projects.repoPath, defaultBranch: projects.defaultBranch })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (projectRows.length === 0) {
      return c.json({ error: "Project not found" }, 404);
    }

    const { repoPath, defaultBranch } = projectRows[0];

    let gitWorktrees: { path: string; branch: string }[];
    try {
      gitWorktrees = await listWorktrees(repoPath);
    } catch (err) {
      return c.json(
        { error: `Failed to list worktrees: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }

    // Fetch all non-closed workspaces for this project, join with issues for info
    const projectWorkspaces = await database
      .select({
        id: workspaces.id,
        issueId: workspaces.issueId,
        branch: workspaces.branch,
        workingDir: workspaces.workingDir,
        baseBranch: workspaces.baseBranch,
        isDirect: workspaces.isDirect,
        status: workspaces.status,
        issueNumber: issues.issueNumber,
        issueTitle: issues.title,
      })
      .from(workspaces)
      .innerJoin(issues, eq(workspaces.issueId, issues.id))
      .where(eq(issues.projectId, projectId));

    // Index workspaces by workingDir (normalized path)
    const wsByDir = new Map<string, typeof projectWorkspaces[number]>();
    for (const ws of projectWorkspaces) {
      if (ws.workingDir) {
        wsByDir.set(ws.workingDir.replace(/\//g, sep), ws);
      }
    }

    const result = await Promise.all(
      gitWorktrees.map(async (wt, index) => {
        // First worktree is always the primary checkout (git guarantee)
        const isMain = index === 0;
        const normalizedWtPath = wt.path.replace(/\//g, sep);

        // Match workspace by exact path, or by direct workspace whose workingDir is inside this worktree
        let ws = wsByDir.get(normalizedWtPath);
        if (!ws && isMain) {
          for (const [, candidate] of wsByDir) {
            if (candidate.isDirect && candidate.workingDir && candidate.workingDir.startsWith(normalizedWtPath)) {
              ws = candidate;
              break;
            }
          }
        }

        let diffStats: { filesChanged: number; insertions: number; deletions: number } | undefined;
        if (!isMain) {
          const base = ws?.baseBranch || defaultBranch;
          diffStats = await getDiffShortstat(wt.path, base);
          if (diffStats.filesChanged === 0 && diffStats.insertions === 0 && diffStats.deletions === 0) {
            diffStats = undefined;
          }
        }

        return {
          path: wt.path,
          branch: isMain ? defaultBranch : wt.branch.replace(/^refs\/heads\//, ""),
          isMain,
          workspace: ws ? {
            id: ws.id,
            status: ws.status,
            isDirect: ws.isDirect,
            issueId: ws.issueId,
            issueNumber: ws.issueNumber,
            issueTitle: ws.issueTitle,
          } : undefined,
          diffStats,
        };
      }),
    );

    return c.json(result);
  });

  // DELETE /api/projects/:id/worktrees — remove a worktree (and optionally its workspace)
  router.delete("/:id/worktrees", async (c) => {
    const projectId = c.req.param("id");
    const body = await c.req.json<{ path?: string; workspaceId?: string }>();

    if (!body.path && !body.workspaceId) {
      return c.json({ error: "path or workspaceId is required" }, 400);
    }

    const projectRows = await database
      .select({ repoPath: projects.repoPath })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (projectRows.length === 0) {
      return c.json({ error: "Project not found" }, 404);
    }

    const { repoPath } = projectRows[0];
    let removedPath = body.path;

    // If workspaceId given, look up the workspace to find its workingDir
    if (body.workspaceId) {
      const wsRows = await database
        .select({ id: workspaces.id, workingDir: workspaces.workingDir })
        .from(workspaces)
        .where(eq(workspaces.id, body.workspaceId))
        .limit(1);

      if (wsRows.length === 0) {
        return c.json({ error: "Workspace not found" }, 404);
      }

      const ws = wsRows[0];
      if (ws.workingDir) removedPath = ws.workingDir;

      // Cascade delete: diff comments → session messages → sessions → workspace
      await deleteWorkspaceCascade(ws.id, database);
    }

    // Remove git worktree
    if (removedPath) {
      try {
        await removeWorktree(repoPath, removedPath);
      } catch {
        // Best effort — worktree may already be removed
      }
    }

    return c.json({ success: true });
  });

  // POST /api/projects/:id/worktrees/open — open a worktree folder in the OS file explorer
  router.post("/:id/worktrees/open", async (c) => {
    const body = await c.req.json<{ path: string }>();
    if (!body.path) return c.json({ error: "path is required" }, 400);

    const { spawn } = await import("node:child_process");
    const platform = process.platform;
    let cmd: string;
    let args: string[];
    if (platform === "win32") {
      cmd = "explorer";
      args = [body.path.replace(/\//g, "\\")];
    } else if (platform === "darwin") {
      cmd = "open";
      args = [body.path];
    } else {
      cmd = "xdg-open";
      args = [body.path];
    }

    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
    return c.json({ success: true });
  });

  // GET /api/projects/:id/board
  router.get("/:id/board", async (c) => {
    const projectId = c.req.param("id");

    const projectRows = await database
      .select({ id: projects.id, defaultBranch: projects.defaultBranch })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (projectRows.length === 0) {
      return c.json({ error: "Project not found" }, 404);
    }

    const statuses = await database
      .select()
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, projectId))
      .orderBy(projectStatuses.sortOrder);

    const projectIssues = await database
      .select({
        id: issues.id,
        issueNumber: issues.issueNumber,
        title: issues.title,
        description: issues.description,
        priority: issues.priority,
        sortOrder: issues.sortOrder,
        statusId: issues.statusId,
        projectId: issues.projectId,
        createdAt: issues.createdAt,
        updatedAt: issues.updatedAt,
        statusChangedAt: issues.statusChangedAt,
        statusName: projectStatuses.name,
        skipAutoReview: issues.skipAutoReview,
        estimate: issues.estimate,
      })
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(eq(issues.projectId, projectId))
      .orderBy(issues.sortOrder);

    // Fetch workspace summaries, blocked status, and tags via aggregation service
    const issueIds = projectIssues.map((i) => i.id);
    const defaultBranch = projectRows[0].defaultBranch;

    const [workspaceSummaryMap, blockedMap, issueTagMap] = await Promise.all([
      buildWorkspaceSummaryMap(issueIds, defaultBranch, database),
      buildBlockedMap(issueIds, database),
      buildTagMap(issueIds, database),
    ]);

    const issuesWithBlocked = projectIssues.map((issue) => {
      const wsSummary = workspaceSummaryMap.get(issue.id);
      const blocked = blockedMap.get(issue.id);
      return {
        ...issue,
        ...(wsSummary ? { workspaceSummary: wsSummary } : {}),
        ...(blocked ? { isBlocked: blocked.isBlocked, dependencyCount: blocked.dependencyCount } : {}),
      };
    });

    const result = statuses.map((s) => ({
      id: s.id,
      name: s.name,
      projectId: s.projectId,
      sortOrder: s.sortOrder,
      issues: issuesWithBlocked.filter((i) => i.statusId === s.id).map((i) => ({
        ...i,
        tags: issueTagMap.get(i.id) ?? [],
      })),
    }));

    return c.json(result);
  });

  // GET /api/projects/:id/graph — all issues + all dependencies for graph view
  router.get("/:id/graph", async (c) => {
    const projectId = c.req.param("id");

    const projectRows = await database
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (projectRows.length === 0) return c.json({ error: "Project not found" }, 404);

    const projectIssues = await database
      .select({
        id: issues.id,
        issueNumber: issues.issueNumber,
        title: issues.title,
        description: issues.description,
        priority: issues.priority,
        sortOrder: issues.sortOrder,
        statusId: issues.statusId,
        projectId: issues.projectId,
        createdAt: issues.createdAt,
        updatedAt: issues.updatedAt,
        statusChangedAt: issues.statusChangedAt,
        statusName: projectStatuses.name,
        skipAutoReview: issues.skipAutoReview,
        estimate: issues.estimate,
      })
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(eq(issues.projectId, projectId))
      .orderBy(issues.sortOrder);

    const issueIds = projectIssues.map((i) => i.id);
    const edges = await buildGraphEdges(issueIds, database);

    const blockedIds = new Set(
      edges
        .filter((e) => e.type === "depends_on" || e.type === "blocked_by")
        .map((e) => e.issueId)
    );

    const nodes = projectIssues.map((i) => ({ ...i, isBlocked: blockedIds.has(i.id) }));

    return c.json({ nodes, edges });
  });

  return router;
}

export const projectsRoute = createProjectsRoute();
