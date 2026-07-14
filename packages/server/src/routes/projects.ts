import type { Database } from "../db/index.js";
import { createProjectService } from "../services/project.service.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { createRouter } from "../middleware/create-router.js";
import { wrapAiOperation } from "../middleware/ai-operation.js";
import { getProjectActivity } from "../services/project-activity.service.js";
import type { BoardEvents } from "../services/board-events.js";
import type { SessionManager } from "../services/session.manager.js";
import { createHash } from "node:crypto";
import { createWorkspaceSummaryCache } from "../services/workspace-summary-cache.service.js";
import { createBoardEtagCache } from "../services/board-etag-cache.service.js";
import { listProjectRepos, insertProjectRepo, deleteProjectRepo, type RepoRow } from "../repositories/repo.repository.js";
import { getProjectById, updateProjectServicesConfig } from "../repositories/project.repository.js";
import { detectRepoInfo } from "../services/git-info.service.js";
import { cloneRepo } from "../services/repo-clone.service.js";
import type { ProjectRepoResponse, ServiceStackConfig } from "@agentic-kanban/shared";
import { DEFAULT_SERVICE_STACK_CONFIG } from "@agentic-kanban/shared";

function toProjectRepoResponse(row: RepoRow): ProjectRepoResponse {
  return {
    id: row.id,
    projectId: row.projectId!,
    path: row.path,
    name: row.name,
    defaultBranch: row.defaultBranch,
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
  if (cfg.composeRepo !== undefined) normalized.composeRepo = cfg.composeRepo as string | null;
  if (cfg.readyTimeoutMs !== undefined) normalized.readyTimeoutMs = cfg.readyTimeoutMs as number;
  if (cfg.env !== undefined) normalized.env = cfg.env as Record<string, string>;
  return { ok: true, json: JSON.stringify(normalized) };
}

/** Parse a stored servicesConfig JSON string into a ServiceStackConfig for the wire DTO. */
function parseServicesConfig(raw: unknown): ServiceStackConfig | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as ServiceStackConfig;
  } catch {
    // stored value is corrupt — treat as none rather than crashing the board list
  }
  return null;
}

export function createProjectsRoute(database: Database, options?: { boardEvents?: BoardEvents; getSessionManager?: () => SessionManager }) {
  const router = createRouter();

  const workspaceSummaryCache = createWorkspaceSummaryCache();
  const projectService = createProjectService({ database, workspaceSummaryCache });
  // The fast path is only sound when boardEvents is wired: without the invalidation
  // listener below, mutations would never bump the cache generation and the memo
  // could serve a wrong 304. Disabled (never permissive) when boardEvents is absent.
  const boardEtagCache = createBoardEtagCache({ enabled: Boolean(options?.boardEvents) });
  if (options?.boardEvents) {
    options.boardEvents.addInvalidationListener((projectId) => {
      workspaceSummaryCache.invalidate(projectId);
      // Warm-ahead: start the board rebuild now (debounced to collapse event bursts)
      // so the client's WS-triggered refetch ~100-300ms later hits a warm or in-flight
      // cache instead of paying the full cold rebuild (measured 121-205ms per refetch).
      projectService.scheduleBoardWarmup(projectId);
    });
  }

  // GET /api/projects  (?includeArchived=true to include archived projects)
  router.get("/", async (c) => {
    const includeArchived = c.req.query("includeArchived") === "true";
    const result = await projectService.listProjects({ includeArchived });
    // Map the stored servicesConfig JSON string into the parsed wire shape (ProjectResponse).
    const withServices = result.map((p) => ({
      ...p,
      servicesConfig: parseServicesConfig((p as { servicesConfig?: unknown }).servicesConfig),
    }));
    return c.json(withServices);
  });

  // POST /api/projects
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

  // POST /api/projects/:id/repos — add an additional repo (local path or clone URL)
  router.post("/:id/repos", async (c) => {
    const projectId = c.req.param("id");
    const body = await parseJsonBody<{ path?: string; cloneUrl?: string; name?: string }>(c);
    if (!body.path === !body.cloneUrl) {
      return c.json({ error: "Provide exactly one of path or cloneUrl" }, 400);
    }
    const project = await getProjectById(projectId, database);
    if (!project) return c.json({ error: "Project not found" }, 404);

    let localPath = body.path;
    if (body.cloneUrl) {
      try {
        localPath = await cloneRepo(body.cloneUrl, { name: body.name });
      } catch (err) {
        return c.json({ error: `Clone failed: ${err instanceof Error ? err.message : String(err)}` }, 400);
      }
    }
    let repoInfo;
    try {
      repoInfo = await detectRepoInfo(localPath!);
    } catch (err) {
      return c.json({ error: `Invalid repo: ${err instanceof Error ? err.message : String(err)}` }, 400);
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
    }, database);
    options?.boardEvents?.broadcastProjectsChanged(projectId, "project_updated");
    return c.json(toProjectRepoResponse(row), 201);
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
    const includeArchived = c.req.query("includeArchived") === "true";
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
    const etag = `"${createHash("sha1").update(body).digest("hex").slice(0, 16)}"`;
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
    return c.json(result);
  });

  // GET /api/projects/:id/activity — project-wide activity feed (latest N events across all issues)
  router.get("/:id/activity", async (c) => {
    const projectId = c.req.param("id");
    const rawLimit = c.req.query("limit");
    const parsed = Number.parseInt(rawLimit ?? "", 10);
    const limit = Number.isFinite(parsed) ? Math.min(200, Math.max(1, parsed)) : 100;
    const result = await getProjectActivity(projectId, database, limit);
    return c.json(result);
  });

  return router;
}
