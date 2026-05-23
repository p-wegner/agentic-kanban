import { request } from "@playwright/test";
import { resolve } from "node:path";

const serverPort = Number(process.env.SERVER_PORT) || 3001;

async function globalSetup() {
  const apiContext = await request.newContext({ baseURL: `http://127.0.0.1:${serverPort}` });

  // Resolve the actual monorepo root (e2e package is at packages/e2e)
  const repoPath = resolve(import.meta.dirname, "..", "..");

  // Check if a project with the correct path already exists
  const res = await apiContext.get("/api/projects");
  const projects = await res.json();

  const existing = projects.find(
    (p: { repoPath: string }) =>
      p.repoPath === repoPath || p.repoPath === repoPath.replace(/\//g, "\\"),
  );

  if (existing) {
    // Ensure it's the active project
    await apiContext.put("/api/preferences/active-project", {
      data: { projectId: existing.id },
    });
  } else {
    // Register the monorepo as a test project
    const registerRes = await apiContext.post("/api/projects", {
      data: {
        name: "E2E Test Project",
        repoPath,
      },
    });

    if (registerRes.status() === 201) {
      const project = await registerRes.json();

      // Create default statuses
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

      // Set as active project
      await apiContext.put("/api/preferences/active-project", {
        data: { projectId: project.id },
      });
    }
  }

  await apiContext.dispose();
}

export default globalSetup;
