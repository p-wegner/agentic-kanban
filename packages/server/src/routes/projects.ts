import { Hono } from "hono";
import type { Database } from "../db/index.js";
import { ProjectError, createProjectService } from "../services/project.service.js";

export function createProjectsRoute(database: Database) {
  const router = new Hono();

  const projectService = createProjectService({ database });

  // GET /api/projects
  router.get("/", async (c) => {
    const result = await projectService.listProjects();
    return c.json(result);
  });

  // POST /api/projects
  router.post("/", async (c) => {
    const body = await c.req.json();
    try {
      const result = await projectService.registerProject(body);
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof ProjectError) {
        const code = err.code === "CONFLICT" ? 409 : 400;
        return c.json({ error: err.message }, code);
      }
      throw err;
    }
  });

  // POST /api/projects/create — create a new directory as a git repo and register it
  router.post("/create", async (c) => {
    const body = await c.req.json();
    try {
      const result = await projectService.createProject(body);
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof ProjectError) {
        const code = err.code === "CONFLICT" ? 409 : 400;
        return c.json({ error: err.message }, code);
      }
      throw err;
    }
  });

  // PATCH /api/projects/:id — update project fields
  router.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    try {
      const result = await projectService.updateProject(id, body);
      return c.json(result);
    } catch (err) {
      if (err instanceof ProjectError) {
        const code = err.code === "NOT_FOUND" ? 404 : 400;
        return c.json({ error: err.message }, code);
      }
      throw err;
    }
  });

  // DELETE /api/projects/:id — unregister a project (cascade deletes all associated data)
  router.delete("/:id", async (c) => {
    const projectId = c.req.param("id");
    try {
      await projectService.deleteProject(projectId);
      return c.json({ success: true });
    } catch (err) {
      if (err instanceof ProjectError) {
        return c.json({ error: err.message }, 404);
      }
      throw err;
    }
  });

  // POST /api/projects/generate-setup-script
  router.post("/generate-setup-script", async (c) => {
    let body: { projectId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (!body.projectId) return c.json({ error: "projectId is required" }, 400);

    try {
      const setupScript = await projectService.generateSetupScript(body.projectId);
      return c.json({ setupScript });
    } catch (err: any) {
      if (err instanceof ProjectError) return c.json({ error: err.message }, 404);
      const parts: string[] = [];
      if (err.message) parts.push(err.message);
      if (err.stderr) parts.push(String(err.stderr).trim());
      const msg = parts.length > 0 ? parts.join(" | ") : "claude CLI failed";
      console.error("[generate-setup-script] claude error:", msg);
      return c.json({ error: "AI generation failed", detail: msg }, 500);
    }
  });

  // POST /api/projects/generate-teardown-script
  router.post("/generate-teardown-script", async (c) => {
    let body: { projectId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (!body.projectId) return c.json({ error: "projectId is required" }, 400);

    try {
      const teardownScript = await projectService.generateTeardownScript(body.projectId);
      return c.json({ teardownScript });
    } catch (err: any) {
      if (err instanceof ProjectError) return c.json({ error: err.message }, 404);
      const parts: string[] = [];
      if (err.message) parts.push(err.message);
      if (err.stderr) parts.push(String(err.stderr).trim());
      const msg = parts.length > 0 ? parts.join(" | ") : "claude CLI failed";
      console.error("[generate-teardown-script] claude error:", msg);
      return c.json({ error: "AI generation failed", detail: msg }, 500);
    }
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
    const body = await c.req.json();
    const result = await projectService.addStatus(projectId, body.name, body.sortOrder ?? 0);
    return c.json(result, 201);
  });

  // DELETE /api/projects/:id/statuses/:statusId
  router.delete("/:id/statuses/:statusId", async (c) => {
    const projectId = c.req.param("id");
    const statusId = c.req.param("statusId");
    try {
      const result = await projectService.removeStatus(projectId, statusId);
      return c.json(result);
    } catch (err) {
      if (err instanceof ProjectError) {
        return c.json({ error: err.message }, err.code === "NOT_FOUND" ? 404 : 409);
      }
      throw err;
    }
  });

  // GET /api/projects/:id/branches
  router.get("/:id/branches", async (c) => {
    const projectId = c.req.param("id");
    try {
      const branches = await projectService.getBranches(projectId);
      return c.json(branches);
    } catch (err) {
      if (err instanceof ProjectError) return c.json({ error: err.message }, 404);
      return c.json(
        { error: `Failed to list branches: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }
  });

  // GET /api/projects/:id/stats — lightweight project stats
  router.get("/:id/stats", async (c) => {
    const projectId = c.req.param("id");
    try {
      const result = await projectService.getStats(projectId);
      return c.json(result);
    } catch (err) {
      if (err instanceof ProjectError) {
        return c.json({ error: err.message }, 404);
      }
      throw err;
    }
  });

  // GET /api/projects/:id/worktrees
  router.get("/:id/worktrees", async (c) => {
    const projectId = c.req.param("id");
    try {
      const result = await projectService.getWorktrees(projectId);
      return c.json(result);
    } catch (err) {
      if (err instanceof ProjectError) {
        const code = err.code === "NOT_FOUND" ? 404 : 500;
        return c.json({ error: err.message }, code);
      }
      return c.json({ error: `Failed to list worktrees: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // DELETE /api/projects/:id/worktrees
  router.delete("/:id/worktrees", async (c) => {
    const projectId = c.req.param("id");
    const body = await c.req.json<{ path?: string; workspaceId?: string }>();
    if (!body.path && !body.workspaceId) return c.json({ error: "path or workspaceId is required" }, 400);

    try {
      await projectService.removeWorktreeById(projectId, body);
      return c.json({ success: true });
    } catch (err) {
      if (err instanceof ProjectError) {
        const code = err.code === "NOT_FOUND" ? 404 : 400;
        return c.json({ error: err.message }, code);
      }
      throw err;
    }
  });

  // POST /api/projects/:id/worktrees/open — open a worktree folder in the OS file explorer
  router.post("/:id/worktrees/open", async (c) => {
    const body = await c.req.json<{ path: string }>();
    if (!body.path) return c.json({ error: "path is required" }, 400);

    projectService.openInExplorer(body.path);
    return c.json({ success: true });
  });

  // GET /api/projects/all/workspaces — cross-project workspace summary (all projects)
  router.get("/all/workspaces", async (c) => {
    const result = await projectService.getCrossProjectWorkspaces();
    return c.json(result);
  });

  // GET /api/projects/:id/board
  router.get("/:id/board", async (c) => {
    const projectId = c.req.param("id");
    try {
      const result = await projectService.getBoard(projectId);
      return c.json(result);
    } catch (err) {
      if (err instanceof ProjectError) {
        return c.json({ error: err.message }, 404);
      }
      throw err;
    }
  });

  // GET /api/projects/:id/graph
  router.get("/:id/graph", async (c) => {
    const projectId = c.req.param("id");
    try {
      const result = await projectService.getGraph(projectId);
      return c.json(result);
    } catch (err) {
      if (err instanceof ProjectError) {
        return c.json({ error: err.message }, 404);
      }
      throw err;
    }
  });

  return router;
}
