import { request } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { normalize, resolve } from "node:path";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { E2E_SERVER_PORT } from "./ports.js";

export const E2E_STATE_FILE = resolve(import.meta.dirname, ".e2e-run-state.json");

// #645: was its own `|| 3001` default — a third copy that would have pointed setup
// and teardown at the live dev board while the stack ran on the E2E ports.
const serverPort = E2E_SERVER_PORT;

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

/**
 * Registration derives a stack-aware setup script (#810) — for this monorepo, `pnpm install -r`.
 * Every workspace a spec creates then runs it in its fresh worktree, and MEASURED on this repo
 * that put `POST /api/workspaces` at 153s. A suite whose central object costs two and a half
 * minutes to make is a suite nobody runs, which is #645's actual complaint. The specs assert
 * board behaviour, not that a worktree can install dependencies, so the E2E project has no
 * setup script.
 */
async function disableSetupScript(apiContext: APIRequestContext, projectId: string): Promise<void> {
  const res = await apiContext.patch(`/api/projects/${projectId}`, {
    data: { setupScript: null },
  });
  if (!res.ok()) {
    console.warn(`[global-setup] could not clear the setup script (${res.status()}) — workspace creation will be slow`);
  }
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
    await disableSetupScript(apiContext, project.id);
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

    // Also on the reuse path: the E2E database survives between runs, so a project created
    // before this was added would otherwise keep its derived `pnpm install -r` forever.
    await disableSetupScript(apiContext, existingProject.id);
    await pruneEmptyDuplicateStatuses(apiContext, existingProject.id);
    await apiContext.put("/api/preferences/active-project", {
      data: { projectId: existingProject.id },
    });
    return { project: existingProject, created: false };
  }

  throw new Error(`Failed to create E2E test project: ${registerRes.status()} ${await registerRes.text()}`);
}

/**
 * Wait for the E2E server to answer /health before touching the API.
 *
 * Playwright starts `webServer` and runs `globalSetup` without guaranteeing the server is
 * listening first, so every API call in here raced the boot. On a cold isolated stack that
 * boot is not fast — it migrates and seeds a fresh database, and this repo's startup sweep
 * walks ~20 orphaned worktrees before the port opens. Losing the race produced
 * `ECONNREFUSED 127.0.0.1:<port>` out of global-setup, which fails EVERY spec in the run at
 * 0ms — so the whole lane reported a connection error instead of whatever the specs would
 * actually have found. That is why a single spec passed and the lane did not.
 *
 * Budget matches the config's `webServer.timeout` (120s): whatever Playwright is willing to
 * wait for the server, so is this.
 */
async function waitForServer(apiContext: APIRequestContext, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "never attempted";
  while (Date.now() < deadline) {
    try {
      const res = await apiContext.get("/health", { timeout: 5_000 });
      if (res.ok()) return;
      lastError = `HTTP ${res.status()}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `[global-setup] server on port ${serverPort} did not answer /health within ${timeoutMs}ms — last error: ${lastError}`,
  );
}

/**
 * Remove EMPTY duplicate statuses from the E2E project.
 *
 * The reused E2E database had accumulated a second full set of default statuses (#668), so
 * the board rendered two columns named "Todo" — one holding every issue, one permanently
 * empty. Playwright is strict about ambiguous locators, so every spec that clicked anything
 * inside a column died on a strict-mode violation naming two ids, and every spec that
 * resolved a status by name was picking one of two arbitrarily.
 *
 * Issues sitting on a duplicate are moved onto the canonical status of the same name first,
 * so nothing is lost. That is a fixture decision about a disposable database; what should
 * happen to a USER's board with duplicate statuses is #668, and is deliberately not decided
 * here.
 */
async function pruneEmptyDuplicateStatuses(
  apiContext: APIRequestContext,
  projectId: string,
): Promise<void> {
  const res = await apiContext.get(`/api/projects/${projectId}/statuses`);
  if (!res.ok()) return;
  const statuses: { id: string; name: string }[] = await res.json();

  const boardRes = await apiContext.get(`/api/projects/${projectId}/board`);
  if (!boardRes.ok()) return;
  const board: { id: string; name: string; issues: { id: string }[] }[] = await boardRes.json();
  const issueCountByStatusId = new Map(board.map((col) => [col.id, col.issues?.length ?? 0]));

  const seen = new Set<string>();
  for (const status of statuses) {
    if (!seen.has(status.name)) {
      seen.add(status.name);
      continue;
    }
    const canonical = statuses.find((s) => s.name === status.name)!;
    const column = board.find((col) => col.id === status.id);
    const issueCount = issueCountByStatusId.get(status.id) ?? 0;

    // A duplicate that owns issues is moved onto the canonical status of the same name
    // before the duplicate goes. Re-pointing an issue's status is an ordinary API call and
    // the E2E database is disposable, so the fixture can make itself deterministic here —
    // whereas the PRODUCT decision about a user's real board (merge? refuse? migrate?)
    // belongs to #668, not to a test setup.
    for (const issue of (column?.issues ?? []) as { id: string }[]) {
      await apiContext.patch(`/api/issues/${issue.id}`, {
        data: { statusId: canonical.id },
      });
    }

    const del = await apiContext.delete(`/api/projects/${projectId}/statuses/${status.id}`);
    console.log(
      `[global-setup] pruned duplicate status "${status.name}" (${status.id}), moved ${issueCount} issue(s) to ${canonical.id} — ${del.status()}`,
    );
  }
}

async function globalSetup() {
  const apiContext = await request.newContext({ baseURL: `http://127.0.0.1:${serverPort}` });
  await waitForServer(apiContext);

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
