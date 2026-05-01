import { test, expect } from "@playwright/test";

test.describe("Board UI", () => {
  test("shows 5 kanban columns", async ({ page }) => {
    await page.goto("/");

    // Wait for the board to load
    await page.waitForSelector("h2");

    const columns = page.locator("h2");
    await expect(columns).toHaveCount(5);

    // Verify column names
    const names = await columns.allTextContents();
    expect(names.map((n) => n.replace(/\s*\d+$/, "").trim())).toEqual([
      "Todo",
      "In Progress",
      "In Review",
      "Done",
      "Cancelled",
    ]);
  });

  test("shows header with title", async ({ page }) => {
    await page.goto("/");
    const header = page.locator("header h1");
    await expect(header).toHaveText("Agentic Kanban");
  });
});
