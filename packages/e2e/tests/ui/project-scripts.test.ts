import { test, expect, type APIRequestContext } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

async function getActiveOrFirstProjectId(request: APIRequestContext): Promise<string> {
  const prefRes = await request.get(`${SERVER_URL}/api/preferences/active-project`);
  const activeProjectId = prefRes.ok() ? ((await prefRes.json()).projectId as string | null | undefined) : null;
  const projectsRes = await request.get(`${SERVER_URL}/api/projects`);
  if (!projectsRes.ok()) throw new Error(`Could not list projects: ${projectsRes.status()}`);
  const projects: Array<{ id: string }> = await projectsRes.json();
  const projectId = activeProjectId && projects.some((project) => project.id === activeProjectId)
    ? activeProjectId
    : projects[0]?.id;
  if (!projectId) throw new Error("No project is available for the script shortcut smoke test");
  await request.put(`${SERVER_URL}/api/preferences/active-project`, { data: { projectId } });
  return projectId;
}

async function deleteScriptByName(request: APIRequestContext, projectId: string, name: string) {
  try {
    const listRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/scripts`);
    if (!listRes.ok()) return;
    const scripts: Array<{ id: string; name: string }> = await listRes.json();
    await Promise.all(
      scripts
        .filter((script) => script.name === name)
        .map((script) => request.delete(`${SERVER_URL}/api/projects/${projectId}/scripts/${script.id}`)),
    );
  } catch {
    // Best-effort cleanup. The smoke path uses unique names, so a transient
    // server restart should not fail the feature assertion.
  }
}

test.describe("Project script shortcuts", () => {
  test("creates and runs a harmless project script from the UI", async ({ page, request }) => {
    const projectId = await getActiveOrFirstProjectId(request);
    const scriptName = `Smoke ${Date.now()}`;
    await deleteScriptByName(request, projectId, scriptName);
    const createRes = await request.post(`${SERVER_URL}/api/projects/${projectId}/scripts`, {
      data: {
        name: scriptName,
        description: "Smoke-test command",
        command: "node -e \"console.log('ak-script-smoke')\"",
        cwdMode: "project",
      },
    });
    expect(createRes.ok()).toBeTruthy();

    try {
      await page.goto("/");
      await expect(page.getByRole("button", { name: "Scripts" })).toBeVisible();
      await page.locator('button[title="Project scripts"]').click();
      await page.locator("button", { hasText: scriptName }).click();

      await expect(page.locator("pre", { hasText: "ak-script-smoke" })).toBeVisible({ timeout: 15000 });
      await expect(page.locator("text=Exit 0")).toBeVisible({ timeout: 15000 });
    } finally {
      await deleteScriptByName(request, projectId, scriptName);
    }
  });
});
