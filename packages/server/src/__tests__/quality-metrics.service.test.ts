import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { projects, qualityMetrics } from "@agentic-kanban/shared/schema";
import { createQualityMetricsService } from "../services/quality-metrics.service.js";
import { deleteProjectCascade } from "../repositories/project.repository.js";
import { createTestDb } from "./helpers/test-db.js";

async function seedProject(db: ReturnType<typeof createTestDb>["db"]) {
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    name: "quality-project",
    repoPath: "/tmp/quality-project",
    repoName: "quality-project",
    defaultBranch: "main",
  });
  return projectId;
}

describe("createQualityMetricsService", () => {
  it("validates batch shape and metric values", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const service = createQualityMetricsService(db);

    await expect(service.recordBatch(projectId, { metrics: [] })).rejects.toThrow("metrics must be a non-empty array");
    await expect(service.recordBatch(projectId, {
      metrics: [{ metricKey: "", value: 1 }],
    })).rejects.toThrow("metricKey is required");
    await expect(service.recordBatch(projectId, {
      metrics: [{ metricKey: "coverage.lines", value: Number.NaN }],
    })).rejects.toThrow("value for coverage.lines must be a finite number");
    await expect(service.recordBatch(projectId, {
      collectedAt: "not-a-date",
      metrics: [{ metricKey: "coverage.lines", value: 81.5 }],
    })).rejects.toThrow("collectedAt must be an ISO timestamp");
    await expect(service.recordBatch(projectId, null as any)).rejects.toThrow("request body must be an object");
    await expect(service.recordBatch(projectId, {
      commitSha: 123 as any,
      metrics: [{ metricKey: "coverage.lines", value: 81.5 }],
    })).rejects.toThrow("commitSha must be a string");
    await expect(service.recordBatch(projectId, {
      metrics: [null as any],
    })).rejects.toThrow("metric entries must be objects");
    await expect(service.recordBatch(projectId, {
      metrics: [{ metricKey: "coverage.lines", value: 81.5, unit: 1 as any }],
    })).rejects.toThrow("unit for coverage.lines must be a string");
  });

  it("records a batch and returns the latest metric per key", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const service = createQualityMetricsService(db);

    await service.recordBatch(projectId, {
      collectedAt: "2026-05-30T10:00:00.000Z",
      commitSha: "abc123",
      metrics: [
        { metricKey: "coverage.lines", value: 70, unit: "percent", meta: { source: "vitest" } },
        { metricKey: "lint.errors", value: 3, unit: "count" },
      ],
    });
    await service.recordBatch(projectId, {
      collectedAt: "2026-05-30T11:00:00.000Z",
      commitSha: "def456",
      metrics: [
        { metricKey: "coverage.lines", value: 82, unit: "percent" },
        { metricKey: "lint.errors", value: 1, unit: "count" },
      ],
    });

    const listed = await service.list(projectId, {});
    expect(listed.trend).toHaveLength(4);
    expect(listed.latest.map((metric) => [metric.metricKey, metric.value])).toEqual([
      ["coverage.lines", 82],
      ["lint.errors", 1],
    ]);

    const coverage = listed.trend.find((metric) => metric.metricKey === "coverage.lines" && metric.value === 70);
    expect(coverage?.meta).toEqual({ source: "vitest" });
    expect(coverage?.commitSha).toBe("abc123");
  });

  it("filters trend data by metric key and since timestamp", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const service = createQualityMetricsService(db);

    await service.recordBatch(projectId, {
      collectedAt: "2026-05-30T10:00:00.000Z",
      metrics: [
        { metricKey: "coverage.lines", value: 70 },
        { metricKey: "lint.errors", value: 3 },
      ],
    });
    await service.recordBatch(projectId, {
      collectedAt: "2026-05-30T11:00:00.000Z",
      metrics: [{ metricKey: "coverage.lines", value: 82 }],
    });

    const listed = await service.list(projectId, {
      metricKey: "coverage.lines",
      since: "2026-05-30T10:30:00.000Z",
    });

    expect(listed.trend.map((metric) => metric.value)).toEqual([82]);
    expect(listed.latest.map((metric) => metric.metricKey)).toEqual(["coverage.lines"]);
  });

  it("cleans up quality metrics when deleting a project", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const service = createQualityMetricsService(db);

    await service.recordBatch(projectId, {
      metrics: [{ metricKey: "coverage.lines", value: 82 }],
    });

    await deleteProjectCascade(projectId, db);

    const metricRows = await db.select().from(qualityMetrics);
    const projectRows = await db.select().from(projects);
    expect(metricRows).toHaveLength(0);
    expect(projectRows).toHaveLength(0);
  });
});
