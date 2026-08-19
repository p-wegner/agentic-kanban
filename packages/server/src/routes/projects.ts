import type { Database } from "../db/index.js";
import { createProjectService } from "../services/project.service.js";
import { getRegistrationProgress } from "../services/registration-progress.service.js";
import { searchGraphIssueIds } from "../repositories/graph-search.repository.js";
import { parseJsonBody, parseOptionalJsonBody } from "../middleware/parse-body.js";
import { createRouter } from "../middleware/create-router.js";
import { wrapAiOperation } from "../middleware/ai-operation.js";
import { getProjectActivity } from "../services/project-activity.service.js";
import type { BoardEvents } from "../services/board-events.js";
import type { SessionLauncher } from "../services/session.manager.js";
import { isAbsolute } from "node:path";
import { createWorkspaceSummaryCache } from "../services/workspace-summary-cache.service.js";
import { computeBodyEtag, conditionalJsonResponse, createBoardEtagCache } from "../services/board-etag-cache.service.js";
import { setSummaryWriteThroughListener } from "../services/summary-write-through-notifier.js";
import { getProjectIdsForWorkspaces } from "../repositories/workspace-summary.repository.js";
import { listProjectRepos, insertProjectRepo, updateProjectRepo, deleteProjectRepo, type RepoRow } from "../repositories/repo.repository.js";
import { updateProjectServicesConfig } from "../repositories/project.repository.js";
import { detectRepoInfo } from "../services/git-info.service.js";
import { parseIncludeParam, serveWorkspaceRepoStatusBatch } from "../services/workspace-repo-status-batch.service.js";
import { cloneRepo } from "../services/repo-clone.service.js";
import type { ProjectRepoResponse, ServiceStackConfig } from "@agentic-kanban/shared";
import { DEFAULT_SERVICE_STACK_CONFIG, parseServiceStackConfig } from "@agentic-kanban/shared/lib/service-stack-codec";
import { createOnboardingService } from "../services/onboarding.service.js";
import { createIssueService } from "../services/issue.service.js";
import { getPluginService } from "../services/plugin.service.js";
import { createAgentSkillService } from "../services/agent-skill.service.js";
import { createWebhookSender } from "../services/outbound-webhook.service.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

import { queryFlag, queryInt } from "../middleware/query-params.js";
import { requireProject } from "../services/require-project.js";
function toProjectRepoResponse(row: RepoRow): ProjectRepoResponse {
  return {
    id: row.id,
    projectId: row.projectId!,
    path: row.path,
    name: row.name,
    defaultBranch: row.defaultBranch,
    setupScript: row.setupScript ?? null,
    composeFile: row.composeFile ?? null,
    createdAt: row.createdAt,
  };
}

const SERVICE_PORT_NAME_RE = /^[a-zA-Z0-9_]+$/;
// A newline/CR in any string field would inject extra lines into the generated
// docker `--env-file` (e.g. an env value "x\nBAR=1" smuggles a second var). Reject.
const NEWLINE_RE = /[\r\n]/;
// Mirror of the env-writer's key constraint (isEnvLineSafe in
// workspace-services.service.ts): the generated `.kanban/services.env` is BOTH a
// docker `--env-file` and shell-sourced, so keys must be valid shell identifiers.
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate + normalize an incoming `servicesConfig` (from PATCH /api/projects/:id).
 * Returns the JSON string to persist (or null to clear), or an error string for a 422.
 * Mirrors how `symlinkDirs` is validated+serialized in project.service.updateProject.
 */
function validateServicesConfig(
  value: unknown,
): { ok: true; json: string | null } | { ok: false; error: string } {
  if (value === null || value === undefined || value === "") {
    return { ok: true, json: null };
  }
  let obj: unknown = value;
  if (typeof value === "string") {
    try {
      obj = JSON.parse(value);
    } catch {
      return { ok: false, error: "servicesConfig must be valid JSON" };
    }
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return { ok: false, error: "servicesConfig must be an object" };
  }
  const cfg = obj as Record<string, unknown>;
  if (typeof cfg.enabled !== "boolean") {
    return { ok: false, error: "servicesConfig.enabled must be a boolean" };
  }
  const enabled = cfg.enabled;
  const composeFile = cfg.composeFile;
  if (enabled) {
    if (typeof composeFile !== "string" || composeFile.trim() === "") {
      return { ok: false, error: "servicesConfig.composeFile must be a non-empty string when enabled" };
    }
  } else if (composeFile !== undefined && typeof composeFile !== "string") {
    return { ok: false, error: "servicesConfig.composeFile must be a string" };
  }
  if (typeof composeFile === "string" && NEWLINE_RE.test(composeFile)) {
    return { ok: false, error: "servicesConfig.composeFile must not contain newlines" };
  }
  if (cfg.ports !== undefined) {
    if (!Array.isArray(cfg.ports) || !cfg.ports.every((p) => typeof p === "string" && SERVICE_PORT_NAME_RE.test(p))) {
      return { ok: false, error: "servicesConfig.ports must be an array of [a-zA-Z0-9_]+ names" };
    }
    // F7: names collapse to KANBAN_SVC_<UPPER>_PORT env vars — a case-insensitive
    // collision (e.g. ["db","DB"]) would silently clobber one port. Reject it.
    const portNames = cfg.ports as string[];
    if (new Set(portNames.map((p) => p.toUpperCase())).size !== portNames.length) {
      return { ok: false, error: "servicesConfig.ports names must be unique case-insensitively (they map to KANBAN_SVC_<UPPER>_PORT)" };
    }
  }
  if (cfg.profiles !== undefined) {
    if (!Array.isArray(cfg.profiles) || !cfg.profiles.every((p) => typeof p === "string")) {
      return { ok: false, error: "servicesConfig.profiles must be an array of strings (compose profile names)" };
    }
    // Profile names go into COMPOSE_PROFILES='a,b' in the shell-sourced --env-file, so each
    // must be shell-safe AND comma-free (comma is the profile separator). Reject at save.
    const badProfile = (cfg.profiles as string[]).find(
      (p) => p.trim() === "" || p.includes(",") || NEWLINE_RE.test(p) || p.includes("'"),
    );
    if (badProfile !== undefined) {
      return { ok: false, error: `servicesConfig.profiles entry ${JSON.stringify(badProfile)} is invalid: profile names must be non-empty and contain no comma, CR/LF, or single quote (they are joined into COMPOSE_PROFILES in the shell-sourced --env-file)` };
    }
  }
  if (cfg.composeRepo !== undefined && cfg.composeRepo !== null && typeof cfg.composeRepo !== "string") {
    return { ok: false, error: "servicesConfig.composeRepo must be a string or null" };
  }
  if (typeof cfg.composeRepo === "string" && NEWLINE_RE.test(cfg.composeRepo)) {
    return { ok: false, error: "servicesConfig.composeRepo must not contain newlines" };
  }
  // F8: 0 or negative would become "no timeout" and hang the `up -d --wait` indefinitely.
  if (cfg.readyTimeoutMs !== undefined && (typeof cfg.readyTimeoutMs !== "number" || !Number.isFinite(cfg.readyTimeoutMs) || cfg.readyTimeoutMs <= 0)) {
    return { ok: false, error: "servicesConfig.readyTimeoutMs must be a finite number greater than 0" };
  }
  if (cfg.env !== undefined) {
    if (
      typeof cfg.env !== "object" ||
      cfg.env === null ||
      Array.isArray(cfg.env) ||
      !Object.values(cfg.env).every((v) => typeof v === "string")
    ) {
      return { ok: false, error: "servicesConfig.env must be a record of strings" };
    }
    // F11: a newline in an env value injects extra lines into the generated env file.
    if (Object.values(cfg.env).some((v) => NEWLINE_RE.test(v as string))) {
      return { ok: false, error: "servicesConfig.env values must not contain CR/LF (they would inject extra lines into the generated .kanban/services.env)" };
    }
    // Mirror the env-writer constraints (isEnvLineSafe in workspace-services.service.ts):
    // it DROPS entries with non-identifier keys or single-quoted values at provision
    // time (values are emitted single-quoted). Reject at save time instead of silently
    // losing the entry later.
    const badEnvKey = Object.keys(cfg.env).find((k) => !ENV_KEY_RE.test(k));
    if (badEnvKey !== undefined) {
      return { ok: false, error: `servicesConfig.env key ${JSON.stringify(badEnvKey)} is invalid: keys must match ^[A-Za-z_][A-Za-z0-9_]*$ (the env file is shell-sourced, so keys must be valid shell identifiers)` };
    }
    const quotedEnvEntry = Object.entries(cfg.env).find(([, v]) => (v as string).includes("'"));
    if (quotedEnvEntry !== undefined) {
      return { ok: false, error: `servicesConfig.env value for ${JSON.stringify(quotedEnvEntry[0])} must not contain single quotes (values are emitted single-quoted in .kanban/services.env, which cannot represent a ' identically for docker --env-file AND shell sourcing)` };
    }
  }
  const normalized: ServiceStackConfig = {
    enabled,
    composeFile:
      typeof composeFile === "string" && composeFile.trim()
        ? composeFile.trim()
        : DEFAULT_SERVICE_STACK_CONFIG.composeFile,
    ports: Array.isArray(cfg.ports) ? (cfg.ports as string[]) : [],
  };
  if (Array.isArray(cfg.profiles)) normalized.profiles = (cfg.profiles as string[]).map((p) => p.trim()).filter((p) => p.length > 0);
  if (cfg.composeRepo !== undefined) normalized.composeRepo = cfg.composeRepo as string | null;
  if (cfg.readyTimeoutMs !== undefined) normalized.readyTimeoutMs = cfg.readyTimeoutMs as number;
  if (cfg.env !== undefined) normalized.env = cfg.env as Record<string, string>;
  return { ok: true, json: JSON.stringify(normalized) };
}

/**
 * Parse a stored servicesConfig for the wire DTO (#531). The DISPLAY codec: a disabled
 * stack is still shown as declared config. This used to return the raw parsed object
 * with no defaults, so the board could show a half-populated stack the runtime would
 * have normalised differently.
 */
function parseServicesConfig(raw: unknown): ServiceStackConfig | null {
  return parseServiceStackConfig(typeof raw === "string" ? raw : null);
}

export function createProjectsRoute(database: Database, options?: { boardEvents?: BoardEvents; getSessionManager?: () => SessionLauncher }) {
  const router = createRouter();

  const workspaceSummaryCache = createWorkspaceSummaryCache();
  const projectService = createProjectService({ database, workspaceSummaryCache });
  const onboardingIssueService = createIssueService({
    database,
    boardEvents: options?.boardEvents,
    sendWebhook: createWebhookSender(database),
  });
  const onboardingService = createOnboardingService({
    database,
    pluginService: getPluginService(database),
    agentSkillService: createAgentSkillService({ database }),
    createIssuesBatch: onboardingIssueService.createIssuesBatch,
  });
  // The fast path is only sound when boardEvents is wired: without the invalidation
  // listener below, mutations would never bump the cache generation and the memo
  // could serve a wrong 304. Disabled (never permissive) when boardEvents is absent.
  const boardEtagCache = createBoardEtagCache({ enabled: Boolean(options?.boardEvents) });
  if (options?.boardEvents) {
    const boardEvents = options.boardEvents;
    boardEvents.addInvalidationListener((projectId) => {
      workspaceSummaryCache.invalidate(projectId);
      // Warm-ahead: start the board rebuild now (debounced to collapse event bursts)
      // so the client's WS-triggered refetch ~100-300ms later hits a warm or in-flight
      // cache instead of paying the full cold rebuild (measured 121-205ms per refetch).
      // G14f: only when someone is actually WATCHING — with zero WS subscribers there
      // is no follow-up refetch to warm ahead of, and monitor bursts were paying full
      // rebuilds for nobody.
      if (boardEvents.hasSubscribers(projectId)) {
        projectService.scheduleBoardWarmup(projectId);
      }
    });
    // G13: background write-throughs (diff stats, conflict cache, code metrics, the
    // #399 git projection) mutate board-visible fields without a boardEvents
    // broadcast. The notifier batches a sweep's changed workspaces; here we resolve
    // them to projects and bump each project's cache generation so the board ETag
    // fast path stops 304-ing a stale body.
    setSummaryWriteThroughListener(async (workspaceIds) => {
      const projectIds = await getProjectIdsForWorkspaces(workspaceIds, database);
      for (const projectId of projectIds) {
        workspaceSummaryCache.invalidate(projectId);
        if (boardEvents.hasSubscribers(projectId)) {
          projectService.scheduleBoardWarmup(projectId);
        }
      }
    });
  }

  // GET /api/projects  (?includeArchived=true to include archived projects)
  router.get("/", async (c) => {
    const includeArchived = queryFlag(c, "includeArchived");
    const result = await projectService.listProjects({ includeArchived });
    // Map the stored servicesConfig JSON string into the parsed wire shape (ProjectResponse).
    const withServices = result.map((p) => ({
      ...p,
      servicesConfig: parseServicesConfig((p as { servicesConfig?: unknown }).servicesConfig),
    }));
    // Conditional GET: content-hash ETag over the serialized list, 304 with no
    // body when the client's If-None-Match still matches (frequent polls).
    return conditionalJsonResponse(JSON.stringify(withServices), c.req.header("if-none-match"));
  });

  // POST /api/projects
  // GET /api/projects/registration-progress/:id — per-phase progress for a registration in
  // flight (#388). The POST is what blocks, so progress has to travel on a second connection;
  // the client mints the id, sends it with the POST, and polls this while it waits. Declared
  // BEFORE `/:id` routes that could otherwise swallow the path.
  router.get("/registration-progress/:id", (c) => {
    const progress = getRegistrationProgress(c.req.param("id"));
    // 404 rather than an empty shell: "I have never heard of this registration" and "it has not
    // reached its first phase" are different answers, and a spinner that cannot tell them apart
    // is the thing this ticket is about.
    if (!progress) return c.json({ error: "No such registration in progress" }, 404);
    return c.json(progress);
  });

  router.post("/", async (c) => {
    const body = await parseJsonBody<{
      repoPath?: string;
      cloneUrl?: string;
      name?: string;
      description?: string;
      color?: string;
      gitignoreTemplate?: string;
      generateReadme?: boolean;
      exportSkillsOnRegistration?: boolean;
      progressId?: string;
    }>(c);
    const result = await projectService.registerProject(body);
    options?.boardEvents?.broadcastProjectsChanged(result.id, "project_created");
    return c.json(result, 201);
  });

  // POST /api/projects/create — create a new directory as a git repo and register it
  router.post("/create", async (c) => {
    const body = await parseJsonBody<{
      name: string;
      path?: string;
      description?: string;
      color?: string;
      gitignoreTemplate?: string;
      generateReadme?: boolean;
    }>(c);
    const result = await projectService.createProject(body);
    options?.boardEvents?.broadcastProjectsChanged(result.id, "project_created");
    return c.json(result, 201);
  });

  // PATCH /api/projects/:id — update project fields
  router.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await parseJsonBody(c);
    // servicesConfig is validated + persisted here (not via the generic updateProject
    // mapper) so malformed config 422s before any other field is written.
    let servicesConfigJson: string | null | undefined;
    if (body.servicesConfig !== undefined) {
      const validated = validateServicesConfig(body.servicesConfig);
      if (!validated.ok) return c.json({ error: validated.error }, 422);
      servicesConfigJson = validated.json;
    }
    const result = await projectService.updateProject(id, body);
    if (servicesConfigJson !== undefined) {
      await updateProjectServicesConfig(id, servicesConfigJson, database);
      // F12: the ProjectResponse DTO promises a PARSED ServiceStackConfig | null, not the
      // raw JSON string. Reflect the value we just persisted, parsed the same way GET does.
      (result as { servicesConfig?: unknown }).servicesConfig = parseServicesConfig(servicesConfigJson);
    }
    options?.boardEvents?.broadcastProjectsChanged(id, "project_updated");
    return c.json(result);
  });

  // POST /api/projects/:id/archive — hide a project without deleting its data
  router.post("/:id/archive", async (c) => {
    const id = c.req.param("id");
    const result = await projectService.archiveProject(id);
    options?.boardEvents?.broadcastProjectsChanged(id, "project_updated");
    return c.json(result);
  });

  // POST /api/projects/:id/unarchive — restore an archived project
  router.post("/:id/unarchive", async (c) => {
    const id = c.req.param("id");
    const result = await projectService.unarchiveProject(id);
    options?.boardEvents?.broadcastProjectsChanged(id, "project_updated");
    return c.json(result);
  });

  // DELETE /api/projects/:id — unregister a project (cascade deletes all associated data)
  router.delete("/:id", async (c) => {
    const projectId = c.req.param("id");
    await projectService.deleteProject(projectId);
    options?.boardEvents?.broadcastProjectsChanged(projectId, "project_deleted");
    return c.json({ success: true });
  });

  // POST /api/projects/generate-setup-script
  router.post("/generate-setup-script", async (c) => {
    const body = await parseJsonBody<{ projectId?: string }>(c);
    if (!body.projectId) return c.json({ error: "projectId is required" }, 400);
    const setupScript = await wrapAiOperation("generate-setup-script", () => projectService.generateSetupScript(body.projectId!));
    return c.json({ setupScript });
  });

  // POST /api/projects/generate-verify-script
  router.post("/generate-verify-script", async (c) => {
    const body = await parseJsonBody<{ projectId?: string }>(c);
    if (!body.projectId) return c.json({ error: "projectId is required" }, 400);
    const verifyScript = await wrapAiOperation("generate-verify-script", () => projectService.generateVerifyScript(body.projectId!));
    return c.json({ verifyScript });
  });

  // POST /api/projects/generate-teardown-script
  router.post("/generate-teardown-script", async (c) => {
    const body = await parseJsonBody<{ projectId?: string }>(c);
    if (!body.projectId) return c.json({ error: "projectId is required" }, 400);
    const teardownScript = await wrapAiOperation("generate-teardown-script", () => projectService.generateTeardownScript(body.projectId!));
    return c.json({ teardownScript });
  });

  // GET /api/projects/:id/statuses
  router.get("/:id/statuses", async (c) => {
    const projectId = c.req.param("id");
    const result = await projectService.listStatuses(projectId);
    return c.json(result);
  });

  // POST /api/projects/:id/statuses
  router.post("/:id/statuses", async (c) => {
    const projectId = c.req.param("id");
    const body = await parseJsonBody<{ name: string; sortOrder?: number }>(c);
    const result = await projectService.addStatus(projectId, body.name, body.sortOrder ?? 0);
    return c.json(result, 201);
  });

  // PATCH /api/projects/:id/statuses/:statusId
  router.patch("/:id/statuses/:statusId", async (c) => {
    const projectId = c.req.param("id");
    const statusId = c.req.param("statusId");
    const body = await parseJsonBody(c);
    if (typeof body.sortOrder !== "number") return c.json({ error: "sortOrder must be a number" }, 400);
    await projectService.updateStatusSortOrder(projectId, statusId, body.sortOrder);
    return c.json({ success: true });
  });

  // DELETE /api/projects/:id/statuses/:statusId
  router.delete("/:id/statuses/:statusId", async (c) => {
    const projectId = c.req.param("id");
    const statusId = c.req.param("statusId");
    const result = await projectService.removeStatus(projectId, statusId);
    return c.json(result);
  });

  // GET /api/projects/:id/branches
  router.get("/:id/branches", async (c) => {
    const projectId = c.req.param("id");
    const branches = await projectService.getBranches(projectId);
    return c.json(branches);
  });

  // --- Multi-repo project repo set (additional repos; leading repo = project.repoPath) ---

  // GET /api/projects/:id/repos
  router.get("/:id/repos", async (c) => {
    const projectId = c.req.param("id");
    const rows = await listProjectRepos(projectId, database);
    return c.json(rows.map(toProjectRepoResponse));
  });

  // POST /api/projects/:id/repos — add an additional repo. Three modes (exactly one):
  //   { path }       — an existing local git repo (absolute path)
  //   { cloneUrl }   — clone a remote repo into the server's repos dir
  //   { createName } — scaffold a NEW git repo (folder created inside the project folder)
  router.post("/:id/repos", async (c) => {
    const projectId = c.req.param("id");
    const body = await parseJsonBody<{ path?: string; cloneUrl?: string; createName?: string; name?: string; generateReadme?: boolean; setupScript?: string | null; composeFile?: string | null }>(c);
    const modeCount = [body.path, body.cloneUrl, body.createName].filter((v) => typeof v === "string" && v.trim()).length;
    if (modeCount !== 1) {
      return c.json({ error: "Provide exactly one of path, cloneUrl, or createName" }, 400);
    }
    // A relative `path` would otherwise be resolved against the SERVER's CWD (packages/server) by
    // detectRepoInfo, yielding a misleading "not a git repository: <server-dir>/<fragment>" error
    // for a path the caller never supplied. Require an absolute path and fail clearly (#68).
    if (body.path && !isAbsolute(body.path)) {
      return c.json({ error: "repo path must be an absolute path" }, 400);
    }
    const project = await requireProject(projectId, database);

    let localPath = body.path;
    if (body.cloneUrl) {
      try {
        localPath = await cloneRepo(body.cloneUrl, { name: body.name });
      } catch (err) {
        return c.json({ error: `Clone failed: ${errorMessage(err)}` }, 400);
      }
    } else if (body.createName) {
      // Throws ProjectError (mapped to 400/404/409 by the domain error handler) on failure.
      localPath = await projectService.createSiblingRepoDir(projectId, { name: body.createName, generateReadme: body.generateReadme });
    }
    let repoInfo;
    try {
      repoInfo = await detectRepoInfo(localPath!);
    } catch (err) {
      return c.json({ error: `Invalid repo: ${errorMessage(err)}` }, 400);
    }
    if (repoInfo.repoPath === project.repoPath) {
      return c.json({ error: "This is already the project's leading repo" }, 409);
    }
    const existing = await listProjectRepos(projectId, database);
    if (existing.some((r) => r.path === repoInfo.repoPath)) {
      return c.json({ error: "Repo is already part of this project" }, 409);
    }
    const row = await insertProjectRepo({
      projectId,
      path: repoInfo.repoPath,
      name: body.name ?? repoInfo.repoName,
      defaultBranch: repoInfo.defaultBranch,
      setupScript: typeof body.setupScript === "string" ? body.setupScript : null,
      composeFile: typeof body.composeFile === "string" ? body.composeFile : null,
    }, database);
    options?.boardEvents?.broadcastProjectsChanged(projectId, "project_updated");
    return c.json(toProjectRepoResponse(row), 201);
  });

  // PATCH /api/projects/:id/repos/:repoId — update a registered repo's per-repo setup/compose config (#71)
  router.patch("/:id/repos/:repoId", async (c) => {
    const projectId = c.req.param("id");
    const repoId = c.req.param("repoId");
    const body = await parseJsonBody<{ name?: string; setupScript?: string | null; composeFile?: string | null }>(c);
    if (body.name !== undefined && typeof body.name !== "string") {
      return c.json({ error: "name must be a string" }, 400);
    }
    if (body.setupScript !== undefined && body.setupScript !== null && typeof body.setupScript !== "string") {
      return c.json({ error: "setupScript must be a string or null" }, 400);
    }
    if (body.composeFile !== undefined && body.composeFile !== null && typeof body.composeFile !== "string") {
      return c.json({ error: "composeFile must be a string or null" }, 400);
    }
    if (body.composeFile && /[\r\n]/.test(body.composeFile)) {
      return c.json({ error: "composeFile must not contain newlines" }, 400);
    }
    const existing = await listProjectRepos(projectId, database);
    if (!existing.some((r) => r.id === repoId)) return c.json({ error: "Repo not found" }, 404);
    // `name` is validated here (route-level) since it must be unique among the project's repos (#90).
    let nameToSet: string | undefined;
    if (body.name !== undefined) {
      const trimmed = body.name.trim();
      if (!trimmed) return c.json({ error: "name must not be empty" }, 400);
      if (existing.some((r) => r.id !== repoId && r.name === trimmed)) {
        return c.json({ error: "name must be unique among the project's repos" }, 409);
      }
      nameToSet = trimmed;
    }
    const row = await updateProjectRepo(repoId, { name: nameToSet, setupScript: body.setupScript, composeFile: body.composeFile }, database);
    if (!row) return c.json({ error: "Repo not found" }, 404);
    options?.boardEvents?.broadcastProjectsChanged(projectId, "project_updated");
    return c.json(toProjectRepoResponse(row));
  });

  // DELETE /api/projects/:id/repos/:repoId — remove an additional repo from the set
  // (does not touch the checkout on disk; existing workspaces keep their worktrees)
  router.delete("/:id/repos/:repoId", async (c) => {
    const projectId = c.req.param("id");
    const repoId = c.req.param("repoId");
    const deleted = await deleteProjectRepo(repoId, projectId, database);
    if (!deleted) return c.json({ error: "Repo not found" }, 404);
    options?.boardEvents?.broadcastProjectsChanged(projectId, "project_updated");
    return c.json({ success: true });
  });

  // POST /api/projects/:id/repos/:repoId/promote — make this sibling the project's LEADING repo,
  // demoting the current leading into a sibling. Throws ProjectError (409 on open workspaces) via
  // the domain error handler.
  router.post("/:id/repos/:repoId/promote", async (c) => {
    const projectId = c.req.param("id");
    const repoId = c.req.param("repoId");
    const result = await projectService.promoteRepoToLeading(projectId, repoId);
    options?.boardEvents?.broadcastProjectsChanged(projectId, "project_updated");
    return c.json({ success: true, ...result });
  });

  // GET /api/projects/:id/stats — lightweight project stats
  router.get("/:id/stats", async (c) => {
    const projectId = c.req.param("id");
    const result = await projectService.getStats(projectId);
    return c.json(result);
  });

  // GET /api/projects/:id/worktrees
  router.get("/:id/worktrees", async (c) => {
    const projectId = c.req.param("id");
    const result = await projectService.getWorktrees(projectId);
    return c.json(result);
  });

  // DELETE /api/projects/:id/worktrees
  router.delete("/:id/worktrees", async (c) => {
    const projectId = c.req.param("id");
    const body = await parseJsonBody<{ path?: string; workspaceId?: string }>(c);
    if (!body.path && !body.workspaceId) return c.json({ error: "path or workspaceId is required" }, 400);

    await projectService.removeWorktreeById(projectId, body);
    return c.json({ success: true });
  });

  // POST /api/projects/:id/worktrees/open — open a worktree folder in the OS file explorer
  router.post("/:id/worktrees/open", async (c) => {
    const body = await parseJsonBody<{ path: string }>(c);
    if (!body.path) return c.json({ error: "path is required" }, 400);

    projectService.openInExplorer(body.path);
    return c.json({ success: true });
  });

  // GET /api/projects/:id/workspace-repo-status?include=merge,conflicts,handoff,diffstats
  // (#415) — one batched request over all non-closed, non-direct workspaces, replacing
  // the per-workspace {repo-merge-status, conflicts, handoff, diff} client fan-out.
  // Body is memoized ~10s server-side; unchanged content answers 304 via the ETag.
  router.get("/:id/workspace-repo-status", async (c) => {
    const projectId = c.req.param("id");
    const include = parseIncludeParam(c.req.query("include"));
    const body = await serveWorkspaceRepoStatusBatch(projectId, include, { database });
    return conditionalJsonResponse(body, c.req.header("if-none-match"));
  });

  // GET /api/projects/all/workspaces — cross-project workspace summary (all projects)
  router.get("/all/workspaces", async (c) => {
    const result = await projectService.getCrossProjectWorkspaces();
    return c.json(result);
  });

  // GET /api/projects/:id/board/summary — column counts only, no issue bodies
  router.get("/:id/board/summary", async (c) => {
    const projectId = c.req.param("id");
    const result = await projectService.getBoardSummary(projectId);
    return c.json(result);
  });

  // GET /api/projects/:id/board
  router.get("/:id/board", async (c) => {
    const projectId = c.req.param("id");
    const includeArchived = queryFlag(c, "includeArchived");
    const ifNoneMatch = c.req.header("if-none-match");
    const memoKey = `${projectId}|archived=${includeArchived}`;

    // Fast path: a conditional GET of an unchanged board answers 304 without
    // recomputing (the 30s client poll + post-event refetches mostly hit this).
    const fastPath = boardEtagCache.tryServe(memoKey, ifNoneMatch, workspaceSummaryCache.getGeneration(projectId));
    if (fastPath) return fastPath;

    // Full path: compute the board, hash the body, compare If-None-Match.
    // Capture the generation BEFORE the compute: if an invalidation lands mid-build,
    // the memoized generation is already stale and the next conditional GET takes the
    // full path instead of trusting a possibly pre-mutation body.
    const generation = workspaceSummaryCache.getGeneration(projectId);
    const result = await projectService.getBoard(projectId, undefined, { includeArchived });
    const body = JSON.stringify(result);
    const etag = computeBodyEtag(body);
    boardEtagCache.store(memoKey, etag, generation);
    if (ifNoneMatch === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json", ETag: etag },
    });
  });

  // GET /api/projects/:id/graph
  router.get("/:id/graph", async (c) => {
    const projectId = c.req.param("id");
    const result = await projectService.getGraph(projectId);
    // G15b: same conditional-GET treatment as the list endpoints (#400) — the
    // payload is large (measured >1MB pre-diet) and the graph view refetches on
    // board digests, so an unchanged graph answers 304 with no body (and no gzip).
    return conditionalJsonResponse(JSON.stringify(result), c.req.header("if-none-match"));
  });

  // GET /api/projects/:id/graph/search?q= — search-by-description WITHOUT shipping descriptions
  // (#370). Returns matching issue IDs only: a few KB whatever the board's size, and exact
  // matching, because the text never leaves the server. The client-side index this replaced
  // MEASURED 364,380 gzipped bytes on this board — larger than the payload the ticket exists to
  // shrink. An empty query returns nothing and the client does not call this at all.
  router.get("/:id/graph/search", async (c) => {
    const query = c.req.query("q") ?? "";
    const issueIds = await searchGraphIssueIds(c.req.param("id"), query, database);
    return conditionalJsonResponse(JSON.stringify({ issueIds }), c.req.header("if-none-match"));
  });

  // GET /api/projects/:id/activity — project-wide activity feed (latest N events across all issues)
  router.get("/:id/activity", async (c) => {
    const projectId = c.req.param("id");
    const limit = queryInt(c, "limit", { def: 100, min: 1, max: 200 });
    const result = await getProjectActivity(projectId, database, limit);
    return c.json(result);
  });

  // --- Onboarding plan (#463): the model/apply API behind the onboarding wizard for a
  // freshly imported project. Every step is derived from project/pref/issue state on read —
  // only explicit skips and a dismissal timestamp are persisted (`onboarding_state_<id>`).

  // GET /api/projects/:id/onboarding
  router.get("/:id/onboarding", async (c) => {
    const projectId = c.req.param("id");
    return c.json(await onboardingService.buildOnboardingPlan(projectId));
  });

  // POST /api/projects/:id/onboarding/apply { stepId, input? } — applies the step (config
  // write, plugin enable, or ticket filing) and returns the RECOMPUTED plan.
  router.post("/:id/onboarding/apply", async (c) => {
    const projectId = c.req.param("id");
    const body = await parseJsonBody<{ stepId?: string; input?: Record<string, unknown> }>(c);
    if (!body.stepId) return c.json({ error: "stepId is required" }, 400);
    const result = await onboardingService.applyOnboardingStep(projectId, body.stepId, body.input);
    options?.boardEvents?.broadcastProjectsChanged(projectId, "project_updated");
    return c.json(result);
  });

  // POST /api/projects/:id/onboarding/skip { stepId } — records an explicit skip; never
  // applied by an issue/plugin/config write.
  router.post("/:id/onboarding/skip", async (c) => {
    const projectId = c.req.param("id");
    const body = await parseJsonBody<{ stepId?: string }>(c);
    if (!body.stepId) return c.json({ error: "stepId is required" }, 400);
    return c.json(await onboardingService.skipOnboardingStep(projectId, body.stepId));
  });

  // POST /api/projects/:id/onboarding/dismiss — stamps the plan dismissed (e.g. "close the
  // wizard"); the plan itself stays queryable, just carries a dismissedAt.
  router.post("/:id/onboarding/dismiss", async (c) => {
    const projectId = c.req.param("id");
    await parseOptionalJsonBody(c);
    return c.json(await onboardingService.dismissOnboarding(projectId));
  });

  return router;
}
