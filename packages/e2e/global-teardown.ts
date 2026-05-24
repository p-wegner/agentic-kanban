/**
 * Global E2E teardown — deletes the dedicated E2E test project created by global-setup,
 * which cascade-deletes all issues, workspaces, sessions, and statuses created during the run.
 * Also restores the active-project preference to what it was before the tests ran.
 *
 * If the state file written by global-setup is missing (e.g. setup failed), this falls back
 * to the legacy pattern-based cleanup to catch any orphaned test artifacts.
 */

import { request } from "@playwright/test";
import { tmpdir } from "node:os";
import { normalize, sep } from "node:path";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { E2E_STATE_FILE } from "./global-setup.js";

const serverPort = Number(process.env.SERVER_PORT) || 3001;

/** Patterns that identify E2E-generated test artifact issues (fallback only). */
const TEST_TITLE_PATTERNS: RegExp[] = [
  /^Session stats test /,
  /^Task progress test /,
  /^board-stats-/,
  /^RT (create|status) test /,
  /^⏰ e2e-/,
  /^e2e-[a-z]+-[0-9a-z]+$/i,
];

function isTestArtifact(title: string): boolean {
  return TEST_TITLE_PATTERNS.some((re) => re.test(title));
}

async function cleanupE2EProject(
  apiContext: import("@playwright/test").APIRequestContext,
  e2eProjectId: string,
  previousActiveProjectId: string | null,
) {
  // Delete the entire E2E project — this cascades to issues, workspaces, sessions, and statuses.
  const deleteRes = await apiContext.delete(`/api/projects/${e2eProjectId}`);
  if (deleteRes.ok()) {
    console.log(`[global-teardown] Deleted E2E test project (${e2eProjectId})`);
  } else {
    console.warn(`[global-teardown] Failed to delete E2E project ${e2eProjectId}: ${deleteRes.status()}`);
  }

  // Restore the previously active project (if any and if it still exists).
  if (previousActiveProjectId) {
    const projectsRes = await apiContext.get("/api/projects");
    if (projectsRes.ok()) {
      const projects: Array<{ id: string }> = await projectsRes.json();
      const stillExists = projects.some((p) => p.id === previousActiveProjectId);
      if (stillExists) {
        await apiContext.put("/api/preferences/active-project", {
          data: { projectId: previousActiveProjectId },
        });
        console.log(`[global-teardown] Restored active project to ${previousActiveProjectId}`);
      } else if (projects.length > 0) {
        // Fallback: activate whatever project is still registered
        await apiContext.put("/api/preferences/active-project", {
          data: { projectId: projects[0].id },
        });
      }
    }
  }
}

async function fallbackCleanupIssuesAndRuns(apiContext: import("@playwright/test").APIRequestContext) {
  const prefRes = await apiContext.get("/api/preferences/active-project");
  if (!prefRes.ok()) return;
  const { projectId } = await prefRes.json();
  if (!projectId) return;

  const issuesRes = await apiContext.get(`/api/issues?projectId=${projectId}`);
  if (!issuesRes.ok()) return;
  const issues: Array<{ id: string; title: string }> = await issuesRes.json();

  const runsRes = await apiContext.get(`/api/scheduled-runs?projectId=${projectId}`);
  if (runsRes.ok()) {
    const runs: Array<{ id: string; name: string }> = await runsRes.json();
    for (const run of runs) {
      if (/^e2e-/i.test(run.name)) {
        await apiContext.delete(`/api/scheduled-runs/${run.id}`);
      }
    }
  }

  const leaked = issues.filter((i) => isTestArtifact(i.title));
  if (leaked.length > 0) {
    console.log(
      `[global-teardown] Cleaning up ${leaked.length} leaked test issue(s):`,
      leaked.map((i) => `"${i.title}"`).join(", "),
    );
    for (const issue of leaked) {
      await apiContext.delete(`/api/issues/${issue.id}`);
    }
  }
}

async function fallbackCleanupProjects(apiContext: import("@playwright/test").APIRequestContext) {
  const projectsRes = await apiContext.get("/api/projects");
  if (!projectsRes.ok()) return;
  const projects: Array<{ id: string; name: string; repoPath: string }> = await projectsRes.json();
  const tempPrefix = normalize(tmpdir()) + sep;
  const orphaned = projects.filter(
    (p) =>
      /^E2E Test Project /.test(p.name) ||
      /^e2e-project-/.test(p.name) ||
      normalize(p.repoPath).startsWith(tempPrefix),
  );
  if (orphaned.length > 0) {
    console.log(
      `[global-teardown] Cleaning up ${orphaned.length} orphaned E2E project(s):`,
      orphaned.map((p) => `"${p.name}"`).join(", "),
    );
    for (const project of orphaned) {
      await apiContext.delete(`/api/projects/${project.id}`);
    }
  }
}

async function globalTeardown() {
  const apiContext = await request.newContext({
    baseURL: `http://localhost:${serverPort}`,
  });

  try {
    if (existsSync(E2E_STATE_FILE)) {
      const state: { e2eProjectId: string; previousActiveProjectId: string | null } =
        JSON.parse(readFileSync(E2E_STATE_FILE, "utf8"));
      await cleanupE2EProject(apiContext, state.e2eProjectId, state.previousActiveProjectId);
      try { unlinkSync(E2E_STATE_FILE); } catch { /* ignore */ }
    } else {
      // State file missing — global-setup may have failed. Use legacy fallback cleanup.
      console.warn("[global-teardown] State file not found — using fallback cleanup");
      await fallbackCleanupIssuesAndRuns(apiContext);
      await fallbackCleanupProjects(apiContext);
    }
  } catch (err) {
    console.warn("[global-teardown] Cleanup error (non-fatal):", err);
  } finally {
    await apiContext.dispose();
  }
}

export default globalTeardown;
