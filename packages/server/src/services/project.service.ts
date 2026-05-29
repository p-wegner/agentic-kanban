import { randomUUID } from "node:crypto";
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, sep, join } from "node:path";
import { projects, projectStatuses, issues, workspaces, preferences } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { branchExists, detectRepoInfo, getProjectGitStats } from "./git-info.service.js";
import { listBranches, listWorktrees, getDiffShortstat, removeWorktree } from "./git.service.js";
import { buildWorkspaceSummaryMap, buildBlockedMap, buildTagMap, buildGraphEdges } from "./board-aggregation.service.js";
import { getProjectById, getProjectByRepoPath, getAllProjects, insertProject, deleteProjectCascade, getProjectStats, getProjectStatuses, createProjectStatus, deleteProjectStatus } from "../repositories/project.repository.js";
import { generateSetupScript as generateSetupScriptAI, generateTeardownScript as generateTeardownScriptAI } from "./project-setup.service.js";
import { deleteWorkspaceCascade } from "../repositories/workspace.repository.js";

export class ProjectError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT",
  ) {
    super(message);
  }
}

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

export function createProjectService(deps: { database: Database }) {
  const { database } = deps;

  async function registerProject(body: {
    repoPath: string;
    name?: string;
    description?: string;
    color?: string;
    gitignoreTemplate?: string;
    generateReadme?: boolean;
  }) {
    if (!body.repoPath) {
      throw new ProjectError("repoPath is required", "BAD_REQUEST");
    }

    let repoInfo;
    try {
      repoInfo = await detectRepoInfo(body.repoPath);
    } catch (err) {
      throw new ProjectError(`Invalid repo: ${err instanceof Error ? err.message : String(err)}`, "BAD_REQUEST");
    }

    const name = body.name || repoInfo.repoName;

    const existing = await getProjectByRepoPath(repoInfo.repoPath, database);
    if (existing) {
      throw new ProjectError(`Project "${existing.name}" is already registered at this path`, "CONFLICT");
    }

    const id = randomUUID();
    const result = await insertProject(id, {
      name,
      description: body.description,
      color: body.color,
      repoPath: repoInfo.repoPath,
      repoName: repoInfo.repoName,
      defaultBranch: repoInfo.defaultBranch,
      remoteUrl: repoInfo.remoteUrl,
    }, database);

    if (body.gitignoreTemplate && GITIGNORE_TEMPLATES[body.gitignoreTemplate]) {
      const gitignorePath = join(repoInfo.repoPath, ".gitignore");
      if (!existsSync(gitignorePath)) {
        try { writeFileSync(gitignorePath, GITIGNORE_TEMPLATES[body.gitignoreTemplate], "utf8"); } catch { /* non-fatal */ }
      }
    }

    if (body.generateReadme) {
      const readmePath = join(repoInfo.repoPath, "README.md");
      if (!existsSync(readmePath)) {
        try { writeFileSync(readmePath, `# ${name}\n`, "utf8"); } catch { /* non-fatal */ }
      }
    }

    return { ...result, id };
  }

  async function createProject(body: {
    name: string;
    path?: string;
    description?: string;
    color?: string;
  }) {
    const name = body.name.trim();
    if (!name) {
      throw new ProjectError("name is required", "BAD_REQUEST");
    }

    let targetPath: string;
    if (body.path && body.path.trim()) {
      targetPath = resolve(body.path.trim());
    } else {
      if (/[/\\<>:"|?*\x00]/.test(name)) {
        throw new ProjectError('Project name contains invalid characters. Avoid: / \\ < > : " | ? *', "BAD_REQUEST");
      }

      const baseDirRows = await database
        .select({ value: preferences.value })
        .from(preferences)
        .where(eq(preferences.key, "projects_base_path"))
        .limit(1);
      const baseDir = baseDirRows[0]?.value?.trim();
      if (!baseDir) {
        throw new ProjectError("No base directory configured. Set 'Projects base directory' in Settings › Project, or provide an explicit path.", "BAD_REQUEST");
      }
      targetPath = resolve(join(baseDir, name));

      const resolvedBase = resolve(baseDir);
      if (!targetPath.startsWith(resolvedBase + sep) && targetPath !== resolvedBase) {
        throw new ProjectError(`Invalid project name: "${name}" would escape the base directory.`, "BAD_REQUEST");
      }
    }

    if (existsSync(targetPath)) {
      throw new ProjectError(`Directory already exists: ${targetPath}. To use an existing directory, use "Import existing" instead.`, "CONFLICT");
    }

    try {
      mkdirSync(targetPath, { recursive: true });
    } catch (err) {
      throw new ProjectError(`Failed to create directory: ${err instanceof Error ? err.message : String(err)}`, "BAD_REQUEST");
    }

    try {
      execSync("git init", { cwd: targetPath, stdio: "pipe" });
    } catch (err: any) {
      try { rmSync(targetPath, { recursive: true, force: true }); } catch {}
      throw new ProjectError(`git init failed: ${err.stderr ? String(err.stderr).trim() : String(err)}`, "BAD_REQUEST");
    }

    const existing = await getProjectByRepoPath(targetPath, database);
    if (existing) {
      throw new ProjectError(`Project "${existing.name}" is already registered at this path`, "CONFLICT");
    }

    let repoInfo;
    try {
      repoInfo = await detectRepoInfo(targetPath);
    } catch (err) {
      throw new ProjectError(`Failed to read repo info: ${err instanceof Error ? err.message : String(err)}`, "BAD_REQUEST");
    }

    const projectName = body.name?.trim() || repoInfo.repoName;
    const id = randomUUID();
    return insertProject(id, {
      name: projectName,
      description: body.description,
      color: body.color,
      repoPath: repoInfo.repoPath,
      repoName: repoInfo.repoName,
      defaultBranch: repoInfo.defaultBranch,
      remoteUrl: repoInfo.remoteUrl,
    }, database);
  }

  async function updateProject(
    id: string,
    body: Record<string, unknown>,
  ) {
    const now = new Date().toISOString();
    const project = await getProjectById(id, database);
    if (!project) throw new ProjectError("Project not found", "NOT_FOUND");

    const updates: Record<string, unknown> = { updatedAt: now };
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.color !== undefined) updates.color = body.color;
    if (body.setupScript !== undefined) updates.setupScript = body.setupScript || null;
    if (body.setupBlocking !== undefined) updates.setupBlocking = !!body.setupBlocking;
    if (body.setupEnabled !== undefined) updates.setupEnabled = !!body.setupEnabled;
    if (body.teardownScript !== undefined) updates.teardownScript = body.teardownScript || null;
    if (body.autoRetryFlakes !== undefined) updates.autoRetryFlakes = !!body.autoRetryFlakes;
    if (body.maxRetries !== undefined) updates.maxRetries = Number(body.maxRetries);
    if (body.defaultBranch !== undefined) {
      const nextDefaultBranch = typeof body.defaultBranch === "string"
        ? body.defaultBranch.trim()
        : null;
      if (nextDefaultBranch) {
        const exists = await branchExists(project.repoPath, nextDefaultBranch);
        if (!exists) {
          throw new ProjectError(`Branch "${nextDefaultBranch}" does not exist in this repo`, "BAD_REQUEST");
        }
        updates.defaultBranch = nextDefaultBranch;
      } else {
        updates.defaultBranch = null;
      }
    }

    await database.update(projects).set(updates).where(eq(projects.id, id));
    return { id };
  }

  async function deleteProject(id: string) {
    const project = await getProjectById(id, database);
    if (!project) throw new ProjectError("Project not found", "NOT_FOUND");
    await deleteProjectCascade(id, database);
  }

  async function getWorktrees(projectId: string) {
    const project = await getProjectById(projectId, database);
    if (!project) throw new ProjectError("Project not found", "NOT_FOUND");

    const { repoPath, defaultBranch } = project;

    const gitWorktrees = await listWorktrees(repoPath);

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

    const wsByDir = new Map<string, typeof projectWorkspaces[number]>();
    for (const ws of projectWorkspaces) {
      if (ws.workingDir) {
        wsByDir.set(ws.workingDir.replace(/\//g, sep), ws);
      }
    }

    return Promise.all(
      gitWorktrees.map(async (wt, index) => {
        const isMain = index === 0;
        const normalizedWtPath = wt.path.replace(/\//g, sep);

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
          if (base) {
            diffStats = await getDiffShortstat(wt.path, base);
            if (diffStats.filesChanged === 0 && diffStats.insertions === 0 && diffStats.deletions === 0) {
              diffStats = undefined;
            }
          }
        }

        return {
          path: wt.path,
          branch: isMain ? (defaultBranch ?? (wt.branch.replace(/^refs\/heads\//, "") || "(unset)")) : wt.branch.replace(/^refs\/heads\//, ""),
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
  }

  async function removeWorktreeById(projectId: string, body: { path?: string; workspaceId?: string }) {
    const project = await getProjectById(projectId, database);
    if (!project) throw new ProjectError("Project not found", "NOT_FOUND");

    let removedPath = body.path;

    if (body.workspaceId) {
      const wsRows = await database
        .select({ id: workspaces.id, workingDir: workspaces.workingDir })
        .from(workspaces)
        .where(eq(workspaces.id, body.workspaceId))
        .limit(1);

      if (wsRows.length === 0) {
        throw new ProjectError("Workspace not found", "NOT_FOUND");
      }

      const ws = wsRows[0];
      if (ws.workingDir) removedPath = ws.workingDir;
      await deleteWorkspaceCascade(ws.id, database);
    }

    if (removedPath) {
      try { await removeWorktree(project.repoPath, removedPath); } catch { /* best effort */ }
    }
  }

  async function getStats(projectId: string) {
    const project = await getProjectById(projectId, database);
    if (!project) throw new ProjectError("Project not found", "NOT_FOUND");

    const { commitCount, recentCommits, detectedBranch } = getProjectGitStats(project.repoPath, project.defaultBranch);

    const issueRows = await getProjectStats(projectId, database);
    const issueCounts: Record<string, number> = {};
    for (const row of issueRows) if (row.statusName != null) issueCounts[row.statusName] = Number(row.count);

    return { commitCount, recentCommits, issueCounts, detectedBranch };
  }

  async function getBoard(projectId: string) {
    const project = await getProjectById(projectId, database);
    if (!project) throw new ProjectError("Project not found", "NOT_FOUND");

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
        issueType: issues.issueType,
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
    const defaultBranch = project.defaultBranch;

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

    return statuses.map((s) => ({
      id: s.id,
      name: s.name,
      projectId: s.projectId,
      sortOrder: s.sortOrder,
      issues: issuesWithBlocked.filter((i) => i.statusId === s.id).map((i) => ({
        ...i,
        tags: issueTagMap.get(i.id) ?? [],
      })),
    }));
  }

  async function getGraph(projectId: string) {
    const project = await getProjectById(projectId, database);
    if (!project) throw new ProjectError("Project not found", "NOT_FOUND");

    const projectIssues = await database
      .select({
        id: issues.id,
        issueNumber: issues.issueNumber,
        title: issues.title,
        description: issues.description,
        priority: issues.priority,
        issueType: issues.issueType,
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
    return { nodes, edges };
  }

  async function getCrossProjectWorkspaces() {
    const allProjects = await getAllProjects(database);

    const results = await Promise.all(
      allProjects.map(async (project: typeof allProjects[number]) => {
        const statuses = await database
          .select()
          .from(projectStatuses)
          .where(eq(projectStatuses.projectId, project.id))
          .orderBy(projectStatuses.sortOrder);

        const projectIssues = await database
          .select({
            id: issues.id,
            issueNumber: issues.issueNumber,
            title: issues.title,
            priority: issues.priority,
            issueType: issues.issueType,
            sortOrder: issues.sortOrder,
            statusId: issues.statusId,
            projectId: issues.projectId,
            createdAt: issues.createdAt,
            updatedAt: issues.updatedAt,
            statusName: projectStatuses.name,
          })
          .from(issues)
          .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
          .where(eq(issues.projectId, project.id))
          .orderBy(issues.sortOrder);

        const issueIds = projectIssues.map((i) => i.id);
        const workspaceSummaryMap = await buildWorkspaceSummaryMap(issueIds, project.defaultBranch, database);

        const issuesWithWorkspaces = projectIssues
          .map((issue) => {
            const wsSummary = workspaceSummaryMap.get(issue.id);
            return { ...issue, workspaceSummary: wsSummary };
          })
          .filter((i) => i.workspaceSummary && i.workspaceSummary.total > 0);

        return {
          projectId: project.id,
          projectName: project.name,
          issues: issuesWithWorkspaces,
        };
      })
    );

    return results;
  }

  function openInExplorer(dirPath: string): void {
    const platform = process.platform;
    let cmd: string;
    let args: string[];
    if (platform === "win32") {
      cmd = "explorer";
      args = [dirPath.replace(/\//g, "\\")];
    } else if (platform === "darwin") {
      cmd = "open";
      args = [dirPath];
    } else {
      cmd = "xdg-open";
      args = [dirPath];
    }
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  }

  async function listProjects() {
    return getAllProjects(database);
  }

  async function listStatuses(projectId: string) {
    return getProjectStatuses(projectId, database);
  }

  async function addStatus(projectId: string, name: string, sortOrder: number) {
    return createProjectStatus(projectId, name, sortOrder, database);
  }

  async function removeStatus(projectId: string, statusId: string) {
    const result = await deleteProjectStatus(projectId, statusId, database);
    if ("error" in result) {
      const code = result.status === 404 ? "NOT_FOUND" : "CONFLICT";
      throw new ProjectError(result.error, code as "NOT_FOUND" | "CONFLICT");
    }
    return result;
  }

  async function getBranches(projectId: string) {
    const project = await getProjectById(projectId, database);
    if (!project) throw new ProjectError("Project not found", "NOT_FOUND");
    return listBranches(project.repoPath);
  }

  async function generateSetupScript(projectId: string) {
    try {
      return await generateSetupScriptAI(projectId, database);
    } catch (err: any) {
      if (err.statusCode === 404) throw new ProjectError("Project not found", "NOT_FOUND");
      throw err;
    }
  }

  async function generateTeardownScript(projectId: string) {
    try {
      return await generateTeardownScriptAI(projectId, database);
    } catch (err: any) {
      if (err.statusCode === 404) throw new ProjectError("Project not found", "NOT_FOUND");
      throw err;
    }
  }

  return {
    registerProject,
    createProject,
    updateProject,
    deleteProject,
    getWorktrees,
    removeWorktreeById,
    getStats,
    getBoard,
    getGraph,
    getCrossProjectWorkspaces,
    openInExplorer,
    listProjects,
    listStatuses,
    addStatus,
    removeStatus,
    getBranches,
    generateSetupScript,
    generateTeardownScript,
  };
}
