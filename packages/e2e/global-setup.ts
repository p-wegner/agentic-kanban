import { request } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { normalize, resolve } from "node:path";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

export const E2E_STATE_FILE = resolve(import.meta.dirname, ".e2e-run-state.json");

const serverPort = Number(process.env.SERVER_PORT) || 3001;

export interface Project {
  id: string;
  name: string;
  repoPath: string;
}

export interface E2EProjectSetupResult {
  project: Project;
  created: boolean;
}

function normalizeRepoPath(repoPath: string): string {
  const normalized = normalize(repoPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function findProjectByRepoPath(
  apiContext: APIRequestContext,
  repoPath: string,
): Promise<Project | null> {
  const projectsRes = await apiContext.get("/api/projects");
  if (!projectsRes.ok()) {
    throw new Error(`Failed to list projects after duplicate registration: ${projectsRes.status()}`);
  }

  const projects: Project[] = await projectsRes.json();
  const targetPath = normalizeRepoPath(repoPath);
  return projects.find((project) => normalizeRepoPath(project.repoPath) === targetPath) ?? null;
}

export async function ensureE2EProject(
  apiContext: APIRequestContext,
  repoPath: string,
  runId = Date.now().toString(36),
): Promise<E2EProjectSetupResult> {
  const registerRes = await apiContext.post("/api/projects", {
    data: {
      name: `E2E Test Project ${runId}`,
      repoPath,
    },
  });

  if (registerRes.status() === 201) {
    const project: Project = await registerRes.json();
    await apiContext.put("/api/preferences/active-project", {
      data: { projectId: project.id },
    });
    return { project, created: true };
  }

  if (registerRes.status() === 409) {
    const existingProject = await findProjectByRepoPath(apiContext, repoPath);
    if (!existingProject) {
      throw new Error("Project registration reported a duplicate path, but the existing project was not found");
    }

    await apiContext.put("/api/preferences/active-project", {
      data: { projectId: existingProject.id },
    });
    return { project: existingProject, created: false };
  }

  throw new Error(`Failed to create E2E test project: ${registerRes.status()} ${await registerRes.text()}`);
}

async function globalSetup() {
  const apiContext = await request.newContext({ baseURL: `http://127.0.0.1:${serverPort}` });

  // Resolve the actual monorepo root. For worktrees nested inside packages/.worktrees/,
  // the git common-dir points back to the main repo's .git — use it to find the main root.
  let repoPath: string;
  try {
    const commonDir = execSync("git rev-parse --git-common-dir", { cwd: import.meta.dirname, encoding: "utf8" }).trim();
    // commonDir is either ".git" (main checkout) or an absolute path to main .git (worktree)
    const gitRoot = resolve(import.meta.dirname, commonDir).replace(/[/\\]\.git$/, "");
    repoPath = gitRoot;
  } catch {
    repoPath = resolve(import.meta.dirname, "..", "..");
  }

  // Record the currently active project so we can restore it after tests run.
  let previousActiveProjectId: string | null = null;
  try {
    const prefRes = await apiContext.get("/api/preferences/active-project");
    if (prefRes.ok()) {
      const pref = await prefRes.json();
      previousActiveProjectId = pref.projectId ?? null;
    }
  } catch {
    // ignore — no active project set yet
  }

  let projectSetup: E2EProjectSetupResult;
  try {
    projectSetup = await ensureE2EProject(apiContext, repoPath);
  } catch (err) {
    console.error("[global-setup] Failed to prepare E2E test project:", err);
    await apiContext.dispose();
    return;
  }

  const project = projectSetup.project;

  // Create default statuses for newly-created E2E projects.
  const statuses = [
    { name: "Todo", sortOrder: 0 },
    { name: "In Progress", sortOrder: 1 },
    { name: "In Review", sortOrder: 2 },
    { name: "AI Reviewed", sortOrder: 3 },
    { name: "Done", sortOrder: 4 },
    { name: "Cancelled", sortOrder: 5 },
  ];
  if (projectSetup.created) {
    for (const status of statuses) {
      await apiContext.post(`/api/projects/${project.id}/statuses`, {
        data: status,
      });
    }
  }

  // Persist the run state so global-teardown can clean up reliably.
  writeFileSync(
    E2E_STATE_FILE,
    JSON.stringify({ e2eProjectId: project.id, previousActiveProjectId, createdE2EProject: projectSetup.created }),
    "utf8",
  );

  const action = projectSetup.created ? "Created" : "Reused";
  console.log(`[global-setup] ${action} E2E project "${project.name}" (${project.id})`);

  await apiContext.dispose();
}

export default globalSetup;
