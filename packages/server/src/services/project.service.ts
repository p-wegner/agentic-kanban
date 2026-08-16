import { randomUUID } from "node:crypto";
import {
  startRegistrationProgress,
  beginRegistrationPhase,
  endRegistrationPhase,
  finishRegistrationProgress,
} from "./registration-progress.service.js";
import { exportBuiltinSkillsToProject } from "./project-skill-export.js";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, sep, join } from "node:path";
import { getDefaultSkillId } from "./project-scaffold.js";
import { scaffoldAndPopulateProject } from "./project-registration.js";
import { isSkillsDirAbsentOrEmpty, writeAgentSkillFile } from "@agentic-kanban/shared/lib/agent-skill-files";
import { isBuilderRelevantSkill } from "@agentic-kanban/shared/lib/builder-skill-policy";
import { listAgentSkills } from "../repositories/agent-skill.repository.js";
import { getPreference } from "../repositories/preferences.repository.js";
import type { Database } from "../db/index.js";
import { branchExists, detectRepoInfo, getProjectGitStatsAsync } from "./git-info.service.js";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";
import { listBranches, listWorktrees, getDiffShortstat, removeWorktree } from "./git.service.js";
import { buildWorkspaceSummaryMap, buildBlockedMap, buildTagMap, buildGraphEdges } from "./board-aggregation.service.js";
import { getProjectById, getProjectByRepoPath, getAllProjects, insertProject, deleteProjectCascade, setProjectArchived, getProjectStats, getProjectStatuses, createProjectStatus, deleteProjectStatus, updateProjectStatusSortOrder } from "../repositories/project.repository.js";
import { getProjectsBasePath, updateProjectFields, clearActiveProjectPreference, getProjectWorkspacesWithIssue, getWorkspaceWorkingDirById, getProjectStatusIdsAndNames, getBoardIssueRows, getProjectStatusesOrdered, getBoardIssues, getGraphIssues, getCrossProjectIssues, getActiveWorkspaceCounts, getBoardSummaryRows } from "../repositories/project-service.repository.js";
import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { generateSetupScript as generateSetupScriptAI, generateTeardownScript as generateTeardownScriptAI, generateVerifyScript as generateVerifyScriptAI } from "./project-setup.service.js";
import { cloneRepo } from "./repo-clone.service.js";
import { deleteWorkspaceCascade } from "../repositories/workspace.repository.js";
import { workspaceServicesService, parseStoredComposeProjectName } from "./workspace-services.service.js";
import type { WorkspaceSummaryCache } from "./workspace-summary-cache.service.js";
import type { WorkspaceSummary } from "./workspace-summary.service.js";
import { buildBoardColumns } from "../lib/board-view.js";
import { selectCachedDiffStats } from "../lib/workspace-diff-cache.js";
import {
  cachedWorktreeDiffStats,
  scheduleWorktreeDiffStatsRefresh,
  type DiffStats,
} from "../lib/worktree-diff-stats.js";

import { ProjectError } from "./project-error.js";
import { createInitialCommit, createSiblingRepoDir, promoteRepoToLeading } from "./project-repos.service.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

// Re-export so existing importers (routes, tests) keep `import { ProjectError } from "./project.service.js"`.
export { ProjectError };

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
.kotlin/
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
// G14f: raised from 75ms — a monitor cycle's event burst spans several hundred ms,
// and 75ms let one burst trigger multiple full rebuilds.
const BOARD_WARMUP_DEBOUNCE_MS = 300;

/** Registration input, shared by the public entry point and its progress-tracked body (#388). */
interface RegisterProjectInput {
  repoPath?: string;
  cloneUrl?: string;
  name?: string;
  description?: string;
  color?: string;
  gitignoreTemplate?: string;
  generateReadme?: boolean;
  exportSkillsOnRegistration?: boolean;
  /**
   * Client-minted id for polling per-phase progress while this call is in flight (#388).
   * Optional: a caller that does not want progress omits it and nothing is recorded.
   */
  progressId?: string;
}

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

  async function registerProject(body: RegisterProjectInput) {
    const progress = startRegistrationProgress(body.progressId);
    try {
      return await registerProjectTracked(body, progress);
    } catch (err) {
      finishRegistrationProgress(progress, errorMessage(err));
      throw err;
    }
  }

  async function registerProjectTracked(body: RegisterProjectInput, progress: string | null) {
    if (!body.repoPath && !body.cloneUrl) {
      throw new ProjectError("repoPath or cloneUrl is required", "BAD_REQUEST");
    }
    if (body.repoPath && body.cloneUrl) {
      throw new ProjectError("Provide either repoPath or cloneUrl, not both", "BAD_REQUEST");
    }

    let localPath = body.repoPath;
    if (body.cloneUrl) {
      beginRegistrationPhase(progress, "clone");
      try {
        localPath = await cloneRepo(body.cloneUrl, { name: body.name });
      } catch (err) {
        throw new ProjectError(`Clone failed: ${errorMessage(err)}`, "BAD_REQUEST");
      }
    }

    beginRegistrationPhase(progress, "inspect-repo");
    let repoInfo;
    try {
      repoInfo = await detectRepoInfo(localPath!);
    } catch (err) {
      throw new ProjectError(`Invalid repo: ${errorMessage(err)}`, "BAD_REQUEST");
    }

    const name = body.name || repoInfo.repoName;

    const existing = await getProjectByRepoPath(repoInfo.repoPath, database);
    if (existing) {
      throw new ProjectError(`Project "${existing.name}" is already registered at this path`, "CONFLICT");
    }

    // Default onboarding skill so a freshly-registered project's worktrees aren't skill-less (#531).
    beginRegistrationPhase(progress, "create-project");
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
    // Two nameable steps in one call: the scaffold writes guards/config, the population derives
    // the stack profile and setup command. Reported as `scaffold` because that is what starts
    // first; `stack-profile` follows it below so a slow derivation is visibly its own wait.
    beginRegistrationPhase(progress, "scaffold");
    await scaffoldAndPopulateProject(id, repoInfo.repoPath, database, {
      gitignoreTemplate: body.gitignoreTemplate ? GITIGNORE_TEMPLATES[body.gitignoreTemplate] : undefined,
    });
    beginRegistrationPhase(progress, "stack-profile");
    endRegistrationPhase(progress, "done");

    if (body.generateReadme) {
      const readmePath = join(repoInfo.repoPath, "README.md");
      if (!existsSync(readmePath)) {
        try { writeFileSync(readmePath, `# ${name}\n`, "utf8"); } catch { /* non-fatal */ }
      }
    }

    beginRegistrationPhase(progress, "seed-skills");
    const shouldExport = body.exportSkillsOnRegistration ??
      ((await getPreference("export_skills_on_registration", database)) === "true");
    if (!shouldExport) endRegistrationPhase(progress, "skipped", "skill export is off for this board");
    if (shouldExport) await exportBuiltinSkillsToProject(repoInfo.repoPath, database);

    beginRegistrationPhase(progress, "finalize");
    finishRegistrationProgress(progress);
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
      throw new ProjectError(`Failed to create directory: ${errorMessage(err)}`, "BAD_REQUEST");
    }

    try {
      gitExecSync(["init"], { cwd: targetPath, stdio: "pipe" });
    } catch (err: unknown) {
      try { rmSync(targetPath, { recursive: true, force: true }); } catch {}
      const stderr = (err as { stderr?: string | Buffer }).stderr;
      throw new ProjectError(`git init failed: ${stderr ? String(stderr).trim() : String(err)}`, "BAD_REQUEST");
    }

    // `git init` leaves HEAD on an UNBORN branch — a repo with no commits (#47). Everything
    // downstream assumes a born HEAD: the scaffold commit resolved the current branch and threw
    // into a non-fatal catch (so the board's own scaffold stayed permanently untracked, and the
    // first agent's `git add -A` swept it into an unrelated feature commit), and `git worktree
    // add` cannot branch from a commit that does not exist. Give the repo its first commit here,
    // BEFORE scaffolding — then registration's shared step behaves exactly as it does for an
    // imported repo, which always arrives with a commit.
    //
    // The README (when requested) is the natural content for it; otherwise commit empty.
    if (body.generateReadme) {
      try { writeFileSync(join(targetPath, "README.md"), `# ${name}\n`, "utf8"); } catch { /* non-fatal */ }
    }
    try {
      createInitialCommit(targetPath);
    } catch (err) {
      try { rmSync(targetPath, { recursive: true, force: true }); } catch {}
      throw new ProjectError(
        `Failed to create the initial commit: ${errorMessage(err)}`,
        "BAD_REQUEST",
      );
    }

    const existing = await getProjectByRepoPath(targetPath, database);
    if (existing) {
      throw new ProjectError(`Project "${existing.name}" is already registered at this path`, "CONFLICT");
    }

    let repoInfo;
    try {
      repoInfo = await detectRepoInfo(targetPath);
    } catch (err) {
      throw new ProjectError(`Failed to read repo info: ${errorMessage(err)}`, "BAD_REQUEST");
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
    // THE shared registration step (#43/#44) — see scaffoldAndPopulateProject in
    // project-registration.ts: scaffold → populate the derived config → commit what the board
    // wrote (#41). This path used to hand-roll the ensure*/commit chain AND never call
    // populateStackProfile / populateVerifyScript / populateSetupScript at all, so a project
    // created here had setup_script = null (no dependency install in worktrees — #37/#810) and
    // verify_script = null (the #788 auto-merge gate never live) forever.
    //
    // `skipLlm: true` on purpose (#44). Unlike every other registration entry point, this one
    // OWNS the directory: it refuses a pre-existing path and `git init`s an empty one, so at
    // population time the repo provably contains nothing but the board's own scaffold. The LLM
    // gap-fill would therefore be handed "Detected marker files: none / Repo root entries:
    // .claude, .gitignore, CLAUDE.md, AGENTS.md" — any non-null answer is invention, not
    // detection, and an invented setup_script is strictly WORSE than null: it is executed in
    // every worktree, so a guessed `npm install` fails on what the user then builds as a Python
    // project, whereas null lets the Builder install correctly. Skipping also costs a ~30s
    // `claude` subprocess per project creation. As a bonus it makes the #41 hazard unreachable
    // rather than merely defused: no enrichment is scheduled at all, so nothing can settle after
    // the scaffold commit and re-dirty the user's checkout.
    await scaffoldAndPopulateProject(id, repoInfo.repoPath, database, {
      gitignoreTemplate: body.gitignoreTemplate ? GITIGNORE_TEMPLATES[body.gitignoreTemplate] : undefined,
      skipLlm: true,
    });

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

    // Synchronous per-worktree mapping: with the inline git spawns gone there is
    // nothing left to await, which is also why no per-request wall-clock budget is
    // needed here (see #342 note below) — the request is now one git spawn
    // (listWorktrees) plus one DB query, both already bounded.
    return gitWorktrees.map((wt, index) => {
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

      // Diff stats are NEVER computed inline here (#342). This used to await one
      // `git diff --shortstat` subprocess per non-main worktree inside a Promise.all:
      // with ~45 active worktrees, 40+ parallel git spawns against one repo serialize
      // on Windows disk/index-lock contention and the endpoint measured 112.7s
      // followed by two 120s timeouts.
      //
      // A worktree that maps to a workspace is served from the diff_stat_cache_*
      // columns the board summary path already maintains. The rest are served from a
      // last-known-good in-process cache refreshed by a bounded background queue, so a
      // first sighting returns undefined — which the UI already renders the same as a
      // zero diff.
      let diffStats: DiffStats | undefined;
      if (!isMain) {
        const base = ws?.baseBranch || defaultBranch;
        if (base) {
          diffStats = ws
            ? (selectCachedDiffStats(ws) ?? undefined)
            : cachedWorktreeDiffStats(wt.path, base);
          if (!ws) {
            scheduleWorktreeDiffStatsRefresh(wt.path, base, () => getDiffShortstat(wt.path, base));
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
    });
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

  /**
   * The workspace-summary map for a project, via the shared cache: fresh hit served
   * directly, stale entry served immediately with a background rebuild (SWR), cold miss
   * blocking on a single coalesced rebuild.
   *
   * Extracted from getBoard so getGraph uses the SAME path (#345). getGraph used to call
   * buildWorkspaceSummaryMap directly, bypassing the cache entirely, so EVERY graph
   * request paid a full cold rebuild — per-workspace git spawns plus the synchronous
   * transcript reads — measured at 13.2s, during which /api/health (pure JS) stalled
   * 3.6-30s and the dev proxy started refusing connections with 503s. The graph does not
   * need fresher summaries than the board.
   */
  function resolveSummaryMap(
    projectId: string,
    issueIds: string[],
    defaultBranch: string | null,
    archivedIssueIds: Set<string>,
  ): Promise<Map<string, WorkspaceSummary>> {
    const cacheResult = workspaceSummaryCache?.get(projectId) ?? null;
    if (cacheResult && !cacheResult.stale) {
      // Fresh cache hit — return immediately, no rebuild needed
      return Promise.resolve(cacheResult.value);
    }
    if (cacheResult && cacheResult.stale) {
      // Stale-while-revalidate: return stale data immediately, rebuild in background
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
      return Promise.resolve(cacheResult.value);
    }
    // Cold miss — must block on a rebuild (no stale data available), but coalesce:
    // concurrent cold requests share ONE in-flight rebuild instead of stacking duplicates.
    return startSummaryRebuild(projectId, issueIds, defaultBranch, archivedIssueIds);
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

    const summaryMapPromise = resolveSummaryMap(projectId, issueIds, defaultBranch, archivedIssueIds);

    // G14a: the two staleness prefs ride the #402 short-TTL cached full scan
    // instead of two point-read round trips per board build.
    const [workspaceSummaryMap, blockedMap, issueTagMap, prefRows] = await Promise.all([
      summaryMapPromise,
      buildBlockedMap(issueIds, database),
      buildTagMap(issueIds, database),
      getAllPreferencesCached(database),
    ]);

    const prefValue = (key: string) => prefRows.find((r) => r.key === key)?.value;
    const staleDays = parseInt(prefValue("backlog_stale_days") ?? "14", 10) || 14;
    const inProgressStaleDays = parseInt(prefValue("inprogress_stale_days") ?? "3", 10) || 3;
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
    const archivedIssueIds = new Set(
      projectIssues
        .filter((i) => i.statusName && ARCHIVE_STATUS_NAMES.has(i.statusName.toLowerCase()))
        .map((i) => i.id),
    );

    // Same cached SWR path as getBoard (#345) instead of an unconditional cold rebuild.
    const [edges, cachedSummaryMap] = await Promise.all([
      buildGraphEdges(issueIds, database),
      resolveSummaryMap(projectId, issueIds, project.defaultBranch, archivedIssueIds),
    ]);

    // The graph's issue set is a SUPERSET of the board's: getBoardIssues excludes the
    // "Archived" column, getGraphIssues includes everything. So a map built by a board
    // request can be missing those ids, and dropping their workspaceSummary would be a
    // silent regression. Build a supplement for just the gap — normally empty, and never
    // more than the Archived column, so this is not a second full rebuild.
    const missingIds = issueIds.filter((id) => !cachedSummaryMap.has(id));
    const workspaceSummaryMap = missingIds.length === 0
      ? cachedSummaryMap
      : new Map([
        ...cachedSummaryMap,
        ...await buildWorkspaceSummaryMap(missingIds, project.defaultBranch, database, archivedIssueIds),
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
        const archivedIssueIds = new Set(
          projectIssues
            .filter((i) => i.statusName && ARCHIVE_STATUS_NAMES.has(i.statusName.toLowerCase()))
            .map((i) => i.id),
        );
        // Same cached SWR path as getBoard/getGraph (#345). This path used to call
        // buildWorkspaceSummaryMap directly (and without archivedIssueIds), so ONE
        // /api/projects/all/workspaces request paid an uncached N-projects × M-workspaces
        // git+FS fan-out that starved the event loop for every other request.
        const workspaceSummaryMap = await resolveSummaryMap(project.id, issueIds, project.defaultBranch, archivedIssueIds);

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
    // Enrich each project with a count of workspaces whose agent is currently
    // active (running, reviewing, or resolving conflicts), so the project
    // selector can surface where agents are working without a second request.
    const [projectRows, activeCounts] = await Promise.all([
      getAllProjects(database, opts),
      getActiveWorkspaceCounts(database),
    ]);

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
    createSiblingRepoDir: (projectId: string, opts: { name: string; generateReadme?: boolean }) =>
      createSiblingRepoDir(database, projectId, opts),
    promoteRepoToLeading: (projectId: string, repoId: string) =>
      promoteRepoToLeading(database, projectId, repoId),
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
