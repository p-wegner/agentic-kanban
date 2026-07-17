import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, sep, join } from "node:path";
import { ensureAgentGitignore, ensureStarterClaudeMd, ensureStarterAgentsMd, ensureHookScaffold, ensureVerifyGateRunner, getDefaultSkillId, commitProjectScaffoldArtifacts } from "./project-scaffold.js";
import { scaffoldAndPopulateProject } from "./project-registration.js";
import { isSkillsDirAbsentOrEmpty, writeAgentSkillFile } from "@agentic-kanban/shared/lib/agent-skill-files";
import { listAgentSkills } from "../repositories/agent-skill.repository.js";
import { getPreference } from "../repositories/preferences.repository.js";
import type { Database } from "../db/index.js";
import { branchExists, detectRepoInfo, getProjectGitStatsAsync } from "./git-info.service.js";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";
import { listBranches, listWorktrees, getDiffShortstat, removeWorktree } from "./git.service.js";
import { buildWorkspaceSummaryMap, buildBlockedMap, buildTagMap, buildGraphEdges } from "./board-aggregation.service.js";
import { getProjectById, getProjectByRepoPath, getAllProjects, insertProject, deleteProjectCascade, setProjectArchived, getProjectStats, getProjectStatuses, createProjectStatus, deleteProjectStatus, updateProjectStatusSortOrder } from "../repositories/project.repository.js";
import { getProjectsBasePath, updateProjectFields, clearActiveProjectPreference, getProjectWorkspacesWithIssue, getWorkspaceWorkingDirById, getProjectStatusIdsAndNames, getBoardIssueRows, getProjectStatusesOrdered, getBoardIssues, getPreferenceValue, getGraphIssues, getCrossProjectIssues, getActiveWorkspaceCounts, getBoardSummaryRows } from "../repositories/project-service.repository.js";
import { generateSetupScript as generateSetupScriptAI, generateTeardownScript as generateTeardownScriptAI, generateVerifyScript as generateVerifyScriptAI } from "./project-setup.service.js";
import { detectStackProfile } from "./stack-profile.service.js";
import { cloneRepo } from "./repo-clone.service.js";
import { deleteWorkspaceCascade } from "../repositories/workspace.repository.js";
import { workspaceServicesService, parseStoredComposeProjectName } from "./workspace-services.service.js";
import type { WorkspaceSummaryCache } from "./workspace-summary-cache.service.js";
import type { WorkspaceSummary } from "./workspace-summary.service.js";
import { buildBoardColumns } from "../lib/board-view.js";

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

// Archive columns (Done/Cancelled) by DB status name — used to skip the heavy
// per-session message scan + lastAssistantMessage/lastTool blobs for archived
// issues (their cards render via CompletedCard, which shows neither). Exact
// lowercased match avoids the "Cancelled" collapsed-bar substring footgun.
const ARCHIVE_STATUS_NAMES = new Set(["done", "cancelled"]);

// Debounce for invalidation-triggered warm-ahead board rebuilds: one session exit
// emits several broadcast reasons back-to-back; collapse the burst into one rebuild.
const BOARD_WARMUP_DEBOUNCE_MS = 75;

export function createProjectService(deps: { database: Database; workspaceSummaryCache?: WorkspaceSummaryCache }) {
  const { database, workspaceSummaryCache } = deps;

  // In-flight workspace-summary rebuilds keyed by projectId. Concurrent cold getBoard
  // calls (and invalidation-triggered warmups) await ONE shared rebuild instead of each
  // launching their own — duplicate cold rebuilds were measured stacking 155/182/205ms.
  // The cache generation at rebuild start rides along so a joiner arriving AFTER a
  // newer invalidation can detect the in-flight result is pre-mutation and chain a
  // fresh rebuild instead of being served stale data.
  const pendingSummaryRebuilds = new Map<string, { promise: Promise<Map<string, WorkspaceSummary>>; generation: number | undefined }>();

  // Pending warm-ahead debounce timers keyed by projectId.
  const boardWarmupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  async function registerProject(body: {
    repoPath?: string;
    cloneUrl?: string;
    name?: string;
    description?: string;
    color?: string;
    gitignoreTemplate?: string;
    generateReadme?: boolean;
    exportSkillsOnRegistration?: boolean;
  }) {
    if (!body.repoPath && !body.cloneUrl) {
      throw new ProjectError("repoPath or cloneUrl is required", "BAD_REQUEST");
    }
    if (body.repoPath && body.cloneUrl) {
      throw new ProjectError("Provide either repoPath or cloneUrl, not both", "BAD_REQUEST");
    }

    let localPath = body.repoPath;
    if (body.cloneUrl) {
      try {
        localPath = await cloneRepo(body.cloneUrl, { name: body.name });
      } catch (err) {
        throw new ProjectError(`Clone failed: ${err instanceof Error ? err.message : String(err)}`, "BAD_REQUEST");
      }
    }

    let repoInfo;
    try {
      repoInfo = await detectRepoInfo(localPath!);
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

    // THE shared registration step (#43) — see scaffoldAndPopulateProject in
    // project-registration.ts: scaffold → populate the derived config → commit what the board
    // wrote (#41). The fast rule-based pass is AWAITED, closing this path's race: a caller
    // creating a workspace immediately after POST /api/projects used to beat the old
    // fire-and-forget population and get `{"command": null, "state": "skipped"}` setup. The
    // optional ~30s LLM gap-fill stays backgrounded so the request never blocks on it.
    //
    // This path also never called populateSetupScript at all, so REST-registered projects had
    // setup_script = null forever — the #37 bug, fixed by routing through the shared step (#43).
    await scaffoldAndPopulateProject(id, repoInfo.repoPath, database, {
      gitignoreTemplate: body.gitignoreTemplate ? GITIGNORE_TEMPLATES[body.gitignoreTemplate] : undefined,
    });

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

      const baseDirRows = await getProjectsBasePath(database);
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
      gitExecSync(["init"], { cwd: targetPath, stdio: "pipe" });
    } catch (err: unknown) {
      try { rmSync(targetPath, { recursive: true, force: true }); } catch {}
      const stderr = (err as { stderr?: string | Buffer }).stderr;
      throw new ProjectError(`git init failed: ${stderr ? String(stderr).trim() : String(err)}`, "BAD_REQUEST");
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
    // A just-`git init`-ed repo usually has no stack markers yet (stack === null ⇒ no per-stack
    // block); detect anyway so a pre-seeded directory still gets its build-output ignores (#811).
    const freshStack = detectStackProfile(repoInfo.repoPath).stack;
    ensureAgentGitignore(repoInfo.repoPath, body.gitignoreTemplate ? GITIGNORE_TEMPLATES[body.gitignoreTemplate] : undefined, freshStack);
    ensureStarterClaudeMd(repoInfo.repoPath);
    ensureStarterAgentsMd(repoInfo.repoPath);
    ensureHookScaffold(repoInfo.repoPath);
    ensureVerifyGateRunner(repoInfo.repoPath);
    await commitProjectScaffoldArtifacts(repoInfo.repoPath);

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
          const parsed: unknown = JSON.parse(body.symlinkDirs);
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

    await updateProjectFields(id, updates, database);
    return { id };
  }

  async function deleteProject(id: string) {
    const project = await getProjectById(id, database);
    if (!project) throw new ProjectError("Project not found", "NOT_FOUND");
    await deleteProjectCascade(id, database);
  }

  async function archiveProject(id: string) {
    const project = await getProjectById(id, database);
    if (!project) throw new ProjectError("Project not found", "NOT_FOUND");
    await setProjectArchived(id, true, database);
    // Clear the active-project preference if it pointed at the now-archived project,
    // so the board doesn't try to render a hidden project on next load.
    await clearActiveProjectPreference(id, database);
    return { id };
  }

  async function unarchiveProject(id: string) {
    const project = await getProjectById(id, database);
    if (!project) throw new ProjectError("Project not found", "NOT_FOUND");
    await setProjectArchived(id, false, database);
    return { id };
  }

  async function getWorktrees(projectId: string) {
    const project = await getProjectById(projectId, database);
    if (!project) throw new ProjectError("Project not found", "NOT_FOUND");

    const { repoPath, defaultBranch } = project;

    const gitWorktrees = await listWorktrees(repoPath);

    const projectWorkspaces = await getProjectWorkspacesWithIssue(projectId, database);

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
      const wsRows = await getWorkspaceWorkingDirById(body.workspaceId, database);

      if (wsRows.length === 0) {
        throw new ProjectError("Workspace not found", "NOT_FOUND");
      }

      const ws = wsRows[0];
      if (ws.workingDir) removedPath = ws.workingDir;

      // Per-workspace Docker service stack teardown runs UNCONDITIONALLY, before the
      // cascade delete, mirroring deleteWorkspace (workspace-crud.service.ts) — a
      // fork-child worktree removal must not strand its compose stack until the
      // startup reaper. Uses the STORED compose project name; the engine's
      // last-reference guard still skips the down while another live workspace
      // shares the same compose project. Best-effort — never throws.
      if (ws.workingDir && !ws.isDirect) {
        const composeName = parseStoredComposeProjectName(ws.serviceState);
        if (composeName) {
          await workspaceServicesService.teardownWorkspaceServices({
            composeProjectName: composeName,
            composeWorktreePath: ws.workingDir,
            releasedByWorkspaceId: ws.id,
          });
        }
      }

      await deleteWorkspaceCascade(ws.id, database);
    }

    if (removedPath) {
      try { await removeWorktree(project.repoPath, removedPath); } catch { /* best effort */ }
    }
  }

  async function getStats(projectId: string) {
    const project = await getProjectById(projectId, database);
    if (!project) throw new ProjectError("Project not found", "NOT_FOUND");

    const { commitCount, recentCommits, detectedBranch, codeMetrics, history, hotspots } = await getProjectGitStatsAsync(project.repoPath, project.defaultBranch);

    const issueRows = await getProjectStats(projectId, database);
    const issueCounts: Record<string, number> = {};
    for (const row of issueRows) if (row.statusName != null) issueCounts[row.statusName] = Number(row.count);

    return { commitCount, recentCommits, issueCounts, detectedBranch, codeMetrics, history, hotspots };
  }

  // Start (or join) the single in-flight workspace-summary rebuild for a project.
  // The cache generation is captured at start: if an invalidation arrives mid-build,
  // the result is discarded instead of cached (it may reflect pre-mutation data) —
  // the same correctness rule the SWR write-back guard enforces via isRebuilding().
  function startSummaryRebuild(
    projectId: string,
    issueIds: string[],
    defaultBranch: string | null,
    archivedIssueIds: Set<string>,
  ): Promise<Map<string, WorkspaceSummary>> {
    const generation = workspaceSummaryCache?.getGeneration(projectId);
    const existing = pendingSummaryRebuilds.get(projectId);
    if (existing) {
      // Same generation: the in-flight rebuild reflects current data — join it.
      if (existing.generation === generation) return existing.promise;
      // The in-flight rebuild started before the latest invalidation: its result may
      // be pre-mutation (e.g. a card still in the old column after a status PATCH).
      // Wait for it to settle, then start/join a fresh rebuild — the same
      // await-then-recheck dance warmBoardCache performs.
      return existing.promise
        .catch(() => undefined)
        .then(() => startSummaryRebuild(projectId, issueIds, defaultBranch, archivedIssueIds));
    }
    const promise: Promise<Map<string, WorkspaceSummary>> = buildWorkspaceSummaryMap(issueIds, defaultBranch, database, archivedIssueIds)
      .then((m) => {
        if (workspaceSummaryCache && workspaceSummaryCache.getGeneration(projectId) === generation) {
          workspaceSummaryCache.set(projectId, m);
        }
        return m;
      })
      .finally(() => {
        if (pendingSummaryRebuilds.get(projectId)?.promise === promise) pendingSummaryRebuilds.delete(projectId);
      });
    pendingSummaryRebuilds.set(projectId, { promise, generation });
    return promise;
  }

  // Issue ids + archived-issue ids for the default board view (Archived column excluded),
  // mirroring getBoard's own queries — used by the invalidation-triggered warm-ahead path.
  async function fetchBoardIssueIds(projectId: string): Promise<{ issueIds: string[]; archivedIssueIds: Set<string> }> {
    const statuses = await getProjectStatusIdsAndNames(projectId, database);
    const archivedStatusIds = statuses.filter((s) => s.name === "Archived").map((s) => s.id);
    const rows = await getBoardIssueRows(projectId, archivedStatusIds, database);
    return {
      issueIds: rows.map((r) => r.id),
      archivedIssueIds: new Set(
        rows
          .filter((r) => r.statusName && ARCHIVE_STATUS_NAMES.has(r.statusName.toLowerCase()))
          .map((r) => r.id),
      ),
    };
  }

  // Rebuild the workspace-summary cache for a project if it is cold/stale, so the
  // client's post-event refetch hits a warm (or in-flight) cache instead of paying
  // the full cold rebuild (measured 121-205ms per post-event GET /board).
  async function warmBoardCache(projectId: string): Promise<void> {
    if (!workspaceSummaryCache) return;
    // If a rebuild is already in flight, wait for it — if it gets discarded by the
    // generation guard (started pre-invalidation), the re-check below starts a fresh one.
    const pending = pendingSummaryRebuilds.get(projectId);
    if (pending) await pending.promise.catch(() => {});
    const cached = workspaceSummaryCache.get(projectId);
    if (cached && !cached.stale) return; // a request already rebuilt during the debounce window
    const project = await getProjectById(projectId, database);
    if (!project) return;
    const { issueIds, archivedIssueIds } = await fetchBoardIssueIds(projectId);
    await startSummaryRebuild(projectId, issueIds, project.defaultBranch, archivedIssueIds);
  }

  // Fire-and-forget, debounced warm-ahead — called from the board invalidation listener.
  function scheduleBoardWarmup(projectId: string): void {
    if (!workspaceSummaryCache) return;
    const existing = boardWarmupTimers.get(projectId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      boardWarmupTimers.delete(projectId);
      warmBoardCache(projectId).catch(() => {});
    }, BOARD_WARMUP_DEBOUNCE_MS);
    (timer).unref?.();
    boardWarmupTimers.set(projectId, timer);
  }

  async function getBoard(projectId: string, nowOverride?: string, opts?: { includeArchived?: boolean }) {
    const project = await getProjectById(projectId, database);
    if (!project) throw new ProjectError("Project not found", "NOT_FOUND");

    const statuses = await getProjectStatusesOrdered(projectId, database);

    const archivedStatusIds = new Set(
      statuses.filter((s) => s.name === "Archived").map((s) => s.id),
    );

    const visibleStatuses = opts?.includeArchived
      ? statuses
      : statuses.filter((s) => !archivedStatusIds.has(s.id));

    const projectIssues = await getBoardIssues(projectId, !!opts?.includeArchived, [...archivedStatusIds], database);

    const issueIds = projectIssues.map((i) => i.id);
    const defaultBranch = project.defaultBranch;

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
          .then((m) => {
            // Only write back if the cache entry still exists (not invalidated during rebuild).
            // An invalidate() deletes the entry, so isRebuilding() returns false — meaning
            // a status-change PATCH arrived while we were rebuilding and we must not overwrite
            // with stale workspace-summary data.
            if (workspaceSummaryCache.isRebuilding(projectId)) {
              workspaceSummaryCache.set(projectId, m);
            }
          })
          .catch(() => {})
          .finally(() => { workspaceSummaryCache.clearRebuilding(projectId); });
      }
    } else {
      // Cold miss — must block on a rebuild (no stale data available), but coalesce:
      // concurrent cold requests share ONE in-flight rebuild instead of stacking duplicates.
      summaryMapPromise = startSummaryRebuild(projectId, issueIds, defaultBranch, archivedIssueIds);
    }

    const [workspaceSummaryMap, blockedMap, issueTagMap, staleDaysRow, inProgressStaleDaysRow] = await Promise.all([
      summaryMapPromise,
      buildBlockedMap(issueIds, database),
      buildTagMap(issueIds, database),
      getPreferenceValue("backlog_stale_days", database),
      getPreferenceValue("inprogress_stale_days", database),
    ]);

    const staleDays = parseInt(staleDaysRow[0]?.value ?? "14", 10) || 14;
    const inProgressStaleDays = parseInt(inProgressStaleDaysRow[0]?.value ?? "3", 10) || 3;
    const now = new Date(nowOverride ?? new Date().toISOString()).getTime();

    return buildBoardColumns({
      statuses,
      visibleStatuses,
      projectIssues,
      workspaceSummaryMap,
      blockedMap,
      issueTagMap,
      now,
      staleDays,
      inProgressStaleDays,
    });
  }

  async function getGraph(projectId: string) {
    const project = await getProjectById(projectId, database);
    if (!project) throw new ProjectError("Project not found", "NOT_FOUND");

    const projectIssues = await getGraphIssues(projectId, database);

    const issueIds = projectIssues.map((i) => i.id);
    const [edges, workspaceSummaryMap] = await Promise.all([
      buildGraphEdges(issueIds, database),
      buildWorkspaceSummaryMap(issueIds, project.defaultBranch, database),
    ]);

    const blockedIds = new Set(
      edges
        .filter((e) => e.type === "depends_on" || e.type === "blocked_by")
        .map((e) => e.issueId)
    );

    const nodes = projectIssues.map((i) => ({
      ...i,
      isBlocked: blockedIds.has(i.id),
      workspaceSummary: workspaceSummaryMap.get(i.id),
    }));
    return { nodes, edges };
  }

  async function getCrossProjectWorkspaces() {
    const allProjects = await getAllProjects(database);

    const results = await Promise.all(
      allProjects.map(async (project: typeof allProjects[number]) => {
        const projectIssues = await getCrossProjectIssues(project.id, database);

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

  async function listProjects(opts: { includeArchived?: boolean } = {}) {
    const projectRows = await getAllProjects(database, opts);

    // Enrich each project with a count of workspaces whose agent is currently
    // active (running, reviewing, or resolving conflicts), so the project
    // selector can surface where agents are working without a second request.
    const activeCounts = await getActiveWorkspaceCounts(database);

    const countByProject = new Map<string, number>();
    for (const row of activeCounts) {
      countByProject.set(row.projectId, Number(row.count));
    }

    return projectRows.map((project) => ({
      ...project,
      activeWorkspaceCount: countByProject.get(project.id) ?? 0,
    }));
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
      throw new ProjectError(result.error, code);
    }
    return result;
  }

  async function removeStatus(projectId: string, statusId: string) {
    const result = await deleteProjectStatus(projectId, statusId, database);
    if ("error" in result) {
      const code = result.status === 404 ? "NOT_FOUND" : "CONFLICT";
      throw new ProjectError(result.error, code);
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
    } catch (err: unknown) {
      if ((err as { statusCode?: unknown }).statusCode === 404) throw new ProjectError("Project not found", "NOT_FOUND");
      throw err;
    }
  }

  async function generateTeardownScript(projectId: string) {
    try {
      return await generateTeardownScriptAI(projectId, database);
    } catch (err: unknown) {
      if ((err as { statusCode?: unknown }).statusCode === 404) throw new ProjectError("Project not found", "NOT_FOUND");
      throw err;
    }
  }

  async function generateVerifyScript(projectId: string) {
    try {
      return await generateVerifyScriptAI(projectId, database);
    } catch (err: unknown) {
      if ((err as { statusCode?: unknown }).statusCode === 404) throw new ProjectError("Project not found", "NOT_FOUND");
      throw err;
    }
  }

  async function getBoardSummary(projectId: string) {
    const project = await getProjectById(projectId, database);
    if (!project) throw new ProjectError("Project not found", "NOT_FOUND");

    const rows = await getBoardSummaryRows(projectId, database);

    return rows.map((r) => ({ ...r, count: Number(r.count) }));
  }

  return {
    registerProject,
    createProject,
    updateProject,
    deleteProject,
    archiveProject,
    unarchiveProject,
    getWorktrees,
    removeWorktreeById,
    getStats,
    getBoard,
    scheduleBoardWarmup,
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
