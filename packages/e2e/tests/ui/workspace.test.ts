import { test, expect } from "@playwright/test";

test.describe("Workspace Panel UI", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Wait for board to load
    await page.waitForSelector('[class*="bg-gray-100"]');
  });

  test("workspace panel opens from issue detail", async ({ page }) => {
    // Click first issue card to open detail panel
    const issueCard = page.locator("text=Workspace test issue").first();
    if (await issueCard.isVisible()) {
      await issueCard.click();

      // Should see workspace management link (text is context-aware: "New Workspace" or "View Workspaces")
      const manageLink = page.locator("text=New Workspace").or(page.locator("text=View Workspaces")).first();
      await expect(manageLink).toBeVisible();

      // Click to open workspace panel
      await manageLink.click();

      // Workspace panel should be visible
      await expect(page.locator("text=Workspaces").first()).toBeVisible();
    }
  });

  test("workspace panel shows create form", async ({ page }) => {
    // Navigate to workspace panel
    const issueCard = page.locator('[class*="cursor-pointer"]').first();
    await issueCard.click();

    const manageLink = page.locator("text=New Workspace").or(page.locator("text=View Workspaces")).first();
    if (await manageLink.isVisible()) {
      await manageLink.click();

      // Click "New Workspace" button
      const newButton = page.locator("text=New Workspace").first();
      if (await newButton.isVisible()) {
        await newButton.click();

        // Should see branch name input
        await expect(
          page.locator('input[placeholder*="feature"]'),
        ).toBeVisible();
      }
    }
  });
});
