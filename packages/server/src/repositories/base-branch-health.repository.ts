import { randomUUID } from "node:crypto";
import { baseBranchHealth } from "@agentic-kanban/shared/schema";
import { count, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { firstRow } from "../lib/first-row.js";

export type BaseBranchHealthOutcome = "green" | "red" | "timeout" | "unverified";

/**
 * Is this outcome a VERDICT about the base, or a non-answer about the probe (#935)?
 *
 * `green`/`red` are verdicts: the probe ran the verify script to completion and the base
 * either passed or failed. `timeout`/`unverified` are non-answers — the probe was cut off at
 * its budget, or never got far enough to install the clone. Neither says anything about the
 * base's health, and treating them as if they did is what this ticket exists to stop:
 *
 * Measured on this board 2026-08-27/28 — a full `pnpm test:mine` on master was green (9297
 * tests, exit 0) while the recorded verdict said TIMEOUT, produced on a box where Windows
 * Defender held 336% CPU, an unrelated Kotlin daemon 207%, and only 3 vitest workers existed
 * at all. Under that load the 45-minute budget is not enough, and the starved run was cached
 * as the base's health, prefixing every subsequent gate failure with a false accusation
 * against master.
 *
 * It lives here, next to the outcome type it classifies, rather than in the service: it is a
 * pure predicate over one string, and its consumers (attribution, project health, the monitor
 * warnings) would otherwise each have to import the probe service — which pulls in git,
 * clone and setup-script machinery — to ask a question about an enum.
 */
export function isBaseHealthAnswer(outcome: string | null | undefined): boolean {
  return outcome === "green" || outcome === "red";
}

export interface RecordBaseBranchHealthInput {
  projectId: string;
  sha: string;
  branch: string;
  outcome: BaseBranchHealthOutcome;
  durationMs?: number;
  message?: string;
  /**
   * The suites this probe named as failed (#681 half B). `undefined`/`null` means the probe
   * produced no per-suite verdict at all — see the column comment in the schema; it is NOT
   * the same as an empty array.
   */
  failedSuites?: string[] | null;
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
    // `== null` covers both absent and explicit null, and only those: an empty array must
    // still be stored as `"[]"`, since "green, nothing failed" is the verdict that breaks a
    // suite's red streak.
    failedSuites: input.failedSuites == null ? null : JSON.stringify(input.failedSuites),
    createdAt: new Date().toISOString(),
  });
  return id;
}

/** The newest recorded base-branch health result for a project, or null when none was ever recorded. */
export async function getLatestBaseBranchHealth(
  projectId: string,
  database: Database = db,
) {
  return firstRow(
    database
      .select()
      .from(baseBranchHealth)
      .where(eq(baseBranchHealth.projectId, projectId))
      .orderBy(desc(baseBranchHealth.createdAt))
      .limit(1)
  );
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

/**
 * One probe's per-suite verdict, newest first — the input to the rot detector (#681 half B).
 *
 * Deliberately NOT `listBaseBranchHealth`: that returns whole rows including a 40-line message
 * tail, and the detector reads a window of them per project on every monitor warning refresh.
 * Selecting three columns keeps that cheap enough to run unconditionally.
 */
export async function listSuiteVerdicts(
  projectId: string,
  limit = 30,
  database: Database = db,
): Promise<{ createdAt: string; outcome: BaseBranchHealthOutcome; failedSuites: string[] | null }[]> {
  const rows = await database
    .select({
      createdAt: baseBranchHealth.createdAt,
      outcome: baseBranchHealth.outcome,
      failedSuites: baseBranchHealth.failedSuites,
    })
    .from(baseBranchHealth)
    .where(eq(baseBranchHealth.projectId, projectId))
    .orderBy(desc(baseBranchHealth.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    createdAt: row.createdAt,
    outcome: row.outcome as BaseBranchHealthOutcome,
    // A row written before the column existed, or one whose JSON is unreadable, is `null` —
    // "no verdict", which the detector neither extends nor breaks a streak with. Swallowing a
    // parse error into `[]` would silently clear every streak that crosses such a row.
    failedSuites: parseSuiteList(row.failedSuites),
  }));
}

function parseSuiteList(raw: string | null): string[] | null {
  if (raw === null || raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}
