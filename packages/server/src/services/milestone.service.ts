import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { and, eq, isNotNull } from "drizzle-orm";
import { issues, projectStatuses } from "@agentic-kanban/shared/schema";
import {
  listMilestonesByProject,
  getMilestoneById,
  createMilestone,
  updateMilestone,
  deleteMilestone,
} from "../repositories/milestone.repository.js";

export class MilestoneError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "BAD_REQUEST" | "FORBIDDEN",
  ) {
    super(message);
  }
}

type MilestoneSummary = Awaited<ReturnType<typeof listMilestonesByProject>>[number] & {
  totalIssues: number;
  openIssues: number;
  closedIssues: number;
  progressPercent: number;
  burndown: Array<{
    date: string;
    remaining: number;
    opened: number;
    closed: number;
  }>;
};

export function createMilestoneService({ database }: { database: Database }) {
  async function list(projectId: string) {
    return listMilestonesByProject(projectId, database);
  }

  async function summary(projectId: string, days = 30): Promise<MilestoneSummary[]> {
    const normalizedDays = Math.min(Math.max(Number.isFinite(days) ? Math.floor(days) : 30, 1), 365);
    const milestoneRows = await listMilestonesByProject(projectId, database);
    if (milestoneRows.length === 0) return [];

    const issueRows = await database
      .select({
        milestoneId: issues.milestoneId,
        createdAt: issues.createdAt,
        statusChangedAt: issues.statusChangedAt,
        statusName: projectStatuses.name,
      })
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(and(eq(issues.projectId, projectId), isNotNull(issues.milestoneId)));

    const terminalStatuses = new Set(["Done", "Cancelled"]);
    const today = new Date();
    const cutoffDate = new Date(today);
    cutoffDate.setDate(cutoffDate.getDate() - normalizedDays + 1);

    const dates: string[] = [];
    for (let d = new Date(cutoffDate); d <= today; d.setDate(d.getDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }

    const issuesByMilestone = new Map<string, Array<{
      createdDay: string;
      closedDay: string | null;
    }>>();

    for (const row of issueRows) {
      if (!row.milestoneId) continue;
      const createdDay = row.createdAt.slice(0, 10);
      const closedDay = terminalStatuses.has(row.statusName)
        ? (row.statusChangedAt ? row.statusChangedAt.slice(0, 10) : createdDay)
        : null;
      const bucket = issuesByMilestone.get(row.milestoneId) ?? [];
      bucket.push({ createdDay, closedDay });
      issuesByMilestone.set(row.milestoneId, bucket);
    }

    return milestoneRows.map((milestone) => {
      const milestoneIssues = issuesByMilestone.get(milestone.id) ?? [];
      const closedIssues = milestoneIssues.filter((issue) => issue.closedDay !== null).length;
      const openIssues = milestoneIssues.length - closedIssues;
      const progressPercent = milestoneIssues.length === 0
        ? 0
        : Math.round((closedIssues / milestoneIssues.length) * 100);
      const burndown = dates.map((date) => {
        let remaining = 0;
        let opened = 0;
        let closed = 0;
        for (const issue of milestoneIssues) {
          if (issue.createdDay <= date) {
            if (issue.closedDay === null || issue.closedDay > date) remaining++;
            if (issue.createdDay === date) opened++;
          }
          if (issue.closedDay === date) closed++;
        }
        return { date, remaining, opened, closed };
      });

      return {
        ...milestone,
        totalIssues: milestoneIssues.length,
        openIssues,
        closedIssues,
        progressPercent,
        burndown,
      };
    });
  }

  async function create(projectId: string, data: { name: string; dueDate?: string | null }) {
    if (!data.name?.trim()) {
      throw new MilestoneError("name is required", "BAD_REQUEST");
    }
    return createMilestone({ projectId, name: data.name.trim(), dueDate: data.dueDate ?? null }, database);
  }

  async function update(projectId: string, id: string, updates: { name?: string; dueDate?: string | null }) {
    const existing = await getMilestoneById(id, database);
    if (!existing) throw new MilestoneError("Milestone not found", "NOT_FOUND");
    if (existing.projectId !== projectId) {
      throw new MilestoneError("Milestone does not belong to this project", "FORBIDDEN");
    }
    if (updates.name !== undefined && !updates.name.trim()) {
      throw new MilestoneError("name cannot be empty", "BAD_REQUEST");
    }
    await updateMilestone(id, updates, database);
    return { id };
  }

  async function remove(projectId: string, id: string) {
    const existing = await getMilestoneById(id, database);
    if (!existing) throw new MilestoneError("Milestone not found", "NOT_FOUND");
    if (existing.projectId !== projectId) {
      throw new MilestoneError("Milestone does not belong to this project", "FORBIDDEN");
    }
    await deleteMilestone(id, database);
  }

  return { list, summary, create, update, remove };
}

export const milestoneService = createMilestoneService({ database: db });
