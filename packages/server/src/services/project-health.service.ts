import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { getDirtyTrackedSourceFiles } from "./dirty-main-checkout.js";
import { getPreference } from "../repositories/preferences.repository.js";
import {
  getProjectHealthRows,
  getIssueCountsByStatus,
} from "../repositories/project-health.repository.js";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { getLatestBaseBranchHealth } from "../repositories/base-branch-health.repository.js";
import { listProjectRepos } from "../repositories/repo.repository.js";

/** Last path segment, for labelling a sibling repo whose row carries no name. */
function baseName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

/** Bounded so a 17-repo project does not spawn 34 git processes at once on a request path. */
const HEALTH_CHECK_CONCURRENCY = 6;

/** Bounded-concurrency `map`, preserving input order. */
async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

interface ProjectHealthEntry {
  id: string;
  name: string;
  color: string | null;
  repoPath: string;
  defaultBranch: string | null;
  issueCounts: Record<string, number>;
  totalIssues: number;
  warnings: string[];
  /**
   * How many of the project's repos were actually checked (#632). Absence of a warning used
   * to mean two different things — "checked and clean" and "never looked at" — and they
   * rendered identically, next to other projects that DID show `Git check failed`. On a
   * 17-repo project that read as a clean bill of health for 16 unchecked repos.
   */
  reposChecked: number;
}

interface ProjectHealthResult {
  projects: ProjectHealthEntry[];
  activeProjectId: string | null;
}

async function validateGitRepo(repoPath: string): Promise<string | null> {
  const { error } = await gitExec(["rev-parse", "HEAD"], { cwd: repoPath, timeout: 5000 });
  if (!error) return null;
  if (error.message.includes("not a git repository") || error.message.includes("fatal")) {
    return "Invalid git repository or bad HEAD";
  }
  return "Git check failed";
}

export async function getProjectHealth(database: Database = db): Promise<ProjectHealthResult> {
  const projectRows = await getProjectHealthRows(database);

  const issueCountRows = await getIssueCountsByStatus(database);

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

      // #632: every check here read `project.repoPath` and nothing else, so for a multi-repo
      // project 16 of 17 repos were never looked at — while the row rendered exactly like a
      // healthy one. A dirty or detached SIBLING is just as merge-blocking as a dirty leading
      // repo, so the checks run across every registered repo and roll up, and the count of
      // repos checked is reported so silence can't be mistaken for a pass.
      const siblings = await listProjectRepos(project.id, database).catch(() => []);
      const allRepos = [
        { path: project.repoPath, label: null as string | null },
        ...siblings.map((r) => ({ path: r.path, label: r.name ?? baseName(r.path) })),
      ];

      // Bounded fan-out: a 17-repo project would otherwise spawn 34 git processes at once on
      // a request path, which is the shape that made the worktrees endpoint take 112s (#342).
      const perRepo = await mapBounded(allRepos, HEALTH_CHECK_CONCURRENCY, async (repo) => {
        const found: string[] = [];
        const where = repo.label ? `${repo.label}: ` : "";
        const gitError = await validateGitRepo(repo.path);
        if (gitError) {
          found.push(`${where}${gitError}`);
          return found;
        }
        try {
          const dirtyFiles = await getDirtyTrackedSourceFiles(repo.path);
          if (dirtyFiles.length > 0) {
            const preview = dirtyFiles.slice(0, 3).join(", ");
            const more = dirtyFiles.length > 3 ? ` (+${dirtyFiles.length - 3} more)` : "";
            found.push(`${where}Dirty ${repo.label ? "checkout" : "main checkout"}: ${dirtyFiles.length} uncommitted source file(s) — ${preview}${more}`);
          }
        } catch {
          // non-fatal — dirty check best-effort only
        }
        return found;
      });
      warnings.push(...perRepo.flat());

      // #491 — surface an already-red base branch loudly, without opening a log: a cheap
      // read of the last recorded verify result, never a live check on this request path.
      try {
        const baseHealth = await getLatestBaseBranchHealth(project.id, database);
        if (baseHealth && baseHealth.outcome !== "green") {
          warnings.push(
            `Base branch '${baseHealth.branch}' is ${baseHealth.outcome.toUpperCase()} (verify failed at ${baseHealth.sha.slice(0, 8)}) — merges into it may fail through no fault of the branch.`,
          );
        }
      } catch {
        // non-fatal — base-branch health is a best-effort signal
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
        reposChecked: allRepos.length,
      };
    }),
  );

  return { projects: healthEntries, activeProjectId };
}
