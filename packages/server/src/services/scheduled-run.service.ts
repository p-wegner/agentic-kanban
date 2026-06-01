import { issues, projectStatuses, agentSkills, projects, workspaces } from "@agentic-kanban/shared/schema";
import { eq, max } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Database } from "../db/index.js";
import { getNextCronRun, validateCronExpression } from "@agentic-kanban/shared/lib/cron-utils";
import {
  getScheduledRunsByProject,
  getScheduledRunById,
  createScheduledRun,
  updateScheduledRun,
  deleteScheduledRun,
  createScheduledRunHistory,
  getScheduledRunHistoryByProject,
  updateScheduledRunHistory,
} from "../repositories/scheduled-run.repository.js";
import type { CreateWorkspaceInput, CreateWorkspaceResult } from "./workspace-internals.js";

export class ScheduledRunError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "BAD_REQUEST",
  ) {
    super(message);
  }
}

export function createScheduledRunService(deps: {
  database: Database;
  createWorkspace: (input: CreateWorkspaceInput) => Promise<CreateWorkspaceResult>;
}) {
  const { database, createWorkspace } = deps;

  async function list(projectId: string) {
    const runs = await getScheduledRunsByProject(projectId, database);
    const history = await getScheduledRunHistoryByProject(projectId, 100, database);
    const historyByRun = new Map<string, typeof history>();
    for (const row of history) {
      const rows = historyByRun.get(row.scheduledRunId) ?? [];
      rows.push(row);
      historyByRun.set(row.scheduledRunId, rows);
    }

    return Promise.all(runs.map(async (run) => {
      const runHistory = historyByRun.get(run.id) ?? [];
      const [issue] = run.systemIssueId
        ? await database
          .select({ id: issues.id, issueNumber: issues.issueNumber, title: issues.title })
          .from(issues)
          .where(eq(issues.id, run.systemIssueId))
          .limit(1)
        : [];
      const [workspace] = run.lastRunWorkspaceId
        ? await database
          .select({ id: workspaces.id, branch: workspaces.branch, status: workspaces.status })
          .from(workspaces)
          .where(eq(workspaces.id, run.lastRunWorkspaceId))
          .limit(1)
        : [];
      return {
        ...run,
        nextFireAt: computeNextFireAt(run),
        systemIssue: issue ?? null,
        lastRunWorkspace: workspace ?? null,
        latestHistory: runHistory[0] ?? null,
        history: runHistory.slice(0, 5),
      };
    }));
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

  async function run(id: string, triggeredBy = "manual") {
    const run = await getScheduledRunById(id, database);
    if (!run) throw new ScheduledRunError("Not found", "NOT_FOUND");
    const startedAt = new Date().toISOString();
    let historyId: string | null = null;

    async function fail(message: string, code: ScheduledRunError["code"] = "BAD_REQUEST"): Promise<never> {
      await recordRunFailure(run.id, run.projectId, run.systemIssueId, null, triggeredBy, startedAt, message);
      await updateScheduledRun(run.id, {
        lastRunAt: startedAt,
        lastRunStatus: "error",
        lastRunWorkspaceId: null,
        updatedAt: startedAt,
      }, database);
      throw new ScheduledRunError(message, code);
    }

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
      return fail("No prompt or skill configured for this scheduled run");
    }

    const projectRows = await database.select({ id: projects.id }).from(projects).where(eq(projects.id, run.projectId)).limit(1);
    if (projectRows.length === 0) {
      return fail("Project not found or disabled", "NOT_FOUND");
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
      return fail("Could not create system issue for this scheduled run");
    }

    const issueRows = await database.select({ id: issues.id }).from(issues).where(eq(issues.id, systemIssueId)).limit(1);
    if (issueRows.length === 0) {
      const completedAt = new Date().toISOString();
      await recordRunFailure(run.id, run.projectId, null, null, triggeredBy, startedAt, "Missing system issue for this scheduled run");
      await updateScheduledRun(run.id, {
        lastRunAt: completedAt,
        lastRunStatus: "error",
        lastRunWorkspaceId: null,
        updatedAt: completedAt,
      }, database);
      throw new ScheduledRunError("Missing system issue for this scheduled run", "BAD_REQUEST");
    }

    try {
      const initialHistory = await createScheduledRunHistory({
        id: randomUUID(),
        scheduledRunId: run.id,
        projectId: run.projectId,
        status: "running",
        reason: null,
        triggeredBy,
        issueId: systemIssueId,
        workspaceId: null,
        startedAt,
        completedAt: null,
      }, database);
      historyId = initialHistory?.id ?? null;

      // Create a direct workspace with the custom prompt
      const workspace = await createWorkspace({
        issueId: systemIssueId,
        isDirect: true,
        customPrompt: effectivePrompt,
        skipSetup: true,
      });

      const now = new Date().toISOString();
      if (historyId) {
        await updateScheduledRunHistory(historyId, { workspaceId: workspace.id }, database);
      }
      await updateScheduledRun(id, {
        lastRunAt: now,
        lastRunStatus: "running",
        lastRunWorkspaceId: workspace.id,
        updatedAt: now,
      }, database);

      return { workspaceId: workspace.id };
    } catch (err) {
      const reason = classifyLaunchFailure(err);
      const completedAt = new Date().toISOString();
      if (historyId) {
        await updateScheduledRunHistory(historyId, {
          status: "error",
          reason,
          completedAt,
        }, database);
      } else {
        await recordRunFailure(run.id, run.projectId, systemIssueId, null, triggeredBy, startedAt, reason);
      }
      await updateScheduledRun(id, {
        lastRunAt: completedAt,
        lastRunStatus: "error",
        lastRunWorkspaceId: null,
        updatedAt: completedAt,
      }, database);
      throw err;
    }
  }

  function computeNextFireAt(run: Awaited<ReturnType<typeof getScheduledRunById>>): string | null {
    if (!run?.enabled) return null;
    if (run.cronExpression) {
      const base = run.lastRunAt ? new Date(run.lastRunAt) : new Date();
      return getNextCronRun(run.cronExpression, base)?.toISOString() ?? null;
    }
    if (!run.lastRunAt) return new Date().toISOString();
    return new Date(new Date(run.lastRunAt).getTime() + run.intervalMinutes * 60 * 1000).toISOString();
  }

  async function recordRunFailure(
    scheduledRunId: string,
    projectId: string,
    issueId: string | null,
    workspaceId: string | null,
    triggeredBy: string,
    startedAt: string,
    reason: string,
  ) {
    const completedAt = new Date().toISOString();
    await createScheduledRunHistory({
      id: randomUUID(),
      scheduledRunId,
      projectId,
      status: "error",
      reason,
      triggeredBy,
      issueId,
      workspaceId,
      startedAt,
      completedAt,
    }, database);
  }

  function classifyLaunchFailure(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    const lower = raw.toLowerCase();
    if (lower.includes("wip")) return `WIP limit: ${raw}`;
    if (lower.includes("issue") && lower.includes("not found")) return `Missing issue: ${raw}`;
    if (lower.includes("project") && (lower.includes("disabled") || lower.includes("not found"))) return `Disabled project: ${raw}`;
    return `Launch error: ${raw}`;
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
