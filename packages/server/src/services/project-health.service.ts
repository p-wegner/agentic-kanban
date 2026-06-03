import { projects, projectStatuses, issues } from "@agentic-kanban/shared/schema";
import { eq, sql } from "drizzle-orm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { getDirtyTrackedSourceFiles } from "./dirty-main-checkout.js";
import { getPreference } from "../repositories/preferences.repository.js";

const execFileAsync = promisify(execFile);

interface ProjectHealthEntry {
  id: string;
  name: string;
  color: string | null;
  repoPath: string;
  defaultBranch: string | null;
  issueCounts: Record<string, number>;
  totalIssues: number;
  warnings: string[];
}

interface ProjectHealthResult {
  projects: ProjectHealthEntry[];
  activeProjectId: string | null;
}

async function validateGitRepo(repoPath: string): Promise<string | null> {
  try {
    await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repoPath,
      timeout: 5000,
      windowsHide: true,
    });
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not a git repository") || msg.includes("fatal")) {
      return "Invalid git repository or bad HEAD";
    }
    return "Git check failed";
  }
}

export async function getProjectHealth(database: Database = db): Promise<ProjectHealthResult> {
  const projectRows = await database.select({
    id: projects.id,
    name: projects.name,
    color: projects.color,
    repoPath: projects.repoPath,
    defaultBranch: projects.defaultBranch,
  }).from(projects);

  const issueCountRows = await database
    .select({
      projectId: issues.projectId,
      statusName: projectStatuses.name,
      count: sql<number>`count(*)`,
    })
    .from(issues)
    .leftJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .groupBy(issues.projectId, projectStatuses.name);

  const countsByProject = new Map<string, Record<string, number>>();
  for (const row of issueCountRows) {
    if (!countsByProject.has(row.projectId)) {
      countsByProject.set(row.projectId, {});
    }
    if (row.statusName != null) {
      countsByProject.get(row.projectId)![row.statusName] = Number(row.count);
    }
  }

  const activeProjectId = await getPreference("activeProjectId", database);

  const healthEntries = await Promise.all(
    projectRows.map(async (project): Promise<ProjectHealthEntry> => {
      const warnings: string[] = [];

      const gitError = await validateGitRepo(project.repoPath);
      if (gitError) {
        warnings.push(gitError);
      } else {
        try {
          const dirtyFiles = await getDirtyTrackedSourceFiles(project.repoPath);
          if (dirtyFiles.length > 0) {
            const preview = dirtyFiles.slice(0, 3).join(", ");
            const more = dirtyFiles.length > 3 ? ` (+${dirtyFiles.length - 3} more)` : "";
            warnings.push(`Dirty main checkout: ${dirtyFiles.length} uncommitted source file(s) — ${preview}${more}`);
          }
        } catch {
          // non-fatal — dirty check best-effort only
        }
      }

      const issueCounts = countsByProject.get(project.id) ?? {};
      const totalIssues = Object.values(issueCounts).reduce((sum, n) => sum + n, 0);

      return {
        id: project.id,
        name: project.name,
        color: project.color,
        repoPath: project.repoPath,
        defaultBranch: project.defaultBranch,
        issueCounts,
        totalIssues,
        warnings,
      };
    }),
  );

  return { projects: healthEntries, activeProjectId };
}
