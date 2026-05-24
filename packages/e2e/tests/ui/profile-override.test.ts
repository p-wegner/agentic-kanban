import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("Claude profile override — expanded create panel", () => {
  let projectId: string;
  let statusId: string;
  const createdIssueIds: string[] = [];
  const createdWorkspaceIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get(`${SERVER_URL}/api/projects`);
    const projects = await projectsRes.json();
    projectId = projects[0].id;

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todo = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todo ? todo.id : statuses[0].id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdWorkspaceIds) {
      await request.delete(`${SERVER_URL}/api/workspaces/${id}`);
    }
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  test("Profile override field appears when Start workspace is checked", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    const firstColumn = page.locator(".bg-gray-100.rounded-xl").first();
    await firstColumn.locator("button[title='Add issue']").click();
    await page.locator("button[title='Expand form']").click();

    const panel = page.locator(".fixed.right-0.top-0");
    await expect(panel).toBeVisible();

    // Profile override select should not be visible before Start workspace is checked
    await expect(
      panel.locator("label", { hasText: "Profile override" }),
    ).not.toBeVisible();

    // Check Start workspace
    const startWsLabel = panel.locator("label", { hasText: "Start workspace" });
    const canStartWorkspace = await startWsLabel.isVisible();
    if (!canStartWorkspace) {
      test.skip();
      return;
    }
    await startWsLabel.locator("input[type='checkbox']").check();

    // Profile override select should now be visible
    await expect(
      panel.locator("label", { hasText: "Profile override" }),
    ).toBeVisible();
    await expect(
      panel.locator("select").filter({
        has: page.locator("option", { hasText: /Default/ }),
      }),
    ).toBeVisible();

    await panel.locator("button[title='Close']").click();
  });

  test("Profile override field selects an available profile", async ({
    request,
    page,
  }) => {
    const profilesRes = await request.get(
      `${SERVER_URL}/api/preferences/claude-profiles`,
    );
    expect(profilesRes.status()).toBe(200);
    const { profiles } = await profilesRes.json();
    expect(profiles.length).toBeGreaterThan(0);

    await page.goto("/");
    await page.waitForSelector("h2");

    const firstColumn = page.locator(".bg-gray-100.rounded-xl").first();
    await firstColumn.locator("button[title='Add issue']").click();
    await page.locator("button[title='Expand form']").click();

    const panel = page.locator(".fixed.right-0.top-0");
    const startWsLabel = panel.locator("label", { hasText: "Start workspace" });
    const canStartWorkspace = await startWsLabel.isVisible();
    if (!canStartWorkspace) {
      test.skip();
      return;
    }
    await startWsLabel.locator("input[type='checkbox']").check();

    const profileSelect = panel.locator("select").filter({
      has: page.locator("option", { hasText: /Default/ }),
    });
    await profileSelect.selectOption(`claude:${profiles[0]}`);
    await expect(profileSelect).toHaveValue(`claude:${profiles[0]}`);

    await profileSelect.selectOption("");
    await expect(profileSelect).toHaveValue("");

    await panel.locator("button[title='Close']").click();
  });

  test("Profile override field exposes Copilot as a tagged provider option", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    const firstColumn = page.locator(".bg-gray-100.rounded-xl").first();
    await firstColumn.locator("button[title='Add issue']").click();
    await page.locator("button[title='Expand form']").click();

    const panel = page.locator(".fixed.right-0.top-0");
    const startWsLabel = panel.locator("label", { hasText: "Start workspace" });
    const canStartWorkspace = await startWsLabel.isVisible();
    if (!canStartWorkspace) {
      test.skip();
      return;
    }
    await startWsLabel.locator("input[type='checkbox']").check();

    const profileSelect = panel.locator("select").filter({
      has: page.locator("option[value='copilot:default']"),
    });
    await expect(profileSelect).toBeVisible();
    await profileSelect.selectOption("copilot:default");
    await expect(profileSelect).toHaveValue("copilot:default");

    await panel.locator("button[title='Close']").click();
  });

  test("Workspace API stores claudeProfile when passed directly", async ({
    request,
  }) => {
    const suffix = Date.now().toString(36);
    const profileName = `direct-profile-${suffix}`;

    // Create issue first
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: `Profile WS direct ${suffix}`,
        statusId,
        projectId,
        skipAutoReview: true,
      },
    });
    expect(issueRes.status()).toBe(201);
    const issue = await issueRes.json();
    createdIssueIds.push(issue.id);

    // Create workspace with claudeProfile override
    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: {
        issueId: issue.id,
        branch: `feature/e2e-profile-${suffix}`,
        claudeProfile: profileName,
        requiresReview: false,
      },
    });
    expect(wsRes.status()).toBe(201);
    const ws = await wsRes.json();
    createdWorkspaceIds.push(ws.id);

    expect(ws.id).toBeDefined();

    // Verify via workspace GET endpoint directly — this workspace should have the profile stored
    const wsDetailRes = await request.get(`${SERVER_URL}/api/workspaces/${ws.id}`);
    expect(wsDetailRes.status()).toBe(200);
    const wsDetail = await wsDetailRes.json();
    expect(wsDetail.claudeProfile).toBe(profileName);

    // Also verify via board endpoint — workspaceSummary.main.claudeProfile is included there
    const boardRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/board`,
    );
    expect(boardRes.status()).toBe(200);
    // Board returns array of columns: [{ id, name, issues: [...] }]
    const columns: any[] = await boardRes.json();
    const allIssues: any[] = columns.flatMap((col: any) => col.issues ?? []);
    const targetIssue = allIssues.find((i: any) => i.id === issue.id);
    expect(targetIssue).toBeDefined();
    expect(targetIssue.workspaceSummary?.main?.claudeProfile).toBe(profileName);
  });
});

test.describe("Claude profile override — workspace panel select", () => {
  let projectId: string;
  let statusId: string;
  const createdIssueIds: string[] = [];
  const createdWorkspaceIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get(`${SERVER_URL}/api/projects`);
    const projects = await projectsRes.json();
    projectId = projects[0].id;

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const inProgress = statuses.find(
      (s: { name: string }) => s.name === "In Progress",
    );
    statusId = inProgress ? inProgress.id : statuses[0].id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdWorkspaceIds) {
      await request.delete(`${SERVER_URL}/api/workspaces/${id}`);
    }
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  test("Profile dropdown only renders when profiles are available", async ({
    request,
    page,
  }) => {
    // Check if any Claude profiles are available; Copilot default is always present.
    const profilesRes = await request.get(
      `${SERVER_URL}/api/preferences/claude-profiles`,
    );
    expect(profilesRes.status()).toBe(200);
    const { profiles } = await profilesRes.json();

    // Create a workspace and open its panel.
    const suffix = Date.now().toString(36);
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: `Profile panel test ${suffix}`,
        statusId,
        projectId,
        skipAutoReview: true,
      },
    });
    const issue = await issueRes.json();
    createdIssueIds.push(issue.id);

    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: {
        issueId: issue.id,
        branch: `feature/profile-panel-${suffix}`,
        requiresReview: false,
      },
    });
    const ws = await wsRes.json();
    createdWorkspaceIds.push(ws.id);

    await page.goto("/");
    await page.waitForSelector("h2");

    // Find and click the issue card to open the issue detail panel
    const issueCard = page.locator("p", { hasText: issue.title }).first();
    await expect(issueCard).toBeVisible({ timeout: 5000 });
    await issueCard.click();

    // Wait for issue detail panel to appear
    const issuePanel = page.locator(".fixed.right-0.top-0");
    await expect(issuePanel).toBeVisible({ timeout: 5000 });

    // Click on the workspace button in the issue detail panel to open workspace panel
    // The workspace button shows the branch name
    const workspaceBtn = issuePanel.locator("button").filter({ hasText: ws.branch }).first();
    await expect(workspaceBtn).toBeVisible({ timeout: 5000 });
    await workspaceBtn.click();

    // The workspace panel should now be visible; wait for it
    const wsPanel = page.locator(".fixed.right-0.top-0");
    await expect(wsPanel).toBeVisible({ timeout: 5000 });

    // Wait a bit for the profiles to fetch and render, then open the dropdown
    await page.waitForTimeout(1000);
    const moreOptionsBtn = wsPanel.locator("button[title='More options']").last();
    await moreOptionsBtn.click({ timeout: 5000 });

    // Profile select should now be visible in the dropdown
    await expect(
      wsPanel.locator("label", { hasText: "Profile" }),
    ).toBeVisible({ timeout: 5000 });
    const profileSelect = wsPanel.locator("select").filter({
      has: page.locator("option", { hasText: /Default/ }),
    });
    await expect(profileSelect).toBeVisible();

    // Verify all discovered Claude profiles appear as tagged options.
    for (const p of profiles) {
      await expect(profileSelect.locator(`option[value="claude:${p}"]`)).toBeAttached();
    }
    await expect(profileSelect.locator('option[value="copilot:default"]')).toBeAttached();
  });

  test("Quick launch sends provider-tagged Copilot profile", async ({
    request,
    page,
  }) => {
    const suffix = Date.now().toString(36);
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: `Copilot quick launch ${suffix}`,
        statusId,
        projectId,
        skipAutoReview: true,
      },
    });
    expect(issueRes.status()).toBe(201);
    const issue = await issueRes.json();
    createdIssueIds.push(issue.id);

    let workspacePayload: any = null;
    await page.route("**/api/workspaces", async (route) => {
      if (route.request().method() === "POST") {
        workspacePayload = route.request().postDataJSON();
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            id: `mock-ws-${suffix}`,
            issueId: issue.id,
            branch: `feature/mock-${suffix}`,
            status: "idle",
            workingDir: null,
            baseBranch: null,
            isDirect: false,
            planMode: false,
            includeVisualProof: false,
            readyForMerge: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto("/");
    await page.waitForSelector("h2");

    const issueCard = page.locator("p", { hasText: issue.title }).first();
    await expect(issueCard).toBeVisible({ timeout: 5000 });
    await issueCard.click();

    const issuePanel = page.locator(".fixed.right-0.top-0");
    await expect(issuePanel).toBeVisible({ timeout: 5000 });
    await issuePanel.locator("button", { hasText: "Custom options..." }).click();

    const wsPanel = page.locator(".fixed.right-0.top-0").last();
    await expect(wsPanel.locator("text=No workspaces yet")).toBeVisible({ timeout: 5000 });
    await wsPanel.locator("button[title='More options']").click();

    const profileSelect = wsPanel.locator("select").filter({
      has: page.locator("option[value='copilot:default']"),
    });
    await expect(profileSelect).toBeVisible();
    await profileSelect.selectOption("copilot:default");
    await wsPanel.locator("button", { hasText: /^New Workspace$/ }).last().click();

    await expect.poll(() => workspacePayload).not.toBeNull();
    expect(workspacePayload.profile).toEqual({ provider: "copilot", name: "default" });
    expect(workspacePayload.claudeProfile).toBeUndefined();
  });
});
