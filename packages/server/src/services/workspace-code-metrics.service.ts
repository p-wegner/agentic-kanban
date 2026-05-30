import { readdir, readFile } from "node:fs/promises";
import { relative } from "node:path";
import { eq } from "drizzle-orm";
import { workspaces } from "@agentic-kanban/shared/schema";
import type { WorkspaceCodeMetrics } from "@agentic-kanban/shared";
import type { Database } from "../db/index.js";

const MAX_REPORT_FILES = 2500;
const MAX_SOURCE_FILES = 300;
const MAX_SOURCE_BYTES = 200_000;
const MAX_WALK_DEPTH = 6;

const SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vite",
  ".worktrees",
  "build",
  "dist",
  "node_modules",
  "target",
]);

const COVERAGE_SUMMARY_FILE = "coverage-summary.json";
const LINT_REPORT_FILES = new Set([
  "eslint-report.json",
  "eslint-results.json",
  "lint-report.json",
  "lint-results.json",
]);

interface WalkOptions {
  maxFiles: number;
  maxDepth: number;
  includeFile: (fileName: string) => boolean;
}

async function walkFiles(root: string, options: WalkOptions): Promise<string[]> {
  const files: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (stack.length > 0 && files.length < options.maxFiles) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (files.length >= options.maxFiles) break;
      const path = `${current.dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (current.depth < options.maxDepth && !SKIP_DIRS.has(entry.name)) {
          stack.push({ dir: path, depth: current.depth + 1 });
        }
        continue;
      }
      if (entry.isFile() && options.includeFile(entry.name)) {
        files.push(path);
      }
    }
  }

  return files;
}

function displayPath(root: string, filePath: string): string {
  return relative(root, filePath).replace(/\\/g, "/");
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseCoverageReport(raw: unknown): { total?: number; covered?: number; pct?: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const total = (raw as { total?: unknown }).total;
  if (!total || typeof total !== "object") return null;
  const lines = (total as { lines?: unknown }).lines;
  if (!lines || typeof lines !== "object") return null;

  const totalLines = asNumber((lines as { total?: unknown }).total);
  const coveredLines = asNumber((lines as { covered?: unknown }).covered);
  const pct = asNumber((lines as { pct?: unknown }).pct);
  if (totalLines === null && coveredLines === null && pct === null) return null;
  return {
    total: totalLines ?? undefined,
    covered: coveredLines ?? undefined,
    pct: pct ?? undefined,
  };
}

function parseLintReport(raw: unknown): { errors: number; warnings: number } | null {
  if (Array.isArray(raw)) {
    return raw.reduce(
      (acc, item) => {
        const parsed = parseLintReport(item);
        if (!parsed) return acc;
        acc.errors += parsed.errors;
        acc.warnings += parsed.warnings;
        return acc;
      },
      { errors: 0, warnings: 0 },
    );
  }

  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.results)) {
    return parseLintReport(obj.results);
  }

  const errors = (asNumber(obj.errorCount) ?? 0) + (asNumber(obj.fatalErrorCount) ?? 0);
  const warnings = asNumber(obj.warningCount) ?? 0;
  if (errors === 0 && warnings === 0 && !("errorCount" in obj) && !("warningCount" in obj)) {
    return null;
  }
  return { errors, warnings };
}

async function readJson(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function collectCoverage(root: string): Promise<WorkspaceCodeMetrics["coverage"]> {
  const files = await walkFiles(root, {
    maxFiles: MAX_REPORT_FILES,
    maxDepth: MAX_WALK_DEPTH,
    includeFile: (name) => name === COVERAGE_SUMMARY_FILE,
  });
  if (files.length === 0) return null;

  let total = 0;
  let covered = 0;
  const pcts: number[] = [];
  let reports = 0;

  for (const file of files) {
    const parsed = parseCoverageReport(await readJson(file));
    if (!parsed) continue;
    reports++;
    if (parsed.total !== undefined && parsed.covered !== undefined) {
      total += parsed.total;
      covered += parsed.covered;
    } else if (parsed.pct !== undefined) {
      pcts.push(parsed.pct);
    }
  }

  if (reports === 0) return null;
  const linesPct = total > 0
    ? (covered / total) * 100
    : pcts.length > 0
      ? pcts.reduce((sum, pct) => sum + pct, 0) / pcts.length
      : null;
  if (linesPct === null) return null;

  return {
    linesPct: Number(linesPct.toFixed(1)),
    ...(total > 0 ? { total, covered } : {}),
    source: reports === 1 ? displayPath(root, files[0]) : `${reports} coverage reports`,
  };
}

async function collectLint(root: string): Promise<WorkspaceCodeMetrics["lint"]> {
  const files = await walkFiles(root, {
    maxFiles: MAX_REPORT_FILES,
    maxDepth: MAX_WALK_DEPTH,
    includeFile: (name) => LINT_REPORT_FILES.has(name),
  });
  if (files.length === 0) return null;

  let errors = 0;
  let warnings = 0;
  let reports = 0;
  for (const file of files) {
    const parsed = parseLintReport(await readJson(file));
    if (!parsed) continue;
    reports++;
    errors += parsed.errors;
    warnings += parsed.warnings;
  }

  if (reports === 0) return null;
  return {
    errors,
    warnings,
    violations: errors + warnings,
    source: reports === 1 ? displayPath(root, files[0]) : `${reports} lint reports`,
  };
}

function sourceComplexity(text: string): number {
  const branchMatches = text.match(/\b(if|for|while|case|catch)\b|&&|\|\||\?/g);
  return 1 + (branchMatches?.length ?? 0);
}

async function collectComplexity(root: string): Promise<WorkspaceCodeMetrics["complexity"]> {
  const files = await walkFiles(root, {
    maxFiles: MAX_SOURCE_FILES,
    maxDepth: MAX_WALK_DEPTH,
    includeFile: (name) =>
      /\.(cjs|js|jsx|mjs|ts|tsx)$/.test(name) &&
      !name.endsWith(".d.ts") &&
      !/\.(test|spec)\.[cm]?[jt]sx?$/.test(name),
  });
  if (files.length === 0) return null;

  const scores: number[] = [];
  for (const file of files) {
    try {
      const text = await readFile(file, { encoding: "utf8", flag: "r" });
      scores.push(sourceComplexity(text.slice(0, MAX_SOURCE_BYTES)));
    } catch {
      // Ignore unreadable files.
    }
  }
  if (scores.length === 0) return null;

  const total = scores.reduce((sum, score) => sum + score, 0);
  return {
    average: Number((total / scores.length).toFixed(1)),
    max: Math.max(...scores),
    files: scores.length,
    source: "heuristic",
  };
}

export async function collectWorkspaceCodeMetrics(workingDir: string): Promise<WorkspaceCodeMetrics> {
  const [coverage, lint, complexity] = await Promise.all([
    collectCoverage(workingDir),
    collectLint(workingDir),
    collectComplexity(workingDir),
  ]);

  return {
    computedAt: new Date().toISOString(),
    coverage,
    lint,
    complexity,
  };
}

export function parseStoredWorkspaceCodeMetrics(
  json: string | null,
  computedAt: string | null,
): WorkspaceCodeMetrics | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as WorkspaceCodeMetrics;
    return {
      ...parsed,
      computedAt: parsed.computedAt || computedAt || "",
    };
  } catch {
    return null;
  }
}

export async function computeWorkspaceCodeMetrics(
  workspaceId: string,
  database: Database,
): Promise<WorkspaceCodeMetrics | null> {
  const rows = await database
    .select({ workingDir: workspaces.workingDir })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  const workingDir = rows[0]?.workingDir;
  if (!workingDir) return null;

  const metrics = await collectWorkspaceCodeMetrics(workingDir);
  await database.update(workspaces).set({
    codeMetricsJson: JSON.stringify(metrics),
    codeMetricsComputedAt: metrics.computedAt,
  }).where(eq(workspaces.id, workspaceId));

  return metrics;
}
