import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("Expandable issue creation panel", () => {
  let projectId: string;
  const createdIssueIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get(`${SERVER_URL}/api/projects`);
    const projects = await projectsRes.json();
    projectId = projects[0].id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  test("open inline form then expand to full-screen panel", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    const firstColumn = page.locator(".bg-gray-100.rounded-lg").first();
    await firstColumn.locator("button[title='Add issue']").click();
    await expect(page.locator("form")).toBeVisible();

    await page.locator("button[title='Expand form']").click();

    // Full-screen panel should be visible with "New Issue" header
    const panel = page.locator(".fixed.right-0.top-0");
    await expect(panel).toBeVisible();
    await expect(panel.locator("h2")).toContainText("New Issue");
  });

  test("panel shows all expected fields", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    const firstColumn = page.locator(".bg-gray-100.rounded-lg").first();
    await firstColumn.locator("button[title='Add issue']").click();
    await page.locator("button[title='Expand form']").click();

    const panel = page.locator(".fixed.right-0.top-0");
    await expect(panel.locator("input[placeholder='Issue title']")).toBeVisible();
    await expect(panel.locator("textarea")).toBeVisible();
    await expect(panel.locator("select").first()).toBeVisible();

    // "Start workspace" checkbox is shown when canStartWorkspace is true
    // It may or may not be visible depending on project setup — check label text
    const labels = await panel.locator("label").allTextContents();
    // Priority select options should include Low/Medium/High/Critical
    await panel.locator("select").first().selectOption("high");
    const selectedVal = await panel.locator("select").first().inputValue();
    expect(selectedVal).toBe("high");

    // Close panel
    await panel.locator("button[title='Close']").click();
    await expect(panel).not.toBeVisible();
  });

  test("panel state is carried over from inline form", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    const firstColumn = page.locator(".bg-gray-100.rounded-lg").first();
    await firstColumn.locator("button[title='Add issue']").click();

    const form = page.locator("form");
    await form.locator("input[placeholder='Issue title']").fill("Carried Over Title");
    await form.locator("textarea[placeholder='Description (optional)']").fill("Carried description");
    await form.locator("select").selectOption("high");

    await page.locator("button[title='Expand form']").click();

    const panel = page.locator(".fixed.right-0.top-0");
    await expect(panel.locator("input[placeholder='Issue title']")).toHaveValue("Carried Over Title");
    await expect(panel.locator("textarea")).toHaveValue("Carried description");
    await expect(panel.locator("select").first()).toHaveValue("high");

    // Close panel
    await panel.locator("button[title='Close']").click();
  });

  test("fill and submit creates issue", async ({ page, request }) => {
    const suffix = Date.now().toString(36);
    const title = `Expanded Panel Issue ${suffix}`;

    await page.goto("/");
    await page.waitForSelector("h2");

    const firstColumn = page.locator(".bg-gray-100.rounded-lg").first();
    await firstColumn.locator("button[title='Add issue']").click();
    await page.locator("button[title='Expand form']").click();

    const panel = page.locator(".fixed.right-0.top-0");
    await panel.locator("input[placeholder='Issue title']").fill(title);
    await panel.locator("textarea").fill("Full-screen panel test description");
    await panel.locator("select").first().selectOption("critical");

    await panel.locator('button:has-text("Add Issue")').click();

    // Panel should close after submission
    await expect(panel).not.toBeVisible();

    // Issue should appear on the board
    await expect(page.locator("p", { hasText: title }).first()).toBeVisible();

    // Capture created issue ID for cleanup
    const issuesRes = await request.get(`${SERVER_URL}/api/issues?projectId=${projectId}`);
    const issues = await issuesRes.json();
    const created = issues.find((i: { title: string }) => i.title === title);
    if (created) createdIssueIds.push(created.id);
  });

  test("Start workspace checkbox shows workspace sub-options when checked", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    const firstColumn = page.locator(".bg-gray-100.rounded-lg").first();
    await firstColumn.locator("button[title='Add issue']").click();
    await page.locator("button[title='Expand form']").click();

    const panel = page.locator(".fixed.right-0.top-0");

    // "Start workspace" checkbox — only visible when canStartWorkspace=true
    const startWsLabel = panel.locator("label", { hasText: "Start workspace" });
    const isVisible = await startWsLabel.isVisible();

    if (isVisible) {
      await startWsLabel.locator("input[type='checkbox']").check();

      // Sub-options should appear
      await expect(panel.locator("label", { hasText: /Plan mode/ })).toBeVisible();
      await expect(panel.locator("label", { hasText: /Skip auto/ })).toBeVisible();
    }

    await panel.locator("button[title='Close']").click();
  });

  test("Cancel button closes the panel", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    const firstColumn = page.locator(".bg-gray-100.rounded-lg").first();
    await firstColumn.locator("button[title='Add issue']").click();
    await page.locator("button[title='Expand form']").click();

    const panel = page.locator(".fixed.right-0.top-0");
    await expect(panel).toBeVisible();

    await panel.locator("button", { hasText: "Cancel" }).click();
    await expect(panel).not.toBeVisible();
  });

  test("backdrop click closes the panel", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    const firstColumn = page.locator(".bg-gray-100.rounded-lg").first();
    await firstColumn.locator("button[title='Add issue']").click();
    await page.locator("button[title='Expand form']").click();

    const panel = page.locator(".fixed.right-0.top-0");
    await expect(panel).toBeVisible();

    // Click the backdrop (left side, outside the panel)
    const backdrop = page.locator(".fixed.inset-0.bg-black\\/20");
    await backdrop.click({ position: { x: 10, y: 10 } });
    await expect(panel).not.toBeVisible();
  });

  test("Escape key closes the panel", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    const firstColumn = page.locator(".bg-gray-100.rounded-lg").first();
    await firstColumn.locator("button[title='Add issue']").click();
    await page.locator("button[title='Expand form']").click();

    const panel = page.locator(".fixed.right-0.top-0");
    await expect(panel).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(panel).not.toBeVisible();
  });

  test("submit button is disabled when title is empty", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    const firstColumn = page.locator(".bg-gray-100.rounded-lg").first();
    await firstColumn.locator("button[title='Add issue']").click();
    await page.locator("button[title='Expand form']").click();

    const panel = page.locator(".fixed.right-0.top-0");
    const submitBtn = panel.locator('button:has-text("Add Issue")');
    await expect(submitBtn).toBeDisabled();

    await panel.locator("input[placeholder='Issue title']").fill("Some title");
    await expect(submitBtn).toBeEnabled();

    await panel.locator("button[title='Close']").click();
  });
});
