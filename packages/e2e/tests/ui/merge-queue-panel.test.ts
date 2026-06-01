import { test, expect, type APIRequestContext } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

async function ensureProjectActive(request: APIRequestContext): Promise<string> {
  const res = await request.get(`${SERVER_URL}/api/projects`);
  expect(res.ok(), `GET /api/projects failed with ${res.status()}`).toBe(true);
  const projects: { id: string; name: string }[] = await res.json();
  const proj = projects.find((p) => p.name === "agentic-kanban") ?? projects[0];
  if (!proj) throw new Error("No project is registered");

  const prefRes = await request.put(`${SERVER_URL}/api/preferences/active-project`, {
    data: { projectId: proj.id },
  });
  expect(prefRes.ok(), `PUT active-project failed with ${prefRes.status()}`).toBe(true);
  return proj.id;
}

test.describe("Merge Queue Panel", () => {
  let projectId = "";
  let issueId = "";
  let workspaceId = "";
  let originalClaudeProfile = "";
  const suffix = Date.now().toString(36);
  const title = `Merge queue smoke ${suffix}`;
  const branch = `feature/merge-queue-smoke-${suffix}`;

  test.beforeAll(async ({ request }) => {
    projectId = await ensureProjectActive(request);

    const settingsRes = await request.get(`${SERVER_URL}/api/preferences/settings`);
    expect(settingsRes.ok(), `GET settings failed with ${settingsRes.status()}`).toBe(true);
    originalClaudeProfile = ((await settingsRes.json()).claude_profile ?? "") as string;
    const mockSettingsRes = await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { claude_profile: "mock" },
    });
    expect(mockSettingsRes.ok(), `PUT mock settings failed with ${mockSettingsRes.status()}`).toBe(true);

    const statusesRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/statuses`);
    expect(statusesRes.ok(), `GET statuses failed with ${statusesRes.status()}`).toBe(true);
    const statuses: { id: string; name: string }[] = await statusesRes.json();
    const inReview = statuses.find((s) => s.name === "In Review") ?? statuses[0];
    if (!inReview) throw new Error("Project has no statuses");

    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title,
        statusId: inReview.id,
        projectId,
        skipAutoReview: true,
      },
    });
    expect(issueRes.status(), `POST issue failed with ${issueRes.status()}`).toBe(201);
    issueId = (await issueRes.json()).id;

    const workspaceRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: {
        issueId,
        branch,
        requiresReview: false,
      },
    });
    expect(workspaceRes.status(), `POST workspace failed with ${workspaceRes.status()}`).toBe(201);
    workspaceId = (await workspaceRes.json()).id;

    const readyRes = await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/ready-for-merge`);
    expect(readyRes.ok(), `POST ready-for-merge failed with ${readyRes.status()}`).toBe(true);
  });

  test.afterAll(async ({ request }) => {
    if (workspaceId) await request.delete(`${SERVER_URL}/api/workspaces/${workspaceId}`).catch(() => {});
    if (issueId) await request.delete(`${SERVER_URL}/api/issues/${issueId}`).catch(() => {});
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { claude_profile: originalClaudeProfile },
    }).catch(() => {});
  });

  test("shows In Review workspace risk and merge controls", async ({ page, request }) => {
    await ensureProjectActive(request);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.locator("button", { hasText: "Queue" }).click();

    const panel = page.locator("h2", { hasText: "Merge Queue" }).locator("..").locator("..");
    await expect(page.locator("h2", { hasText: "Merge Queue" })).toBeVisible({ timeout: 5000 });
    await expect(panel.locator("text=Workspace")).toBeVisible();
    await expect(panel.locator("text=Risk")).toBeVisible();
    await expect(panel.locator("text=Ready")).toBeVisible();
    await expect(panel.locator("text=Age")).toBeVisible();
    await expect(panel.locator("text=" + title)).toBeVisible({ timeout: 5000 });
    await expect(panel.locator("text=" + branch)).toBeVisible();
    await expect(panel.locator("span", { hasText: "Ready" }).first()).toBeVisible();
    await expect(panel.locator("button", { hasText: "Open Detail" }).first()).toBeVisible();
    await expect(panel.locator("button", { hasText: "Merge" }).first()).toBeVisible();
  });
});
