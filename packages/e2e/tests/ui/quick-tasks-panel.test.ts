import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

const BUILTIN_SKILLS = [
  "board-navigator",
  "code-review",
  "dependency-analyzer",
  "ticket-enhancer",
];

// The panel has a fixed h3 "Quick Tasks" header — scope to that element
const quickTasksPanel = (page: import("@playwright/test").Page) =>
  page.locator("h3", { hasText: "Quick Tasks" });

async function openQuickTasksPanel(page: import("@playwright/test").Page) {
  const tasksBtn = page.locator("button", { hasText: "Tasks" });
  await expect(tasksBtn).toBeVisible({ timeout: 10000 });
  await tasksBtn.click();
  await expect(quickTasksPanel(page)).toBeVisible({ timeout: 5000 });
}

test.describe("Quick Tasks panel", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");
  });

  test("Tasks button opens the Quick Tasks panel", async ({ page }) => {
    const tasksBtn = page.locator("button", { hasText: "Tasks" });
    await expect(tasksBtn).toBeVisible({ timeout: 10000 });
    await tasksBtn.click();

    await expect(quickTasksPanel(page)).toBeVisible({ timeout: 5000 });
  });

  test("keyboard shortcut 'q' opens the Quick Tasks panel", async ({ page }) => {
    // Ensure focus is not on an input before pressing shortcut
    await page.locator("body").click();
    await page.keyboard.press("q");

    await expect(quickTasksPanel(page)).toBeVisible({ timeout: 5000 });
  });

  test("panel lists built-in skills with names", async ({ page }) => {
    await openQuickTasksPanel(page);

    for (const skillName of BUILTIN_SKILLS) {
      await expect(page.locator("button", { hasText: skillName }).first()).toBeVisible({ timeout: 5000 });
    }
  });

  test("each skill shows a description", async ({ page }) => {
    await openQuickTasksPanel(page);

    // Skills are rendered as buttons containing a p.text-xs.text-gray-500 for description
    // Wait for skills to load (loading state disappears)
    await expect(page.locator("text=Loading skills...")).not.toBeVisible({ timeout: 5000 });

    // At least one skill button should contain description text
    const descriptionEls = page.locator("p.text-xs.text-gray-500");
    await expect(descriptionEls.first()).toBeVisible({ timeout: 5000 });
    const count = await descriptionEls.count();
    expect(count).toBeGreaterThan(0);
  });

  test("custom task prompt button reveals textarea", async ({ page }) => {
    await openQuickTasksPanel(page);

    const customBtn = page.locator("button", { hasText: /\+ Custom task prompt/i });
    await expect(customBtn).toBeVisible();
    await customBtn.click();

    const textarea = page.locator("textarea").first();
    await expect(textarea).toBeVisible();

    await textarea.fill("My custom task prompt");
    await expect(textarea).toHaveValue("My custom task prompt");
  });

  test("close button closes the panel", async ({ page }) => {
    await openQuickTasksPanel(page);

    // Click the × close button (rendered as &times; entity)
    const closeBtn = page.locator("button").filter({ hasText: /^×$/ });
    await closeBtn.click();

    await expect(quickTasksPanel(page)).not.toBeVisible({ timeout: 3000 });
  });

  test("clicking backdrop closes the panel", async ({ page }) => {
    await openQuickTasksPanel(page);

    // Click top-left corner of the viewport — outside the centered modal
    await page.mouse.click(10, 10);

    await expect(quickTasksPanel(page)).not.toBeVisible({ timeout: 3000 });
  });

  test("context toggle shows and hides context textarea", async ({ page }) => {
    await openQuickTasksPanel(page);

    const contextBtn = page.locator("button", { hasText: "+ context" });
    await expect(contextBtn).toBeVisible();
    await contextBtn.click();

    // Context textarea should appear
    const contextArea = page.locator("textarea[placeholder*='context']").first();
    await expect(contextArea).toBeVisible({ timeout: 3000 });

    // Toggle again to hide
    const hideContextBtn = page.locator("button", { hasText: "− context" });
    await expect(hideContextBtn).toBeVisible();
    await hideContextBtn.click();
    await expect(contextArea).not.toBeVisible();
  });

  test("custom skill created via API appears in panel", async ({ page, request }) => {
    const skillName = `QuickTest-${Date.now().toString(36)}`;
    const description = "E2E test custom skill";

    // Get active project
    const activeRes = await request.get(`${SERVER_URL}/api/preferences/active-project`);
    const { projectId } = await activeRes.json();

    // Create a custom skill
    const createRes = await request.post(`${SERVER_URL}/api/agent-skills`, {
      data: { name: skillName, description, prompt: "Test prompt content", projectId },
    });
    expect(createRes.ok()).toBeTruthy();
    const skill = await createRes.json();

    try {
      await openQuickTasksPanel(page);

      await expect(page.locator("button", { hasText: skillName }).first()).toBeVisible({ timeout: 5000 });
    } finally {
      await request.delete(`${SERVER_URL}/api/agent-skills/${skill.id}`);
    }
  });
});
