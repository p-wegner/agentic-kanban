import { request } from "@playwright/test";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

export const E2E_STATE_FILE = resolve(import.meta.dirname, ".e2e-run-state.json");

const serverPort = Number(process.env.SERVER_PORT) || 3001;

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

  // Always create a fresh, dedicated E2E project for this test run.
  // Never reuse an existing project (it might be a real production project).
  const runId = Date.now().toString(36);
  const registerRes = await apiContext.post("/api/projects", {
    data: {
      name: `E2E Test Project ${runId}`,
      repoPath,
    },
  });

  if (registerRes.status() !== 201) {
    console.error("[global-setup] Failed to create E2E test project:", await registerRes.text());
    await apiContext.dispose();
    return;
  }

  const project = await registerRes.json();

  // Create default statuses for the E2E project.
  const statuses = [
    { name: "Todo", sortOrder: 0 },
    { name: "In Progress", sortOrder: 1 },
    { name: "In Review", sortOrder: 2 },
    { name: "AI Reviewed", sortOrder: 3 },
    { name: "Done", sortOrder: 4 },
    { name: "Cancelled", sortOrder: 5 },
  ];
  for (const status of statuses) {
    await apiContext.post(`/api/projects/${project.id}/statuses`, {
      data: status,
    });
  }

  // Set as the active project so all tests that read the active-project preference
  // automatically use this isolated project.
  await apiContext.put("/api/preferences/active-project", {
    data: { projectId: project.id },
  });

  // Persist the run state so global-teardown can clean up reliably.
  writeFileSync(
    E2E_STATE_FILE,
    JSON.stringify({ e2eProjectId: project.id, previousActiveProjectId }),
    "utf8",
  );

  console.log(`[global-setup] Created E2E project "${project.name}" (${project.id})`);

  await apiContext.dispose();
}

export default globalSetup;
