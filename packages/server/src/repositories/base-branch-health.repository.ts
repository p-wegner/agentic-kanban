import { randomUUID } from "node:crypto";
import { baseBranchHealth } from "@agentic-kanban/shared/schema";
import { count, desc, eq, sql } from "drizzle-orm";
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

/**
 * Per-outcome counts for a project's whole recorded history (#681).
 *
 * The question nobody asked was "has this probe EVER been green?". Measured on this board:
 * `base_branch_health` for the dev project held 200 probes — 199 red plus one timeout, zero
 * green, across five days — while every consumer only ever read the LATEST row, for which
 * "red again" is indistinguishable from "red because the probe itself is broken". Half of all
 * base-health verdicts in the DB were false for that reason (install artifacts: `TS2688
 * Cannot find type definition file for 'node'`, `Could not resolve 'vite'`).
 *
 * A distribution needs the whole history, so this aggregates rather than sampling a page of
 * `listBaseBranchHealth` — a 20-row window cannot tell "never green" from "red lately".
 */
export async function countBaseBranchHealthOutcomes(
  projectId: string,
  database: Database = db,
): Promise<{ total: number; byOutcome: Record<BaseBranchHealthOutcome, number>; firstAt: string | null; lastAt: string | null }> {
  const rows = await database
    .select({
      outcome: baseBranchHealth.outcome,
      n: count(),
      firstAt: sql<string | null>`min(${baseBranchHealth.createdAt})`,
      lastAt: sql<string | null>`max(${baseBranchHealth.createdAt})`,
    })
    .from(baseBranchHealth)
    .where(eq(baseBranchHealth.projectId, projectId))
    .groupBy(baseBranchHealth.outcome);

  const byOutcome: Record<BaseBranchHealthOutcome, number> = { green: 0, red: 0, timeout: 0, unverified: 0 };
  let total = 0;
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  for (const row of rows) {
    const outcome = row.outcome as BaseBranchHealthOutcome;
    if (outcome in byOutcome) byOutcome[outcome] = Number(row.n);
    total += Number(row.n);
    if (row.firstAt && (firstAt === null || row.firstAt < firstAt)) firstAt = row.firstAt;
    if (row.lastAt && (lastAt === null || row.lastAt > lastAt)) lastAt = row.lastAt;
  }
  return { total, byOutcome, firstAt, lastAt };
}
