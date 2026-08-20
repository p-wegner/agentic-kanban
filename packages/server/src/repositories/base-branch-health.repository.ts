import { randomUUID } from "node:crypto";
import { baseBranchHealth } from "@agentic-kanban/shared/schema";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export type BaseBranchHealthOutcome = "green" | "red" | "timeout" | "unverified";

export interface RecordBaseBranchHealthInput {
  projectId: string;
  sha: string;
  branch: string;
  outcome: BaseBranchHealthOutcome;
  durationMs?: number;
  message?: string;
}

/** Record one verify attempt against a project's base branch at a given sha. Returns the row id. */
export async function recordBaseBranchHealth(
  input: RecordBaseBranchHealthInput,
  database: Database = db,
): Promise<string> {
  const id = randomUUID();
  await database.insert(baseBranchHealth).values({
    id,
    projectId: input.projectId,
    sha: input.sha,
    branch: input.branch,
    outcome: input.outcome,
    durationMs: input.durationMs ?? null,
    message: input.message ?? null,
    createdAt: new Date().toISOString(),
  });
  return id;
}

/** The newest recorded base-branch health result for a project, or null when none was ever recorded. */
export async function getLatestBaseBranchHealth(
  projectId: string,
  database: Database = db,
) {
  const rows = await database
    .select()
    .from(baseBranchHealth)
    .where(eq(baseBranchHealth.projectId, projectId))
    .orderBy(desc(baseBranchHealth.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** The newest recorded result for a project at a SPECIFIC sha, or null when that sha was never verified. */
export async function getBaseBranchHealthForSha(
  projectId: string,
  sha: string,
  database: Database = db,
) {
  const rows = await database
    .select()
    .from(baseBranchHealth)
    .where(eq(baseBranchHealth.projectId, projectId))
    .orderBy(desc(baseBranchHealth.createdAt));
  return rows.find((row) => row.sha === sha) ?? null;
}

/** Most-recent-first history for a project, capped by limit (default 20). */
export async function listBaseBranchHealth(
  projectId: string,
  limit = 20,
  database: Database = db,
) {
  return database
    .select()
    .from(baseBranchHealth)
    .where(eq(baseBranchHealth.projectId, projectId))
    .orderBy(desc(baseBranchHealth.createdAt))
    .limit(limit);
}
