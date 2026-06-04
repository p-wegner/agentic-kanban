import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
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

export function createMilestoneService({ database }: { database: Database }) {
  async function list(projectId: string) {
    return listMilestonesByProject(projectId, database);
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

  return { list, create, update, remove };
}

export const milestoneService = createMilestoneService({ database: db });
