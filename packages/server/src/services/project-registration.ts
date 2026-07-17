import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { randomUUID } from "node:crypto";
import { resolve, basename } from "node:path";
import type { StackProfile } from "@agentic-kanban/shared";
import { detectRepoInfo } from "./git-info.service.js";
import { initializeProjectStatuses } from "../repositories/issue.repository.js";
import { getCurrentBranch } from "./git.service.js";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { populateStackProfile, getStackProfile, populateVerifyScript, verifyScriptPrefKey, populateSetupScript, detectStackProfile } from "./stack-profile.service.js";
import {
  ensureAgentGitignore,
  ensureStarterClaudeMd,
  ensureStarterAgentsMd,
  ensureHookScaffold,
  ensureVerifyGateRunner,
  commitProjectScaffoldArtifacts,
} from "./project-scaffold.js";
import { getPreference } from "../repositories/preferences.repository.js";
import {
  getAllProjects,
  getProjectByIdRaw,
  getProjectStatusesByProject,
  remapIssueStatus,
  reassignProjectChildren,
  insertProjectStatus,
  deleteProjectStatusesByProject,
  deleteProjectRow,
  getActiveProjectPreference,
  setActiveProjectPreference,
  updateProjectRepoPath,
  getBoardNavigatorSkillId,
  insertRegisteredProject,
  upsertActiveProjectPreference,
  getProjectStatusIdsByProject,
  updateProjectDefaultBranch,
} from "../repositories/project-registration.repository.js";

/**
 * Resolve a non-null default branch for a freshly-registered repo.
 *
 * detectRepoInfo() only finds a local `main`/`master`; a repo whose default branch
 * is named anything else returns null, which later makes `POST /api/workspaces`
 * 400 "No default branch configured" and the monitor's auto-start swallow it
 * silently (#772). Fall back to the repo's actually checked-out branch.
 */
async function resolveDefaultBranch(
  repoPath: string,
  detected: string | null,
): Promise<string | null> {
  if (detected) return detected;
  try {
    const current = (await getCurrentBranch(repoPath)).trim();
    // "HEAD" means detached; not a usable branch name.
    if (current && current !== "HEAD") return current;
  } catch {
    // git unavailable / no commits yet — leave null, caller warns.
  }
  return null;
}

async function tryGetGitRoot(repoPath: string): Promise<string | null> {
  try {
    const stdout = await gitExecOrThrow(["rev-parse", "--show-toplevel"], { cwd: repoPath, timeout: 5000 });
    return resolve(stdout.trim());
  } catch {
    return null;
  }
}

/**
 * Detects and removes duplicate project registrations caused by registering a subdirectory
 * of a git repo before git-root resolution was added to detectRepoInfo.
 *
 * Groups all projects by their resolved git root. When multiple projects share the same
 * git root, keeps the one with repoPath == gitRoot (or the most recently updated), moves
 * any issues/skills to the survivor, and deletes the duplicates.
 */
export async function deduplicateProjects(): Promise<void> {
  const allProjects = await getAllProjects();
  if (allProjects.length <= 1) return;

  // Map gitRoot → projects that resolve to it
  const byGitRoot = new Map<string, typeof allProjects>();
  for (const project of allProjects) {
    const gitRoot = await tryGetGitRoot(project.repoPath);
    if (!gitRoot) continue; // can't resolve — skip
    const group = byGitRoot.get(gitRoot) ?? [];
    group.push(project);
    byGitRoot.set(gitRoot, group);
  }

  for (const [gitRoot, group] of byGitRoot) {
    if (group.length <= 1) continue;

    // Prefer the project whose repoPath already equals the git root;
    // break ties by updatedAt (most recent wins).
    const sorted = [...group].sort((a, b) => {
      const aIsRoot = a.repoPath === gitRoot ? 1 : 0;
      const bIsRoot = b.repoPath === gitRoot ? 1 : 0;
      if (aIsRoot !== bIsRoot) return bIsRoot - aIsRoot;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    const [keep, ...remove] = sorted;
    for (const dup of remove) {
      console.log(
        `[startup] Removing duplicate project "${dup.name}" (${dup.repoPath}) ` +
        `— same git repo as "${keep.name}" (${keep.repoPath})`
      );

      await db.transaction(async (tx) => {
        // Remap issue statusIds to the surviving project's statuses (matched by name).
        // This MUST run while the dup's issues still carry the dup's projectId, before the
        // generic reassignment below moves them — remapIssueStatus filters by dup projectId.
        const dupStatuses = await getProjectStatusesByProject(dup.id, tx);
        const keepStatuses = await getProjectStatusesByProject(keep.id, tx);
        for (const dupStatus of dupStatuses) {
          let match = keepStatuses.find((s) => s.name === dupStatus.name);
          // Name-MISMATCH case: the survivor has no identically-named status. Without
          // handling this, the dup's status row gets deleted while a moved issue still
          // points at it → dangling issues.status_id. Create the missing status on the
          // survivor and remap onto it so nothing is left dangling (#929).
          if (!match) {
            const newStatusId = randomUUID();
            await insertProjectStatus(
              {
                id: newStatusId,
                projectId: keep.id,
                name: dupStatus.name,
                sortOrder: dupStatus.sortOrder,
                isDefault: false, // never override the survivor's existing default
                createdAt: dupStatus.createdAt,
              },
              tx,
            );
            match = { ...dupStatus, id: newStatusId, projectId: keep.id, isDefault: false };
            keepStatuses.push(match);
          }
          if (match.id !== dupStatus.id) {
            await remapIssueStatus(dup.id, dupStatus.id, match.id, tx);
          }
        }

        // Reassign EVERY project-child table (derived from the schema FK graph) to the
        // survivor — issues, agent_skills, repos, scheduled_runs AND the previously-lost
        // milestones / drives / drive_obstacles (cascade children) and workflow_templates /
        // quality_metrics / board_health_events / flaky_tests / project_script_shortcuts /
        // scheduled_run_history (non-cascade children). project_statuses is excluded: the
        // dup's statuses were remapped-by-name above and are deleted next (moving them would
        // duplicate status columns on the survivor).
        await reassignProjectChildren(dup.id, keep.id, tx, new Set(["project_statuses"]));

        // Remove duplicate's statuses
        await deleteProjectStatusesByProject(dup.id, tx);
        // Remove duplicate project
        await deleteProjectRow(dup.id, tx);

        // If activeProjectId pointed to the removed project, redirect it to the survivor
        const activePref = await getActiveProjectPreference(tx);
        if (activePref[0]?.value === dup.id) {
          const now = new Date().toISOString();
          await setActiveProjectPreference(keep.id, now, tx);
        }
      });
    }

    // If the surviving project still has a non-root repoPath, update it to the git root
    if (keep.repoPath !== gitRoot) {
      await updateProjectRepoPath(keep.id, gitRoot, basename(gitRoot), new Date().toISOString());
    }
  }
}

// ---------------------------------------------------------------------------
// Shared registration steps (#43)
// ---------------------------------------------------------------------------
//
// Every registration entry point (REST `POST /api/projects` → project.service.ts,
// CLI `register` → cli/commands/register.ts, CLI `init` / `dev` auto-register →
// registerProject below) MUST route its scaffolding and derived-config population
// through the two functions here. Previously each path hand-rolled its own chain,
// so a new registration-time step had to be remembered in three places — which is
// exactly how #37 happened (#810's setup script and #788's verify script were wired
// into one path only, and the REST path still had no setup script at all).
//
// Add a new registration-time step HERE, never in a caller.

/**
 * Scaffold a repo's board-authored artifacts (clobber-safe: every `ensure*` is
 * append-/create-if-missing and never overwrites a user's file).
 *
 * `gitignoreTemplate` is the language-template CONTENT seeded only when the repo has
 * no `.gitignore` at all; the per-stack build-output ignores (target/, __pycache__/,
 * *.class, …) are derived from the rule-based stack detection so a non-Node project's
 * build artifacts never make main dirty and block auto-merge (#811).
 *
 * ORDERING IS LOAD-BEARING (#38): `ensureVerifyGateRunner` internally runs
 * `ensureBuildableFromClean`, which records the non-`.claude` project files it rewrote
 * (package.json / pnpm-workspace.yaml) in module-level state keyed by repo path.
 * `commitProjectScaffoldArtifacts` consumes and clears that record. The two MUST stay
 * back-to-back in ONE process, or the board's own package.json edit is left uncommitted
 * and main goes dirty. Do not split, reorder, or defer the commit.
 *
 * Non-fatal by design: scaffolding must never block registration.
 */
export async function scaffoldProject(
  repoPath: string,
  options?: { gitignoreTemplate?: string },
): Promise<void> {
  try {
    const detectedStack = detectStackProfile(repoPath).stack;
    ensureAgentGitignore(repoPath, options?.gitignoreTemplate, detectedStack);
    ensureStarterClaudeMd(repoPath);
    ensureStarterAgentsMd(repoPath);
    ensureHookScaffold(repoPath);
    ensureVerifyGateRunner(repoPath); // → ensureBuildableFromClean (records its rewrites)
    await commitProjectScaffoldArtifacts(repoPath); // MUST stay in-process, immediately after
  } catch {
    /* non-fatal: scaffolding must never block registration */
  }
}

/**
 * Mirror of `isProfileSparse` in stack-profile/persistence.ts (not exported there, and that
 * file is owned by another ticket). Only used to decide whether an LLM gap-fill WOULD run,
 * so a caller can report it; `populateStackProfile` re-checks this itself and is the
 * authority. Keep in sync.
 */
function wouldEnrichWithLlm(profile: StackProfile): boolean {
  return !profile.stack || (!profile.testCommand && !profile.buildCommand);
}

export interface DerivedConfigOptions {
  /** Never invoke the LLM gap-fill at all (tests, offline callers). */
  skipLlm?: boolean;
  /**
   * Await the LLM gap-fill instead of backgrounding it. For short-lived processes
   * (the CLI) a detached promise is lost when the process exits — see register.ts.
   */
  awaitEnrichment?: boolean;
  /** Progress reporter, so an interactive caller's ~30s wait is explained, not a hang. */
  onProgress?: (message: string) => void;
}

export interface DerivedProjectConfig {
  setupScript: string | null;
  verifyScript: string | null;
  /**
   * Resolves when background LLM enrichment settles; null when none was scheduled
   * (not sparse / skipLlm / already awaited). Exposed so tests can await it
   * deterministically instead of racing a detached promise.
   */
  enrichment: Promise<{ setupScript: string | null; verifyScript: string | null }> | null;
}

/**
 * Derive & persist the post-registration config every entry point needs: the durable stack
 * profile (#786) — the ONE descriptor the feedback harness reads — plus the verify/merge-gate
 * command (#788) and the monorepo-aware setup/install script (#810) derived from that SAME
 * profile, so the auto-merge gate is live AND deps are installed before the first build.
 *
 * The deterministic/rule-based pass is AWAITED (#42/#43). It is fast and offline (the same
 * reason drive.service.ts passes `skipLlm`), which closes two bugs at once:
 *  - the REST path's race — a caller creating a workspace right after registration used to
 *    beat the fire-and-forget population and get `{"command": null, "state": "skipped"}` setup;
 *  - the CLI's exit — `process.exit(0)` dropped a detached promise entirely (that was #37).
 *
 * The OPTIONAL LLM gap-fill (`enrichWithLlm` → `invokeClaudePrompt`, 30s timeout) only ever
 * fires for a marker-sparse repo, and is kept OFF the hot path: backgrounded by default so a
 * server request never blocks ~30s on it. `awaitEnrichment` opts a short-lived CLI in.
 *
 * Non-fatal throughout: a detection failure must never fail registration — the project stays
 * usable and `repairProjectRegistration()` can retry.
 */
export async function populateDerivedProjectConfig(
  projectId: string,
  repoPath: string,
  database: Database = db,
  options?: DerivedConfigOptions,
): Promise<DerivedProjectConfig> {
  let profile: StackProfile;
  let setupScript: string | null = null;
  let verifyScript: string | null = null;

  try {
    // Rule-based only: fast + offline, so this is safe to await on any path.
    profile = await populateStackProfile(projectId, repoPath, database, { skipLlm: true });
    verifyScript = await populateVerifyScript(projectId, repoPath, database, profile);
    setupScript = await populateSetupScript(projectId, repoPath, database, profile);
  } catch {
    return { setupScript: null, verifyScript: null, enrichment: null };
  }

  if (options?.skipLlm || !wouldEnrichWithLlm(profile)) {
    return { setupScript, verifyScript, enrichment: null };
  }

  options?.onProgress?.(
    "  Stack markers are sparse — asking the LLM to fill in the gaps (up to 30s)…",
  );

  // Re-runs populateStackProfile WITHOUT skipLlm; it re-checks sparseness itself and is the
  // authority on whether the LLM is actually called. populateVerifyScript/populateSetupScript
  // are idempotent — they return an already-configured value rather than clobbering it.
  const enrichment = (async () => {
    try {
      const enriched = await populateStackProfile(projectId, repoPath, database);
      return {
        verifyScript: await populateVerifyScript(projectId, repoPath, database, enriched),
        setupScript: await populateSetupScript(projectId, repoPath, database, enriched),
      };
    } catch {
      return { setupScript: null, verifyScript: null }; // non-fatal
    }
  })();

  if (!options?.awaitEnrichment) {
    return { setupScript, verifyScript, enrichment };
  }

  const enrichedResult = await enrichment;
  return {
    setupScript: enrichedResult.setupScript ?? setupScript,
    verifyScript: enrichedResult.verifyScript ?? verifyScript,
    enrichment: null,
  };
}

export interface RegisterProjectOptions extends DerivedConfigOptions {
  name?: string;
  /** Language-template content seeded only when the repo has no `.gitignore`. */
  gitignoreTemplate?: string;
}

export async function registerProject(path: string, options?: RegisterProjectOptions) {
  const repoInfo = await detectRepoInfo(path);
  const projectName = options?.name || repoInfo.repoName;

  // Check for an existing project at the exact git root, or one whose stored path
  // resolves to the same git root (handles legacy subdirectory registrations).
  const allProjects = await getAllProjects();
  const existing = allProjects.find((p) => p.repoPath === repoInfo.repoPath) ??
    (await (async () => {
      for (const p of allProjects) {
        const root = await tryGetGitRoot(p.repoPath);
        if (root === repoInfo.repoPath) return p;
      }
      return undefined;
    })());

  if (existing) {
    return { project: existing, created: false, setupScript: null, verifyScript: null };
  }

  const now = new Date().toISOString();
  const projectId = randomUUID();

  // Never leave defaultBranch null — that makes the project undriveable (#772).
  const defaultBranch = await resolveDefaultBranch(repoInfo.repoPath, repoInfo.defaultBranch);

  // Default skill so a freshly-registered project's worktrees aren't skill-less:
  // board-navigator teaches the agent how to use the board (MCP/CLI, reflect progress).
  // Without this, resolveSkillFile writes NO skill into a new project's worktree and the
  // Builder works blind. Falls back to null gracefully if the builtin isn't seeded. (#531)
  const navSkill = await getBoardNavigatorSkillId();
  const defaultSkillId = navSkill?.id ?? null;

  await insertRegisteredProject({
    id: projectId,
    name: projectName,
    repoPath: repoInfo.repoPath,
    repoName: repoInfo.repoName,
    defaultBranch,
    remoteUrl: repoInfo.remoteUrl,
    defaultSkillId,
    createdAt: now,
    updatedAt: now,
  });

  // Canonical 7-status set (incl. Backlog at -1) so auto-driven Backlog-pull works (#772).
  await initializeProjectStatuses(projectId, now);

  await upsertActiveProjectPreference(projectId, now);

  // The two shared registration steps — see their definitions above. This path used to do
  // NO scaffolding at all (so a project registered via CLI `init` / `dev` auto-register got
  // no agent gitignore, no hooks and no verify-gate runner), and fire-and-forget population.
  await scaffoldProject(repoInfo.repoPath, { gitignoreTemplate: options?.gitignoreTemplate });
  const { setupScript, verifyScript } = await populateDerivedProjectConfig(
    projectId,
    repoInfo.repoPath,
    db,
    options,
  );

  const project = {
    id: projectId,
    name: projectName,
    repoPath: repoInfo.repoPath,
    repoName: repoInfo.repoName,
    defaultBranch,
    remoteUrl: repoInfo.remoteUrl,
    defaultSkillId,
    createdAt: now,
    updatedAt: now,
  };

  return { project, created: true, setupScript, verifyScript };
}

/**
 * Backfill a driveable state onto an already-registered project (#772):
 *  - seed the canonical default status set if the project has none
 *    (missing statuses make `POST /api/issues/batch` 400 "No statuses found");
 *  - set defaultBranch from the repo's current branch if it is null
 *    (a null branch makes `POST /api/workspaces` 400 "No default branch configured").
 *
 * Idempotent: existing statuses are left untouched and a non-null branch is preserved.
 * Returns what (if anything) was repaired.
 */
export async function repairProjectRegistration(
  projectId: string,
): Promise<{ seededStatuses: boolean; setDefaultBranch: string | null; populatedStackProfile: boolean; populatedVerifyScript: boolean; populatedSetupScript: boolean }> {
  const project = await getProjectByIdRaw(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const now = new Date().toISOString();
  let seededStatuses = false;
  let setDefaultBranch: string | null = null;
  let populatedStackProfile = false;
  let populatedVerifyScript = false;
  let populatedSetupScript = false;

  const existingStatuses = await getProjectStatusIdsByProject(projectId);
  if (existingStatuses.length === 0) {
    await initializeProjectStatuses(projectId, now);
    seededStatuses = true;
  }

  if (!project.defaultBranch) {
    const branch = await resolveDefaultBranch(project.repoPath, null);
    if (branch) {
      await updateProjectDefaultBranch(projectId, branch, now);
      setDefaultBranch = branch;
    }
  }

  // Backfill the stack profile (#786) onto a project registered before profiles existed.
  // Idempotent: only computes when none is persisted yet.
  const existingProfile = await getStackProfile(projectId, db);
  if (!existingProfile) {
    try {
      await populateStackProfile(projectId, project.repoPath, db);
      populatedStackProfile = true;
    } catch {
      // non-fatal — leave unpopulated, a later repair/registration can retry.
    }
  }

  // Backfill the verify (merge-gate) command (#788) onto a project registered before #788.
  // Idempotent: populateVerifyScript no-ops when the key is already set or detection is empty.
  const existingVerify = await getPreference(verifyScriptPrefKey(projectId), db);
  if (!existingVerify || !existingVerify.trim()) {
    try {
      const written = await populateVerifyScript(projectId, project.repoPath, db);
      populatedVerifyScript = Boolean(written);
    } catch {
      // non-fatal — a later repair/registration can retry.
    }
  }

  // Backfill the monorepo-aware setup/install script (#810) onto a project registered
  // before #810. Idempotent: populateSetupScript no-ops when setup_script is already set
  // or detection is empty.
  if (!project.setupScript || !project.setupScript.trim()) {
    try {
      const written = await populateSetupScript(projectId, project.repoPath, db);
      populatedSetupScript = Boolean(written);
    } catch {
      // non-fatal — a later repair/registration can retry.
    }
  }

  return { seededStatuses, setDefaultBranch, populatedStackProfile, populatedVerifyScript, populatedSetupScript };
}
