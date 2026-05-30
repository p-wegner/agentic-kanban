import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectWorkspaceCodeMetrics } from "../services/workspace-code-metrics.service.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ak-code-metrics-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("workspace-code-metrics.service", () => {
  it("collects coverage, lint, and heuristic complexity metrics", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "coverage"), { recursive: true });
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "coverage", "coverage-summary.json"), JSON.stringify({
        total: {
          lines: { total: 10, covered: 8, pct: 80 },
        },
      }));
      await writeFile(join(dir, "eslint-report.json"), JSON.stringify([
        { filePath: "src/a.ts", errorCount: 1, warningCount: 2 },
        { filePath: "src/b.ts", errorCount: 0, warningCount: 1 },
      ]));
      await writeFile(join(dir, "src", "a.ts"), `
        export function check(value: number) {
          if (value > 0 && value < 10) return value;
          return value ? value + 1 : 0;
        }
      `);

      const metrics = await collectWorkspaceCodeMetrics(dir);

      expect(metrics.coverage?.linesPct).toBe(80);
      expect(metrics.coverage?.covered).toBe(8);
      expect(metrics.coverage?.total).toBe(10);
      expect(metrics.lint).toMatchObject({ errors: 1, warnings: 3, violations: 4 });
      expect(metrics.complexity?.files).toBe(1);
      expect(metrics.complexity?.average).toBeGreaterThan(1);
    });
  });

  it("returns a metrics snapshot when coverage and lint reports are unavailable", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "plain.ts"), "export const value = 1;\n");

      const metrics = await collectWorkspaceCodeMetrics(dir);

      expect(metrics.coverage).toBeNull();
      expect(metrics.lint).toBeNull();
      expect(metrics.complexity).toMatchObject({ files: 1, source: "heuristic" });
    });
  });
});
