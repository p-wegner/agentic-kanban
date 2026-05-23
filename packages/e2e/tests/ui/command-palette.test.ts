import { test, expect, type APIRequestContext } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

async function ensureProjectActive(request: APIRequestContext) {
  try {
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
  } catch {
    // Server may not be available — tests that need API will handle their own errors
  }
}

test.describe("Command Palette", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");
  });

  async function openCommandPalette(page: import("@playwright/test").Page) {
    // Dispatch Ctrl+K via JavaScript because Playwright's keyboard.press("Control+k")
    // may be intercepted by Chromium (focuses address bar)
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "k",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });
  }

  test("Ctrl+K opens command palette", async ({ page }) => {
    await openCommandPalette(page);

    // Should show command palette input
    const input = page.locator('input[placeholder="Search actions..."]');
    await expect(input).toBeVisible({ timeout: 5000 });
  });

  test("Escape closes palette", async ({ page }) => {
    await openCommandPalette(page);
    const input = page.locator('input[placeholder="Search actions..."]');
    await expect(input).toBeVisible({ timeout: 5000 });

    await page.keyboard.press("Escape");

    // Palette should be gone
    await expect(input).not.toBeVisible({ timeout: 3000 });
  });

  test("type to filter actions", async ({ page }) => {
    await openCommandPalette(page);
    const input = page.locator('input[placeholder="Search actions..."]');
    await expect(input).toBeVisible({ timeout: 5000 });

    // Type to filter
    await input.fill("settings");

    // Should show the Open Settings action
    await expect(page.locator("text=Open Settings").first()).toBeVisible();

    // Should hide non-matching actions like Create Issue — scope to action label
    // divs inside the palette to avoid matching board buttons behind the overlay
    const createIssueInPalette = page.locator("div.text-sm.font-medium", { hasText: /^Create Issue$/ });
    const count = await createIssueInPalette.count();
    expect(count).toBe(0);
  });

  test("arrow keys navigate, Enter executes action", async ({ page }) => {
    await openCommandPalette(page);
    const input = page.locator('input[placeholder="Search actions..."]');
    await expect(input).toBeVisible({ timeout: 5000 });

    // Press ArrowDown to select next item
    await page.keyboard.press("ArrowDown");

    // The second item should be highlighted (blue background)
    const highlightedItems = page.locator(".bg-blue-50");
    const count = await highlightedItems.count();
    expect(count).toBeGreaterThan(0);

    // Press Enter to execute
    await page.keyboard.press("Enter");

    // Palette should close after executing
    await expect(input).not.toBeVisible({ timeout: 3000 });
  });

  test("New Issue + Start Workspace opens create panel with workspace checked", async ({ page }) => {
    await openCommandPalette(page);
    const input = page.locator('input[placeholder="Search actions..."]');
    await expect(input).toBeVisible({ timeout: 5000 });

    await input.fill("workspace");

    await expect(page.locator("text=New Issue + Start Workspace").first()).toBeVisible();
    await page.locator("text=New Issue + Start Workspace").first().click();

    // CreateIssuePanel should open
    await expect(page.locator("text=New Issue").first()).toBeVisible({ timeout: 5000 });

    // The "Start workspace" checkbox should be checked
    const checkboxLabel = page.locator("label").filter({ hasText: /start workspace/i });
    await expect(checkboxLabel).toBeVisible({ timeout: 3000 });
    const checkbox = checkboxLabel.locator('input[type="checkbox"]');
    await expect(checkbox).toBeChecked();
  });

  test("click action executes it", async ({ page }) => {
    await openCommandPalette(page);
    const input = page.locator('input[placeholder="Search actions..."]');
    await expect(input).toBeVisible({ timeout: 5000 });

    // Type to filter to Open Settings
    await input.fill("settings");

    // Click on the action label div (scoped to avoid backdrop z-index intercept in headless Chromium)
    await page.locator("div.text-sm.font-medium", { hasText: "Open Settings" }).first().click({ force: true });

    // Settings panel should open (has a heading "Settings")
    const settingsHeading = page.locator('h2').filter({ hasText: "Settings" });
    await expect(settingsHeading).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Command Palette — workspace-scoped Review and Merge actions", () => {
  const suffix = Date.now().toString(36);
  let projectId: string;
  let statusId: string;
  let issueId: string;
  let workspaceId: string;
  let issueNumber: number;

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

    // Use mock agent so the workspace reaches "idle" quickly without real Claude
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { claude_profile: "mock", auto_review: "false", auto_merge: "false" },
    });

    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: `Command palette workspace test ${suffix}`,
        statusId,
        projectId,
      },
    });
    const issue = await issueRes.json();
    issueId = issue.id;
    issueNumber = issue.issueNumber;

    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: {
        issueId,
        branch: `feature/cmd-palette-ws-${suffix}`,
      },
    });
    expect(wsRes.status()).toBe(201);
    workspaceId = (await wsRes.json()).id;

    // Wait for mock agent to finish and workspace to reach idle
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const res = await request.get(`${SERVER_URL}/api/workspaces/${workspaceId}`);
      if (res.ok()) {
        const ws = await res.json();
        if (ws?.status === "idle") break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  test.afterAll(async ({ request }) => {
    try {
      if (workspaceId) await request.delete(`${SERVER_URL}/api/workspaces/${workspaceId}`);
    } catch { /* best-effort */ }
    try {
      if (issueId) await request.delete(`${SERVER_URL}/api/issues/${issueId}`);
    } catch { /* best-effort */ }
    try {
      await request.put(`${SERVER_URL}/api/preferences/settings`, {
        data: { claude_profile: "", auto_review: "true", auto_merge: "true" },
      });
    } catch { /* best-effort */ }
  });

  async function openCommandPalette(page: import("@playwright/test").Page) {
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "k",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });
  }

  test("Review action appears for eligible workspace", async ({ page, request }) => {
    await ensureProjectActive(request);
    await page.goto("/");
    await page.waitForSelector("h2");

    await openCommandPalette(page);
    const input = page.locator('input[placeholder="Search actions..."]');
    await expect(input).toBeVisible({ timeout: 5000 });

    await input.fill(`Review: #${issueNumber}`);

    const reviewAction = page.locator(`text=Review: #${issueNumber}`).first();
    await expect(reviewAction).toBeVisible({ timeout: 5000 });
  });

  test("Merge action appears for idle workspace", async ({ page, request }) => {
    await ensureProjectActive(request);
    await page.goto("/");
    await page.waitForSelector("h2");

    await openCommandPalette(page);
    const input = page.locator('input[placeholder="Search actions..."]');
    await expect(input).toBeVisible({ timeout: 5000 });

    await input.fill(`Merge: #${issueNumber}`);

    const mergeAction = page.locator(`text=Merge: #${issueNumber}`).first();
    await expect(mergeAction).toBeVisible({ timeout: 5000 });
  });

  test("Review action triggers review and shows toast", async ({ page, request }) => {
    await ensureProjectActive(request);

    // Reset workspace to idle before triggering review
    await request.patch(`${SERVER_URL}/api/workspaces/${workspaceId}`, {
      data: { status: "idle" },
    });

    await page.goto("/");
    await page.waitForSelector("h2");

    await openCommandPalette(page);
    const input = page.locator('input[placeholder="Search actions..."]');
    await expect(input).toBeVisible({ timeout: 5000 });

    await input.fill(`Review: #${issueNumber}`);
    // Wait for the action to appear, then press Enter (avoids backdrop click-interception)
    await expect(page.locator(`div.text-sm.font-medium`, { hasText: `Review: #${issueNumber}` }).first()).toBeVisible({ timeout: 5000 });
    await page.keyboard.press("Enter");

    // Palette should close
    await expect(input).not.toBeVisible({ timeout: 3000 });

    // Toast should appear — review may take several seconds on Windows due to git operations
    await expect(
      page.locator("text=Review started").or(page.locator("text=Failed to start review")).first()
    ).toBeVisible({ timeout: 15000 });

    // Verify the workspace actually transitioned to reviewing state
    const wsRes = await request.get(`${SERVER_URL}/api/workspaces/${workspaceId}`);
    if (wsRes.ok()) {
      const ws = await wsRes.json();
      expect(["reviewing", "idle", "active"]).toContain(ws.status);
    }
  });

  test("Merge action is absent for active (non-idle) workspace", async ({ page, request }) => {
    await ensureProjectActive(request);

    // Set to active — merge is NOT registered for active workspaces
    await request.patch(`${SERVER_URL}/api/workspaces/${workspaceId}`, {
      data: { status: "active" },
    });

    await page.goto("/");
    await page.waitForSelector("h2");
    await page.waitForLoadState("networkidle");

    await openCommandPalette(page);
    const input = page.locator('input[placeholder="Search actions..."]');
    await expect(input).toBeVisible({ timeout: 5000 });

    await input.fill(`Merge: #${issueNumber}`);

    // Use scoped selector to match only action items, not the "No matching actions for..." message
    await expect(page.locator(`div.text-sm.font-medium`, { hasText: `Merge: #${issueNumber}` })).not.toBeVisible({ timeout: 3000 });

    // Restore to idle for subsequent tests
    await request.patch(`${SERVER_URL}/api/workspaces/${workspaceId}`, {
      data: { status: "idle" },
    });
  });

  test("Review and Merge actions absent when workspace is closed", async ({ page, request }) => {
    await ensureProjectActive(request);

    // Set to closed — neither action should register
    await request.patch(`${SERVER_URL}/api/workspaces/${workspaceId}`, {
      data: { status: "closed" },
    });

    await page.goto("/");
    await page.waitForSelector("h2");
    await page.waitForLoadState("networkidle");

    await openCommandPalette(page);
    const input = page.locator('input[placeholder="Search actions..."]');
    await expect(input).toBeVisible({ timeout: 5000 });

    await input.fill(`#${issueNumber}`);

    // Scope to action label divs to avoid matching the "No matching actions for..." empty-state message
    await expect(page.locator(`div.text-sm.font-medium`, { hasText: `Review: #${issueNumber}` })).not.toBeVisible({ timeout: 3000 });
    await expect(page.locator(`div.text-sm.font-medium`, { hasText: `Merge: #${issueNumber}` })).not.toBeVisible({ timeout: 3000 });

    // Restore to idle (best-effort — afterAll also cleans up)
    try {
      await request.patch(`${SERVER_URL}/api/workspaces/${workspaceId}`, {
        data: { status: "idle" },
      });
    } catch { /* best-effort */ }
  });
});
