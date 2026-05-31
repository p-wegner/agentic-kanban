import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { projects } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";

const execFileAsync = promisify(execFile);

const SOURCE_PATHSPECS = [
  ":(glob)packages/**/*.ts",
  ":(glob)packages/**/*.tsx",
  ":(glob)packages/**/*.sql",
];

export interface DirtyMainCheckoutWarning {
  projectId: string;
  projectName: string;
  repoPath: string;
  detectedAt: string;
  fileCount: number;
  files: string[];
  message: string;
}

export async function getDirtyTrackedSourceFiles(repoPath: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["diff", "--name-only", "HEAD", "--", ...SOURCE_PATHSPECS],
    { cwd: repoPath, timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function scanDirtyMainCheckouts(database: Database = db): Promise<DirtyMainCheckoutWarning[]> {
  const projectRows = await database.select({
    id: projects.id,
    name: projects.name,
    repoPath: projects.repoPath,
  }).from(projects);
  const detectedAt = new Date().toISOString();
  const warnings: DirtyMainCheckoutWarning[] = [];

  for (const project of projectRows) {
    if (!project.repoPath) continue;
    let files: string[];
    try {
      files = await getDirtyTrackedSourceFiles(project.repoPath);
    } catch (err) {
      console.warn(`[dirty-main-checkout] failed to inspect ${project.repoPath}:`, err instanceof Error ? err.message : String(err));
      continue;
    }
    if (files.length === 0) continue;

    const preview = files.slice(0, 5).join(", ");
    const more = files.length > 5 ? ` (and ${files.length - 5} more)` : "";
    warnings.push({
      projectId: project.id,
      projectName: project.name,
      repoPath: project.repoPath,
      detectedAt,
      fileCount: files.length,
      files,
      message: `Main checkout has ${files.length} uncommitted tracked source change(s): ${preview}${more}. Commit or revert them before relying on monitor/merge automation.`,
    });
  }

  return warnings;
}
