import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { projects, qualityMetrics } from "@agentic-kanban/shared/schema";
import type { QualityMetricRecord } from "@agentic-kanban/shared/types";
import type { Database } from "../db/index.js";
import { NotFoundError, ValidationError } from "../errors/index.js";

export interface QualityMetricInput {
  metricKey: string;
  value: number;
  unit?: string | null;
  meta?: unknown;
}

export interface QualityMetricsBatchInput {
  commitSha?: string | null;
  collectedAt?: string | null;
  metrics?: QualityMetricInput[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMeta(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function serialize(row: typeof qualityMetrics.$inferSelect): QualityMetricRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    metricKey: row.metricKey,
    value: row.value,
    unit: row.unit,
    meta: parseMeta(row.meta),
    collectedAt: row.collectedAt,
    commitSha: row.commitSha,
  };
}

function validateIsoDate(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} must be an ISO timestamp`);
  }
}

export function createQualityMetricsService(database: Database) {
  async function assertProject(projectId: string): Promise<void> {
    const rows = await database.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1);
    if (rows.length === 0) throw new NotFoundError("Project not found");
  }

  async function recordBatch(projectId: string, input: QualityMetricsBatchInput): Promise<{ inserted: number; metrics: QualityMetricRecord[] }> {
    await assertProject(projectId);
    if (!isRecord(input)) {
      throw new ValidationError("request body must be an object");
    }
    if (!Array.isArray(input.metrics) || input.metrics.length === 0) {
      throw new ValidationError("metrics must be a non-empty array");
    }

    if (input.collectedAt !== undefined && input.collectedAt !== null && typeof input.collectedAt !== "string") {
      throw new ValidationError("collectedAt must be an ISO timestamp");
    }
    if (input.commitSha !== undefined && input.commitSha !== null && typeof input.commitSha !== "string") {
      throw new ValidationError("commitSha must be a string");
    }

    const collectedAt = input.collectedAt ?? new Date().toISOString();
    validateIsoDate(collectedAt, "collectedAt");
    const commitSha = input.commitSha?.trim() || null;

    const rows = input.metrics.map((metric) => {
      if (!isRecord(metric)) {
        throw new ValidationError("metric entries must be objects");
      }
      if (typeof metric.metricKey !== "string" || !metric.metricKey.trim()) {
        throw new ValidationError("metricKey is required");
      }
      if (typeof metric.value !== "number" || !Number.isFinite(metric.value)) {
        throw new ValidationError(`value for ${metric.metricKey} must be a finite number`);
      }
      if (metric.unit !== undefined && metric.unit !== null && typeof metric.unit !== "string") {
        throw new ValidationError(`unit for ${metric.metricKey} must be a string`);
      }
      return {
        id: randomUUID(),
        projectId,
        metricKey: metric.metricKey.trim(),
        value: metric.value,
        unit: metric.unit ?? null,
        meta: metric.meta === undefined || metric.meta === null ? null : JSON.stringify(metric.meta),
        collectedAt,
        commitSha,
      };
    });

    await database.insert(qualityMetrics).values(rows);
    return { inserted: rows.length, metrics: rows.map((row) => serialize(row)) };
  }

  async function list(projectId: string, filters: { metricKey?: string; since?: string }) {
    await assertProject(projectId);
    if (filters.since) validateIsoDate(filters.since, "since");

    const conditions = [
      eq(qualityMetrics.projectId, projectId),
      filters.metricKey ? eq(qualityMetrics.metricKey, filters.metricKey) : undefined,
      filters.since ? gte(qualityMetrics.collectedAt, filters.since) : undefined,
    ].filter(Boolean);

    const rows = await database
      .select()
      .from(qualityMetrics)
      .where(and(...conditions))
      .orderBy(qualityMetrics.metricKey, qualityMetrics.collectedAt);

    const trend = rows.map(serialize);
    const latestByKey = new Map<string, QualityMetricRecord>();
    for (const metric of [...trend].reverse()) {
      if (!latestByKey.has(metric.metricKey)) latestByKey.set(metric.metricKey, metric);
    }

    return {
      latest: [...latestByKey.values()].sort((a, b) => a.metricKey.localeCompare(b.metricKey)),
      trend,
    };
  }

  async function latest(projectId: string): Promise<QualityMetricRecord[]> {
    await assertProject(projectId);
    const rows = await database
      .select()
      .from(qualityMetrics)
      .where(eq(qualityMetrics.projectId, projectId))
      .orderBy(qualityMetrics.metricKey, desc(qualityMetrics.collectedAt));

    const latestByKey = new Map<string, QualityMetricRecord>();
    for (const row of rows) {
      const metric = serialize(row);
      if (!latestByKey.has(metric.metricKey)) latestByKey.set(metric.metricKey, metric);
    }
    return [...latestByKey.values()].sort((a, b) => a.metricKey.localeCompare(b.metricKey));
  }

  async function previousSnapshot(projectId: string, metricKey: string, collectedAt: string): Promise<QualityMetricRecord | null> {
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
    return rows[0] ? serialize(rows[0]) : null;
  }

  return { recordBatch, list, latest, previousSnapshot };
}
