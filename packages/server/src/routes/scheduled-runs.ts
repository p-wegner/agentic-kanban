import { Hono } from "hono";
import { db } from "../db/index.js";
import { scheduledRuns, issues, projectStatuses, agentSkills } from "@agentic-kanban/shared/schema";
import { eq, and, max } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Database } from "../db/index.js";

export function createScheduledRunsRoute(database: Database = db, serverPort?: number) {
  const router = new Hono();

  // GET /api/scheduled-runs?projectId=
  router.get("/", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId is required" }, 400);

    const rows = await database
      .select()
      .from(scheduledRuns)
      .where(eq(scheduledRuns.projectId, projectId));

    return c.json(rows);
  });

  // POST /api/scheduled-runs — create
  router.post("/", async (c) => {
    const body = await c.req.json();
    if (!body.name || !body.projectId) {
      return c.json({ error: "name and projectId are required" }, 400);
    }

    const now = new Date().toISOString();
    const id = randomUUID();

    // Auto-create a system issue for this scheduled run
    let systemIssueId: string | null = null;
    try {
      const statuses = await database
        .select()
        .from(projectStatuses)
        .where(eq(projectStatuses.projectId, body.projectId));
      const todoStatus = statuses.find(s => s.name === "Todo") ?? statuses[0];
      if (todoStatus) {
        const issueId = randomUUID();
        // Get next issue number
        const numRows = await database
          .select({ maxNum: max(issues.issueNumber) })
          .from(issues)
          .where(eq(issues.projectId, body.projectId));
        const nextNum = (numRows[0]?.maxNum ?? 0) + 1;

        await database.insert(issues).values({
          id: issueId,
          issueNumber: nextNum,
          title: `⏰ ${body.name}`,
          description: `System issue for scheduled run: ${body.name}`,
          priority: "low",
          statusId: todoStatus.id,
          projectId: body.projectId,
          skipAutoReview: true,
          createdAt: now,
          updatedAt: now,
        });
        systemIssueId = issueId;
      }
    } catch (err) {
      console.warn("[scheduled-runs] Failed to create system issue:", err);
    }

    await database.insert(scheduledRuns).values({
      id,
      name: body.name,
      description: body.description ?? null,
      projectId: body.projectId,
      prompt: body.prompt ?? null,
      skillId: body.skillId ?? null,
      intervalMinutes: body.intervalMinutes ?? 60,
      enabled: body.enabled !== false,
      systemIssueId,
      createdAt: now,
      updatedAt: now,
    });

    const [created] = await database
      .select()
      .from(scheduledRuns)
      .where(eq(scheduledRuns.id, id));

    return c.json(created, 201);
  });

  // PUT /api/scheduled-runs/:id — update
  router.put("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const now = new Date().toISOString();

    const existing = await database
      .select()
      .from(scheduledRuns)
      .where(eq(scheduledRuns.id, id))
      .limit(1);

    if (existing.length === 0) return c.json({ error: "Not found" }, 404);

    await database.update(scheduledRuns).set({
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.prompt !== undefined && { prompt: body.prompt }),
      ...(body.skillId !== undefined && { skillId: body.skillId }),
      ...(body.intervalMinutes !== undefined && { intervalMinutes: body.intervalMinutes }),
      ...(body.enabled !== undefined && { enabled: body.enabled }),
      updatedAt: now,
    }).where(eq(scheduledRuns.id, id));

    const [updated] = await database
      .select()
      .from(scheduledRuns)
      .where(eq(scheduledRuns.id, id));

    return c.json(updated);
  });

  // DELETE /api/scheduled-runs/:id
  router.delete("/:id", async (c) => {
    const id = c.req.param("id");

    const existing = await database
      .select()
      .from(scheduledRuns)
      .where(eq(scheduledRuns.id, id))
      .limit(1);

    if (existing.length === 0) return c.json({ error: "Not found" }, 404);

    await database.delete(scheduledRuns).where(eq(scheduledRuns.id, id));
    return c.json({ ok: true });
  });

  // POST /api/scheduled-runs/:id/run — manual or scheduled trigger
  router.post("/:id/run", async (c) => {
    const id = c.req.param("id");

    const rows = await database
      .select()
      .from(scheduledRuns)
      .where(eq(scheduledRuns.id, id))
      .limit(1);

    if (rows.length === 0) return c.json({ error: "Not found" }, 404);

    const run = rows[0];
    const port = serverPort ?? Number(process.env.PORT) ?? 3001;

    try {
      // Resolve effective prompt (skill overrides custom prompt)
      let effectivePrompt = run.prompt ?? "";
      if (run.skillId) {
        const skillRows = await database
          .select({ prompt: agentSkills.prompt, name: agentSkills.name })
          .from(agentSkills)
          .where(eq(agentSkills.id, run.skillId))
          .limit(1);
        if (skillRows.length > 0) {
          effectivePrompt = `/${skillRows[0].name}\n\n${skillRows[0].prompt}`;
        }
      }

      if (!effectivePrompt) {
        return c.json({ error: "No prompt or skill configured for this scheduled run" }, 400);
      }

      // Ensure system issue exists
      let systemIssueId = run.systemIssueId;
      if (!systemIssueId) {
        try {
          const statuses = await database
            .select()
            .from(projectStatuses)
            .where(eq(projectStatuses.projectId, run.projectId));
          const todoStatus = statuses.find(s => s.name === "Todo") ?? statuses[0];
          if (todoStatus) {
            const issueId = randomUUID();
            const numRows = await database
              .select({ maxNum: max(issues.issueNumber) })
              .from(issues)
              .where(eq(issues.projectId, run.projectId));
            const nextNum = (numRows[0]?.maxNum ?? 0) + 1;
            await database.insert(issues).values({
              id: issueId,
              issueNumber: nextNum,
              title: `⏰ ${run.name}`,
              description: `System issue for scheduled run: ${run.name}`,
              priority: "low",
              statusId: todoStatus.id,
              projectId: run.projectId,
              skipAutoReview: true,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
            systemIssueId = issueId;
            await database.update(scheduledRuns).set({ systemIssueId }).where(eq(scheduledRuns.id, id));
          }
        } catch (err) {
          console.warn("[scheduled-runs] Failed to create system issue on run:", err);
        }
      }

      if (!systemIssueId) {
        return c.json({ error: "Could not create system issue for this scheduled run" }, 500);
      }

      // Create a direct workspace with the custom prompt
      const wsRes = await fetch(`http://localhost:${port}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueId: systemIssueId, isDirect: true, customPrompt: effectivePrompt, skipSetup: true }),
      });

      const wsBody = await wsRes.json() as { id?: string; error?: string };
      if (!wsRes.ok) {
        throw new Error(wsBody.error ?? `workspace creation failed: ${wsRes.status}`);
      }

      const now = new Date().toISOString();
      await database.update(scheduledRuns).set({
        lastRunAt: now,
        lastRunStatus: "running",
        lastRunWorkspaceId: wsBody.id ?? null,
        updatedAt: now,
      }).where(eq(scheduledRuns.id, id));

      return c.json({ ok: true, workspaceId: wsBody.id });
    } catch (err) {
      const now = new Date().toISOString();
      await database.update(scheduledRuns).set({
        lastRunAt: now,
        lastRunStatus: "error",
        updatedAt: now,
      }).where(eq(scheduledRuns.id, id));

      console.error("[scheduled-runs] run failed:", err);
      return c.json({ error: String(err) }, 500);
    }
  });

  return router;
}
