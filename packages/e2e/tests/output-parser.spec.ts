import { test, expect } from "@playwright/test";

test.describe("Output parser verification", () => {
  test("renders parsed stream-json output correctly", async ({ page }) => {
    await page.goto("http://localhost:5173");

    // Wait for board to load
    await page.waitForSelector('[data-testid="board"]', { timeout: 10000 }).catch(() => {});
    await page.waitForSelector("text=Verify output parser", { timeout: 10000 });

    // Click the "Verify output parser" issue card
    await page.locator("text=Verify output parser").first().click();

    // Wait for detail panel
    await page.waitForSelector("text=Issue Details", { timeout: 5000 });

    // Click "View Workspaces"
    await page.locator("text=View Workspaces").click();

    // Wait for workspace panel
    await page.waitForSelector("text=Workspaces — Verify output parser", { timeout: 5000 });

    // Expand the workspace (click on the branch name)
    await page.locator("text=feature/test-parser").click();

    // Wait for terminal output to render
    await page.waitForSelector(".bg-gray-900", { timeout: 5000 });

    // Take a screenshot for visual verification
    await page.screenshot({ path: "test-results/output-parser.png", fullPage: false });

    // Verify key parsed elements are visible:

    // 1. Init event — session initialization
    await expect(page.locator("text=Session initialized")).toBeVisible();

    // 2. Model info from init
    await expect(page.locator("text=glm-5.1")).toBeVisible();

    // 3. Assistant text
    await expect(page.locator("text=Let me explore the current state")).toBeVisible();

    // 4. Tool use events
    await expect(page.locator("text=Tool: Read")).toBeVisible();
    await expect(page.locator("text=Tool: PowerShell")).toBeVisible();

    // 5. Tool results (user messages with tool_result content)
    await expect(page.locator("text=Result: unknown").first()).toBeVisible();

    // 6. Error results
    await expect(page.locator("text=Error: unknown").first()).toBeVisible();

    // 7. Final result
    await expect(page.locator("text=Completed")).toBeVisible();

    // 8. Cost/timing info
    await expect(page.locator(/Cost: \$0\.\d+/)).toBeVisible();

    // 9. MCP server info
    await expect(page.locator("text=deepwiki")).toBeVisible();

    // 10. stream-json badge
    await expect(page.locator("text=stream-json")).toBeVisible();

    // 11. Process exit
    await expect(page.locator("text=Process exited with code 0")).toBeVisible();

    // Verify NO raw JSON dumps visible (the old bug)
    await expect(page.locator('pre:has-text(\'"type":"user"\')')).toHaveCount(0);
  });
});
