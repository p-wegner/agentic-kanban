import { Hono } from "hono";
import type { Database } from "../../db/index.js";
import { generateSetupScript, generateTeardownScript } from "../../services/project-setup.service.js";

export function createScriptRoutes(database: Database) {
  const router = new Hono();

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

  return router;
}
