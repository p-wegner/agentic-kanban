import { request } from "@playwright/test";

async function globalSetup() {
  // Ensure a project exists for E2E tests
  // Use the actual repo path so git-info detection works
  const apiContext = await request.newContext({ baseURL: "http://localhost:3001" });

  // Check if projects already exist
  const res = await apiContext.get("/api/projects");
  const projects = await res.json();

  if (projects.length === 0) {
    // Register this project's own repo as a test project
    const registerRes = await apiContext.post("/api/projects", {
      data: {
        name: "E2E Test Project",
        repoPath: "F:\\projects\\agentic_kanban",
      },
    });

    if (registerRes.status() === 201) {
      const project = await registerRes.json();

      // Create default statuses
      const statuses = [
        { name: "Todo", sortOrder: 0 },
        { name: "In Progress", sortOrder: 1 },
        { name: "In Review", sortOrder: 2 },
        { name: "Done", sortOrder: 3 },
        { name: "Cancelled", sortOrder: 4 },
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
