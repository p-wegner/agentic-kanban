import { issues, projectStatuses, agentSkills } from "@agentic-kanban/shared/schema";
import { eq, max } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Database } from "../db/index.js";
import { validateCronExpression } from "@agentic-kanban/shared/lib/cron-utils";
import {
  getScheduledRunsByProject,
  getScheduledRunById,
  createScheduledRun,
  updateScheduledRun,
  deleteScheduledRun,
} from "../repositories/scheduled-run.repository.js";

export class ScheduledRunError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "BAD_REQUEST",
  ) {
    super(message);
  }
}

export function createScheduledRunService(deps: { database: Database; serverPort?: number }) {
  const { database, serverPort } = deps;

  async function list(projectId: string) {
    return getScheduledRunsByProject(projectId, database);
  }

  async function create(body: {
    name: string;
    projectId: string;
    description?: string;
    prompt?: string;
    skillId?: string;
    intervalMinutes?: number;
    cronExpression?: string;
    enabled?: boolean;
  }) {
    if (!body.name || !body.projectId) {
      throw new ScheduledRunError("name and projectId are required", "BAD_REQUEST");
    }

    if (body.cronExpression) {
      const validation = validateCronExpression(body.cronExpression);
      if (!validation.valid) {
        throw new ScheduledRunError(`Invalid cron expression: ${validation.error}`, "BAD_REQUEST");
      }
    }

    const systemIssueId = await createSystemIssue(body.projectId, body.name);
    const id = randomUUID();

    return createScheduledRun({
      id,
      name: body.name,
      description: body.description ?? null,
      projectId: body.projectId,
      prompt: body.prompt ?? null,
      skillId: body.skillId ?? null,
      intervalMinutes: body.intervalMinutes ?? 60,
      cronExpression: body.cronExpression ?? null,
      enabled: body.enabled !== false,
      systemIssueId,
    }, database);
  }

  async function update(id: string, body: Record<string, unknown>) {
    const existing = await getScheduledRunById(id, database);
    if (!existing) throw new ScheduledRunError("Not found", "NOT_FOUND");

    if (body.cronExpression) {
      const validation = validateCronExpression(body.cronExpression as string);
      if (!validation.valid) {
        throw new ScheduledRunError(`Invalid cron expression: ${validation.error}`, "BAD_REQUEST");
      }
    }

    const now = new Date().toISOString();
    const updates: Record<string, unknown> = { updatedAt: now };
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.prompt !== undefined) updates.prompt = body.prompt;
    if (body.skillId !== undefined) updates.skillId = body.skillId;
    if (body.intervalMinutes !== undefined) updates.intervalMinutes = body.intervalMinutes;
    if (body.cronExpression !== undefined) updates.cronExpression = body.cronExpression || null;
    if (body.enabled !== undefined) updates.enabled = body.enabled;

    return updateScheduledRun(id, updates, database);
  }

  async function remove(id: string) {
    const existing = await getScheduledRunById(id, database);
    if (!existing) throw new ScheduledRunError("Not found", "NOT_FOUND");
    await deleteScheduledRun(id, database);
  }

  async function run(id: string) {
    const run = await getScheduledRunById(id, database);
    if (!run) throw new ScheduledRunError("Not found", "NOT_FOUND");

    const port = serverPort ?? Number(process.env.PORT) ?? 3001;

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
      throw new ScheduledRunError("No prompt or skill configured for this scheduled run", "BAD_REQUEST");
    }

    // Ensure system issue exists
    let systemIssueId = run.systemIssueId;
    if (!systemIssueId) {
      systemIssueId = await createSystemIssue(run.projectId, run.name);
      if (systemIssueId) {
        await updateScheduledRun(id, { systemIssueId }, database);
      }
    }

    if (!systemIssueId) {
      throw new ScheduledRunError("Could not create system issue for this scheduled run", "BAD_REQUEST");
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
    await updateScheduledRun(id, {
      lastRunAt: now,
      lastRunStatus: "running",
      lastRunWorkspaceId: wsBody.id ?? null,
      updatedAt: now,
    }, database);

    return { workspaceId: wsBody.id };
  }

  async function createSystemIssue(projectId: string, name: string): Promise<string | null> {
    try {
      const statuses = await database
        .select()
        .from(projectStatuses)
        .where(eq(projectStatuses.projectId, projectId));
      const todoStatus = statuses.find(s => s.name === "Todo") ?? statuses[0];
      if (!todoStatus) return null;

      const issueId = randomUUID();
      const numRows = await database
        .select({ maxNum: max(issues.issueNumber) })
        .from(issues)
        .where(eq(issues.projectId, projectId));
      const nextNum = (numRows[0]?.maxNum ?? 0) + 1;

      const now = new Date().toISOString();
      await database.insert(issues).values({
        id: issueId,
        issueNumber: nextNum,
        title: `⏰ ${name}`,
        description: `System issue for scheduled run: ${name}`,
        priority: "low",
        statusId: todoStatus.id,
        projectId,
        skipAutoReview: true,
        createdAt: now,
        updatedAt: now,
      });
      return issueId;
    } catch (err) {
      console.warn("[scheduled-runs] Failed to create system issue:", err);
      return null;
    }
  }

  return { list, create, update, remove, run };
}
