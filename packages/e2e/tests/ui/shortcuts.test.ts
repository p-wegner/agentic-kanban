import { test, expect } from "@playwright/test";

test.describe("Keyboard Shortcuts UI", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");
  });

  test("press ? to show shortcut help overlay", async ({ page }) => {
    // Dispatch the ? keydown event (Playwright may not send ? directly on Windows/MSYS)
    await page.evaluate(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true })),
    );

    // The shortcut help overlay should be visible
    await expect(
      page.locator("h3", { hasText: "Keyboard Shortcuts" }),
    ).toBeVisible({ timeout: 5000 });
  });

  test("shortcut help overlay contains expected shortcuts", async ({ page }) => {
    // Open shortcut help
    await page.evaluate(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true })),
    );

    await expect(
      page.locator("h3", { hasText: "Keyboard Shortcuts" }),
    ).toBeVisible({ timeout: 5000 });

    // Verify all expected shortcut descriptions are present
    await expect(page.locator("text=Focus search")).toBeVisible();
    await expect(page.locator("text=Command palette")).toBeVisible();
    await expect(page.locator("text=Close panel / clear search")).toBeVisible();
    await expect(page.locator("text=Show keyboard shortcuts")).toBeVisible();
    await expect(page.locator("text=Create new issue")).toBeVisible();

    // Verify key badges are shown
    const kbdElements = page.locator("kbd");
    const kbdTexts = await kbdElements.allTextContents();
    expect(kbdTexts).toContain("/");
    expect(kbdTexts).toContain("Escape");
    expect(kbdTexts).toContain("?");
  });

  test("Escape dismisses shortcut help overlay", async ({ page }) => {
    // Open shortcut help
    await page.evaluate(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true })),
    );

    await expect(
      page.locator("h3", { hasText: "Keyboard Shortcuts" }),
    ).toBeVisible({ timeout: 5000 });

    // Press Escape to dismiss
    await page.keyboard.press("Escape");

    // Overlay should be gone
    await expect(
      page.locator("h3", { hasText: "Keyboard Shortcuts" }),
    ).not.toBeVisible();
  });

  test("clicking backdrop dismisses shortcut help overlay", async ({ page }) => {
    // Open shortcut help
    await page.evaluate(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true })),
    );

    await expect(
      page.locator("h3", { hasText: "Keyboard Shortcuts" }),
    ).toBeVisible({ timeout: 5000 });

    // Click the backdrop (the semi-transparent overlay)
    await page.locator(".fixed.inset-0.bg-black\\/30").click();

    // Overlay should be gone
    await expect(
      page.locator("h3", { hasText: "Keyboard Shortcuts" }),
    ).not.toBeVisible();
  });

  test("pressing ? again toggles overlay off", async ({ page }) => {
    // Open shortcut help
    await page.evaluate(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true })),
    );

    await expect(
      page.locator("h3", { hasText: "Keyboard Shortcuts" }),
    ).toBeVisible({ timeout: 5000 });

    // Press ? again to toggle off
    await page.evaluate(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true })),
    );

    // Overlay should be gone
    await expect(
      page.locator("h3", { hasText: "Keyboard Shortcuts" }),
    ).not.toBeVisible();
  });
});
