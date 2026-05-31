import { test, expect } from "@playwright/test";

test.describe("Keyboard Shortcuts UI", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.locator("#search-input").waitFor({ state: "visible" });
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

    // Verify view-switch shortcuts are shown
    await expect(page.locator("text=Switch to Board")).toBeVisible();
    await expect(page.locator("text=Switch to Graph")).toBeVisible();
    await expect(page.locator("text=Switch to Table")).toBeVisible();
    await expect(page.locator("text=Switch to Workflows")).toBeVisible();
    await expect(page.locator("text=Open Quick Tasks panel")).toBeVisible();
    await expect(page.locator("text=Open settings")).toBeVisible();

    // Verify key badges are shown
    const kbdElements = page.locator("kbd");
    const kbdTexts = await kbdElements.allTextContents();
    expect(kbdTexts).toContain("/");
    expect(kbdTexts).toContain("Escape");
    expect(kbdTexts).toContain("?");
    expect(kbdTexts).toContain("b");
    expect(kbdTexts).toContain("g");
    expect(kbdTexts).toContain("t");
    expect(kbdTexts).toContain("u");
    expect(kbdTexts).toContain("q");
    expect(kbdTexts).toContain("s");
  });

  test("shortcut help is context-aware for Butler", async ({ page }) => {
    await page.evaluate(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "i", bubbles: true })),
    );
    await expect.poll(
      () => page.evaluate(() => localStorage.getItem("kanban-board-view")),
      { timeout: 5000 },
    ).toBe("butler");

    await page.evaluate(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true })),
    );

    await expect(page.locator("h3", { hasText: "Keyboard Shortcuts" })).toBeVisible({ timeout: 5000 });
    await expect(page.locator("text=Butler shortcuts")).toBeVisible();
    await expect(page.locator("text=Clear Butler context").first()).toBeVisible();
    await expect(page.locator("text=Cycle Butler profile")).toBeVisible();
    await expect(page.locator("text=Cycle Butler model")).toBeVisible();
    await expect(page.locator("text=New Butler session")).toBeVisible();
  });

  test("single-key shortcuts do not fire while typing in search", async ({ page }) => {
    await page.evaluate(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true })),
    );
    await expect.poll(
      () => page.evaluate(() => localStorage.getItem("kanban-board-view")),
      { timeout: 5000 },
    ).toBe("table");

    await page.locator("#search-input").evaluate((input) => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true }));
    });

    expect(await page.evaluate(() => localStorage.getItem("kanban-board-view"))).toBe("table");

    await page.evaluate(() => {
      const editable = document.createElement("div");
      editable.contentEditable = "true";
      document.body.appendChild(editable);
      editable.focus();
      editable.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true }));
      editable.remove();
    });
    expect(await page.evaluate(() => localStorage.getItem("kanban-board-view"))).toBe("table");
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

    // Click the backdrop (top-left corner, outside the centered dialog)
    await page.mouse.click(10, 10);

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
