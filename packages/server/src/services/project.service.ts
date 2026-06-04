import { randomUUID } from "node:crypto";
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, sep, join } from "node:path";
import { projects, projectStatuses, issues, workspaces, preferences } from "@agentic-kanban/shared/schema";
import { ensureAgentGitignore, ensureStarterClaudeMd, ensureHookScaffold, ensureVerifyGateRunner, getDefaultSkillId } from "./project-scaffold.js";
import { isSkillsDirAbsentOrEmpty, writeAgentSkillFile } from "@agentic-kanban/shared/lib/agent-skill-files";
import { listAgentSkills } from "../repositories/agent-skill.repository.js";
import { getPreference } from "../repositories/preferences.repository.js";
import { eq, and, notInArray, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { branchExists, detectRepoInfo, getProjectGitStats } from "./git-info.service.js";
import { listBranches, listWorktrees, getDiffShortstat, removeWorktree } from "./git.service.js";
import { buildWorkspaceSummaryMap, buildBlockedMap, buildTagMap, buildGraphEdges } from "./board-aggregation.service.js";
import { getProjectById, getProjectByRepoPath, getAllProjects, insertProject, deleteProjectCascade, getProjectStats, getProjectStatuses, createProjectStatus, deleteProjectStatus, updateProjectStatusSortOrder } from "../repositories/project.repository.js";
import { generateSetupScript as generateSetupScriptAI, generateTeardownScript as generateTeardownScriptAI, generateVerifyScript as generateVerifyScriptAI } from "./project-setup.service.js";
import { deleteWorkspaceCascade } from "../repositories/workspace.repository.js";
import type { WorkspaceSummaryCache } from "./workspace-summary-cache.service.js";
import type { WorkspaceSummary } from "./workspace-summary.service.js";

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

export function createProjectService(deps: { database: Database; workspaceSummaryCache?: WorkspaceSummaryCache }) {
  const { database, workspaceSummaryCache } = deps;

  async function registerProject(body: {
    repoPath: string;
    name?: string;
    description?: string;
    color?: string;
    gitignoreTemplate?: string;
    generateReadme?: boolean;
    exportSkillsOnRegistration?: boolean;
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

    // Default onboarding skill so a freshly-registered project's worktrees aren't skill-less (#531).
    const id = randomUUID();
    const result = await insertProject(id, {
      name,
      description: body.description,
      color: body.color,
      repoPath: repoInfo.repoPath,
      repoName: repoInfo.repoName,
      defaultBranch: repoInfo.defaultBranch,
      remoteUrl: repoInfo.remoteUrl,
      defaultSkillId: await getDefaultSkillId(database),
    }, database);

    // Scaffold (clobber-safe for imports): ensure the generic agent-artifact ignores are present
    // (append-if-missing; seeds the chosen language template only when no .gitignore exists), and
    // drop a starter CLAUDE.md when the repo has none â€” keeps agent scratch out of the project's
    // history and gives agents a baseline working agreement.
    ensureAgentGitignore(repoInfo.repoPath, body.gitignoreTemplate ? GITIGNORE_TEMPLATES[body.gitignoreTemplate] : undefined);
    ensureStarterClaudeMd(repoInfo.repoPath);
    ensureHookScaffold(repoInfo.repoPath);
    ensureVerifyGateRunner(repoInfo.repoPath);

    if (body.generateReadme) {
      const readmePath = join(repoInfo.repoPath, "README.md");
      if (!existsSync(readmePath)) {
        try { writeFileSync(readmePath, `# ${name}\n`, "utf8"); } catch { /* non-fatal */ }
      }
    }

    const shouldExport = body.exportSkillsOnRegistration ??
      ((await getPreference("export_skills_on_registration", database)) === "true");
    if (shouldExport) {
      const isEmpty = await isSkillsDirAbsentOrEmpty(repoInfo.repoPath);
      if (isEmpty) {
        try {
          const builtinSkills = await listAgentSkills(undefined, false, database);
          for (const skill of builtinSkills) {
            if (skill.isBuiltin && !/[/\\]|\.\./.test(skill.name)) {
              await writeAgentSkillFile(repoInfo.repoPath, skill);
            }
          }
        } catch {
          // non-fatal â€” export failure should not block registration
        }
      }
    }

    return { ...result, id };
  }

  async function createProject(body: {
    name: string;
    path?: string;
    description?: string;
    color?: string;
    gitignoreTemplate?: string;
    generateReadme?: boolean;
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
        throw new ProjectError("No base directory configured. Set 'Projects base directory' in Settings â€º Project, or provide an explicit path.", "BAD_REQUEST");
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
    const result = await insertProject(id, {
      name: projectName,
      description: body.description,
      color: body.color,
      repoPath: repoInfo.repoPath,
      repoName: repoInfo.repoName,
      defaultBranch: repoInfo.defaultBranch,
      remoteUrl: repoInfo.remoteUrl,
      defaultSkillId: await getDefaultSkillId(database),
    }, database);
    // Scaffold the fresh repo with the generic agent-artifact ignores + a starter CLAUDE.md + hooks.
    ensureAgentGitignore(repoInfo.repoPath, body.gitignoreTemplate ? GITIGNORE_TEMPLATES[body.gitignoreTemplate] : undefined);
    ensureStarterClaudeMd(repoInfo.repoPath);
    ensureHookScaffold(repoInfo.repoPath);
    ensureVerifyGateRunner(repoInfo.repoPath);

    if (body.generateReadme) {
      const readmePath = join(repoInfo.repoPath, "README.md");
      if (!existsSync(readmePath)) {
        try { writeFileSync(readmePath, `# ${projectName}
`, "utf8"); } catch { /* non-fatal */ }
      }
    }
    return result;
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
    if (body.symlinkEnabled !== undefined) updates.symlinkEnabled = !!body.symlinkEnabled;
    if (body.symlinkDirs !== undefined) {
      // Validate: must be a JSON array of strings with safe directory names
      if (body.symlinkDirs === null || body.symlinkDirs === "") {
        updates.symlinkDirs = null;
      } else if (typeof body.symlinkDirs === "string") {
        // Parse and re-serialize to normalize
        try {
          const parsed = JSON.parse(body.symlinkDirs);
          if (Array.isArray(parsed)) {
            updates.symlinkDirs = JSON.stringify(parsed.filter((d: unknown) => typeof d === "string"));
          }
        } catch {
          throw new ProjectError("symlinkDirs must be a JSON array of strings", "BAD_REQUEST");
        }
      } else if (Array.isArray(body.symlinkDirs)) {
        updates.symlinkDirs = JSON.stringify(body.symlinkDirs.filter((d: unknown) => typeof d === "string"));
      }
    }
    if (body.defaultSkillId !== undefined) {
      updates.defaultSkillId = typeof body.defaultSkillId === "string" && body.defaultSkillId ? body.defaultSkillId : null;
    }
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

    const { commitCount, recentCommits, detectedBranch, codeMetrics, history, hotspots } = getProjectGitStats(project.repoPath, project.defaultBranch);

    const issueRows = await getProjectStats(projectId, database);
    const issueCounts: Record<string, number> = {};
    for (const row of issueRows) if (row.statusName != null) issueCounts[row.statusName] = Number(row.count);

    return { commitCount, recentCommits, issueCounts, detectedBranch, codeMetrics, history, hotspots };
  }

  async function getBoard(projectId: string, nowOverride?: string, opts?: { includeArchived?: boolean }) {
    const project = await getProjectById(projectId, database);
    if (!project) throw new ProjectError("Project not found", "NOT_FOUND");

    const statuses = await database
      .select()
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, projectId))
      .orderBy(projectStatuses.sortOrder);

    const archivedStatusIds = new Set(
      statuses.filter((s) => s.name === "Archived").map((s) => s.id),
    );

    const visibleStatuses = opts?.includeArchived
      ? statuses
      : statuses.filter((s) => !archivedStatusIds.has(s.id));

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
        externalKey: issues.externalKey,
        externalUrl: issues.externalUrl,
        checklistJson: issues.checklistJson,
        pinned: issues.pinned,
        milestoneId: issues.milestoneId,
      })
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(
        opts?.includeArchived || archivedStatusIds.size === 0
          ? eq(issues.projectId, projectId)
          : and(eq(issues.projectId, projectId), notInArray(issues.statusId, [...archivedStatusIds])),
      )
      .orderBy(issues.sortOrder);

    const issueIds = projectIssues.map((i) => i.id);
    const defaultBranch = project.defaultBranch;

    // Archive columns (Done/Cancelled) by DB status name â€” used to skip the heavy
    // per-session message scan + lastAssistantMessage/lastTool blobs for archived
    // issues (their cards render via CompletedCard, which shows neither). Exact
    // lowercased match avoids the "Cancelled" collapsed-bar substring footgun.
    const ARCHIVE_STATUS_NAMES = new Set(["done", "cancelled"]);
    const archivedIssueIds = new Set(
      projectIssues
        .filter((i) => i.statusName && ARCHIVE_STATUS_NAMES.has(i.statusName.toLowerCase()))
        .map((i) => i.id),
    );

    const cacheResult = workspaceSummaryCache?.get(projectId) ?? null;
    let summaryMapPromise: Promise<Map<string, WorkspaceSummary>>;
    if (cacheResult && !cacheResult.stale) {
      // Fresh cache hit — return immediately, no rebuild needed
      summaryMapPromise = Promise.resolve(cacheResult.value);
    } else if (cacheResult && cacheResult.stale) {
      // Stale-while-revalidate: return stale data immediately, rebuild in background
      summaryMapPromise = Promise.resolve(cacheResult.value);
      if (workspaceSummaryCache && !workspaceSummaryCache.isRebuilding(projectId)) {
        workspaceSummaryCache.markRebuilding(projectId);
        buildWorkspaceSummaryMap(issueIds, defaultBranch, database, archivedIssueIds)
          .then((m) => { workspaceSummaryCache.set(projectId, m); })
          .catch(() => {})
          .finally(() => { workspaceSummaryCache.clearRebuilding(projectId); });
      }
    } else {
      // Cold miss — must block on rebuild (no stale data available)
      summaryMapPromise = buildWorkspaceSummaryMap(issueIds, defaultBranch, database, archivedIssueIds).then((m) => {
        workspaceSummaryCache?.set(projectId, m);
        return m;
      });
    }

    const [workspaceSummaryMap, blockedMap, issueTagMap, staleDaysRow, inProgressStaleDaysRow] = await Promise.all([
      summaryMapPromise,
      buildBlockedMap(issueIds, database),
      buildTagMap(issueIds, database),
      database.select({ value: preferences.value }).from(preferences).where(eq(preferences.key, "backlog_stale_days")).limit(1),
      database.select({ value: preferences.value }).from(preferences).where(eq(preferences.key, "inprogress_stale_days")).limit(1),
    ]);

    const staleDays = parseInt(staleDaysRow[0]?.value ?? "14", 10) || 14;
    const inProgressStaleDays = parseInt(inProgressStaleDaysRow[0]?.value ?? "3", 10) || 3;
    const now = new Date(nowOverride ?? new Date().toISOString()).getTime();
    const staleMs = staleDays * 24 * 60 * 60 * 1000;
    const inProgressStaleMs = inProgressStaleDays * 24 * 60 * 60 * 1000;
    const backlogStatusNames = new Set(statuses.filter((s) => s.name.toLowerCase() === "backlog").map((s) => s.id));
    const inProgressStatusNames = new Set(statuses.filter((s) => s.name.toLowerCase() === "in progress").map((s) => s.id));

    const statusByName = new Map(statuses.map((status) => [status.name.toLowerCase(), status]));
    const issuesWithBlocked = projectIssues.map((issue) => {
      const wsSummary = workspaceSummaryMap.get(issue.id);
      const blocked = blockedMap.get(issue.id);
      const workflowStatusName = wsSummary?.main?.status !== "closed"
        ? wsSummary?.main?.workflow?.currentNodeStatusName
        : null;
      const workflowStatus = workflowStatusName
        ? statusByName.get(workflowStatusName.toLowerCase())
        : null;
      const effectiveStatusId = workflowStatus ? workflowStatus.id : issue.statusId;
      const isInBacklog = backlogStatusNames.has(effectiveStatusId);
      const isInProgress = inProgressStatusNames.has(effectiveStatusId);
      let isStale: boolean | undefined;
      let staleDaysActual: number | undefined;
      if (isInBacklog) {
        const lastActivity = new Date(issue.statusChangedAt ?? issue.updatedAt).getTime();
        const elapsed = now - lastActivity;
        if (elapsed >= staleMs) {
          isStale = true;
          staleDaysActual = Math.floor(elapsed / (24 * 60 * 60 * 1000));
        }
      }
      const columnEnteredAt = new Date(issue.statusChangedAt ?? issue.createdAt).getTime();
      const columnElapsed = now - columnEnteredAt;
      const columnAgeDays = Math.floor(columnElapsed / (24 * 60 * 60 * 1000));
      const isColumnStale = isInProgress && columnElapsed >= inProgressStaleMs;
      return {
        ...issue,
        ...(workflowStatus ? { statusId: workflowStatus.id, statusName: workflowStatus.name } : {}),
        ...(wsSummary ? { workspaceSummary: wsSummary } : {}),
        ...(blocked ? { isBlocked: blocked.isBlocked, dependencyCount: blocked.dependencyCount } : {}),
        ...(isStale ? { isStale: true, staleDays: staleDaysActual } : {}),
        columnAgeDays,
        ...(isColumnStale ? { isColumnStale: true } : {}),
      };
    });

    return visibleStatuses.map((s) => ({
      id: s.id,
      name: s.name,
      projectId: s.projectId,
      sortOrder: s.sortOrder,
      issues: issuesWithBlocked.filter((i) => i.statusId === s.id).map((i) => {
        const { checklistJson, ...rest } = i;
        let checklist: { id: string; text: string; completed: boolean }[] | undefined;
        if (checklistJson) {
          try { checklist = JSON.parse(checklistJson); } catch { checklist = undefined; }
        }
        return {
          ...rest,
          tags: issueTagMap.get(i.id) ?? [],
          ...(checklist && checklist.length > 0 ? { checklist } : {}),
        };
      }),
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
        pinned: issues.pinned,
        milestoneId: issues.milestoneId,
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

  async function updateStatusSortOrder(projectId: string, statusId: string, sortOrder: number) {
    const result = await updateProjectStatusSortOrder(projectId, statusId, sortOrder, database);
    if ("error" in result) {
      const code = result.status === 404 ? "NOT_FOUND" : "CONFLICT";
      throw new ProjectError(result.error, code as "NOT_FOUND" | "CONFLICT");
    }
    return result;
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

  async function generateVerifyScript(projectId: string) {
    try {
      return await generateVerifyScriptAI(projectId, database);
    } catch (err: any) {
      if (err.statusCode === 404) throw new ProjectError("Project not found", "NOT_FOUND");
      throw err;
    }
  }

  async function getBoardSummary(projectId: string) {
    const project = await getProjectById(projectId, database);
    if (!project) throw new ProjectError("Project not found", "NOT_FOUND");

    const rows = await database
      .select({
        statusId: projectStatuses.id,
        name: projectStatuses.name,
        sortOrder: projectStatuses.sortOrder,
        count: sql<number>`count(${issues.id})`,
      })
      .from(projectStatuses)
      .leftJoin(issues, eq(issues.statusId, projectStatuses.id))
      .where(eq(projectStatuses.projectId, projectId))
      .groupBy(projectStatuses.id, projectStatuses.name, projectStatuses.sortOrder)
      .orderBy(projectStatuses.sortOrder);

    return rows.map((r) => ({ ...r, count: Number(r.count) }));
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
    getBoardSummary,
    getGraph,
    getCrossProjectWorkspaces,
    openInExplorer,
    listProjects,
    listStatuses,
    addStatus,
    updateStatusSortOrder,
    removeStatus,
    getBranches,
    generateSetupScript,
    generateTeardownScript,
    generateVerifyScript,
  };
}
