import { and, desc, eq, gte, sql } from "drizzle-orm";
import { qualityMetrics } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export type QualityMetricRow = typeof qualityMetrics.$inferSelect;
export type QualityMetricInsert = typeof qualityMetrics.$inferInsert;

export async function insertQualityMetrics(
  rows: QualityMetricInsert[],
  database: Database = db,
): Promise<void> {
  await database.insert(qualityMetrics).values(rows);
}

export async function listQualityMetrics(
  projectId: string,
  filters: { metricKey?: string; since?: string },
  database: Database = db,
): Promise<QualityMetricRow[]> {
  const conditions = [
    eq(qualityMetrics.projectId, projectId),
    filters.metricKey ? eq(qualityMetrics.metricKey, filters.metricKey) : undefined,
    filters.since ? gte(qualityMetrics.collectedAt, filters.since) : undefined,
  ].filter(Boolean);

  return database
    .select()
    .from(qualityMetrics)
    .where(and(...conditions))
    .orderBy(qualityMetrics.metricKey, qualityMetrics.collectedAt);
}

export async function listLatestQualityMetrics(
  projectId: string,
  database: Database = db,
): Promise<QualityMetricRow[]> {
  return database
    .select()
    .from(qualityMetrics)
    .where(eq(qualityMetrics.projectId, projectId))
    .orderBy(qualityMetrics.metricKey, desc(qualityMetrics.collectedAt));
}

export async function getPreviousQualityMetricSnapshot(
  projectId: string,
  metricKey: string,
  collectedAt: string,
  database: Database = db,
): Promise<QualityMetricRow | null> {
  const rows = await database
    .select()
    .from(qualityMetrics)
    .where(and(
      eq(qualityMetrics.projectId, projectId),
      eq(qualityMetrics.metricKey, metricKey),
      sql`${qualityMetrics.collectedAt} < ${collectedAt}`,
    ))
    .orderBy(desc(qualityMetrics.collectedAt))
    .limit(1);
  return rows[0] ?? null;
}
