import { Hono } from "hono";
import { spawn, spawnSync } from "node:child_process";
import type { Database } from "../../db/index.js";
import { getWorkspaceById } from "../../repositories/workspace.repository.js";

export function createEditorRoutes(database: Database) {
  const router = new Hono();

  // POST /api/workspaces/:id/open-editor — open the workspace directory in VS Code
  router.post("/:id/open-editor", async (c) => {
    const id = c.req.param("id");

    const wsEditor = await getWorkspaceById(id, database);
    if (!wsEditor) return c.json({ error: "Workspace not found" }, 404);

    const { workingDir } = wsEditor;
    if (!workingDir) return c.json({ error: "Workspace has no working directory" }, 422);

    const which = spawnSync("code", ["--version"], { shell: true, windowsHide: true });
    if (which.status !== 0) {
      return c.json({ error: "VS Code (code) is not installed or not in PATH" }, 422);
    }

    spawn("code", [workingDir], { shell: true, windowsHide: true, detached: true }).unref();

    return c.json({ ok: true });
  });

  return router;
}
