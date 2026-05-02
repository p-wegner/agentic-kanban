import { test, expect } from "@playwright/test";

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
    const input = page.locator('input[placeholder="Type a command..."]');
    await expect(input).toBeVisible({ timeout: 5000 });
  });

  test("Escape closes palette", async ({ page }) => {
    await openCommandPalette(page);
    const input = page.locator('input[placeholder="Type a command..."]');
    await expect(input).toBeVisible({ timeout: 5000 });

    await page.keyboard.press("Escape");

    // Palette should be gone
    await expect(input).not.toBeVisible({ timeout: 3000 });
  });

  test("type to filter actions", async ({ page }) => {
    await openCommandPalette(page);
    const input = page.locator('input[placeholder="Type a command..."]');
    await expect(input).toBeVisible({ timeout: 5000 });

    // Type to filter
    await input.fill("settings");

    // Should show the Open Settings action
    await expect(page.locator("text=Open Settings").first()).toBeVisible();

    // Should hide non-matching actions like Create Issue
    const createIssueItems = page.locator("text=Create Issue");
    const count = await createIssueItems.count();
    expect(count).toBe(0);
  });

  test("arrow keys navigate, Enter executes action", async ({ page }) => {
    await openCommandPalette(page);
    const input = page.locator('input[placeholder="Type a command..."]');
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

  test("click action executes it", async ({ page }) => {
    await openCommandPalette(page);
    const input = page.locator('input[placeholder="Type a command..."]');
    await expect(input).toBeVisible({ timeout: 5000 });

    // Type to filter to Open Settings
    await input.fill("settings");

    // Click the Open Settings action
    await page.locator("text=Open Settings").first().click();

    // Settings panel should open (has a heading "Settings")
    const settingsHeading = page.locator('h2').filter({ hasText: "Settings" });
    await expect(settingsHeading).toBeVisible({ timeout: 5000 });
  });
});
