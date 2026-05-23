import { test, expect, type APIRequestContext } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

async function ensureProjectActive(request: APIRequestContext) {
  const res = await request.get(`${SERVER_URL}/api/projects`);
  if (!res.ok()) return;
  const projects = await res.json();
  const proj =
    projects.find((p: { name: string }) => p.name === "agentic-kanban") ??
    projects[0];
  if (!proj) return;
  await request.put(`${SERVER_URL}/api/preferences/active-project`, {
    data: { projectId: proj.id },
  });
}

async function openAllWorkspacesPanel(page: import("@playwright/test").Page) {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true }),
    ),
  );
  await expect(
    page.locator("h2", { hasText: "All Workspaces" }),
  ).toBeVisible({ timeout: 5000 });
}

test.describe("Ready for Merge badge — All Workspaces Panel", () => {
  let projectId: string;
  let statusId: string;
  let issueId: string;
  let workspaceId: string;
  const suffix = Date.now().toString(36);

  test.beforeAll(async ({ request }) => {
    await ensureProjectActive(request);

    const projectsRes = await request.get(`${SERVER_URL}/api/projects`);
    const projects = await projectsRes.json();
    const proj =
      projects.find((p: { name: string }) => p.name === "agentic-kanban") ??
      projects[0];
    projectId = proj.id;

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todoStatus ? todoStatus.id : statuses[0].id;

    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: `Ready-badge UI test ${suffix}`,
        statusId,
        projectId,
      },
    });
    issueId = (await issueRes.json()).id;

    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: {
        issueId,
        branch: `feature/ready-badge-ui-${suffix}`,
      },
    });
    expect(wsRes.status()).toBe(201);
    workspaceId = (await wsRes.json()).id;
  });

  test.afterAll(async ({ request }) => {
    try {
      if (workspaceId) {
        await request.delete(`${SERVER_URL}/api/workspaces/${workspaceId}`);
      }
    } catch { /* best-effort cleanup */ }
    try {
      if (issueId) {
        await request.delete(`${SERVER_URL}/api/issues/${issueId}`);
      }
    } catch { /* best-effort cleanup */ }
  });

  test("Ready to merge badge is absent before marking", async ({
    page,
    request,
  }) => {
    await ensureProjectActive(request);
    await page.goto("/");
    await openAllWorkspacesPanel(page);

    // Search for our specific workspace by branch to scope the assertion
    const searchInput = page.locator(
      'input[placeholder*="Search by title or branch"]',
    );
    await searchInput.fill(`ready-badge-ui-${suffix}`);
    await page.waitForTimeout(300);

    const row = page.locator("div", { hasText: `ready-badge-ui-${suffix}` }).first();
    await expect(row).toBeVisible({ timeout: 5000 });
    await expect(
      row.locator("span", { hasText: "Ready to merge" }),
    ).not.toBeVisible();
  });

  test("Ready to merge badge appears in All Workspaces panel after marking", async ({
    page,
    request,
  }) => {
    // Mark the workspace ready
    const markRes = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/ready-for-merge`,
    );
    expect(markRes.ok()).toBeTruthy();

    await ensureProjectActive(request);
    await page.goto("/");
    await openAllWorkspacesPanel(page);

    // Filter to our workspace
    const searchInput = page.locator(
      'input[placeholder*="Search by title or branch"]',
    );
    await searchInput.fill(`ready-badge-ui-${suffix}`);
    await page.waitForTimeout(300);

    await expect(
      page.locator("span", { hasText: "Ready to merge" }),
    ).toBeVisible({ timeout: 5000 });
  });

  test("workspace without readyForMerge shows no badge", async ({
    page,
    request,
  }) => {
    // Wait for server to be available (may have restarted)
    for (let i = 0; i < 6; i++) {
      try {
        const probe = await request.get(`${SERVER_URL}/api/projects`);
        if (probe.ok()) break;
      } catch {
        await page.waitForTimeout(5000);
      }
    }

    // Create a second workspace that is NOT marked ready
    const issueRes2 = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: `Badge-absent test ${suffix}`,
        statusId,
        projectId,
      },
    });
    const issueId2 = (await issueRes2.json()).id;

    const wsRes2 = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: {
        issueId: issueId2,
        branch: `feature/no-badge-${suffix}`,
      },
    });
    expect(wsRes2.status()).toBe(201);
    const workspaceId2 = (await wsRes2.json()).id;

    try {
      await ensureProjectActive(request);
      await page.goto("/");
      await openAllWorkspacesPanel(page);

      const searchInput = page.locator(
        'input[placeholder*="Search by title or branch"]',
      );
      await searchInput.fill(`no-badge-${suffix}`);
      await page.waitForTimeout(300);

      const row = page.locator("div", { hasText: `no-badge-${suffix}` }).first();
      await expect(row).toBeVisible({ timeout: 5000 });
      await expect(
        row.locator("span", { hasText: "Ready to merge" }),
      ).not.toBeVisible();
    } finally {
      try { await request.delete(`${SERVER_URL}/api/workspaces/${workspaceId2}`); } catch { /* best-effort */ }
      try { await request.delete(`${SERVER_URL}/api/issues/${issueId2}`); } catch { /* best-effort */ }
    }
  });
});
