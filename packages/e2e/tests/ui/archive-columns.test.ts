import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("Archive Column Group UI", () => {
  let projectId: string;
  let doneStatusId: string;
  let cancelledStatusId: string;
  let todoStatusId: string;

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get(`${SERVER_URL}/api/projects`);
    const projects = await projectsRes.json();
    projectId = projects[0].id;

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const doneStatus = statuses.find((s: { name: string }) => s.name === "Done");
    const cancelledStatus = statuses.find((s: { name: string }) => s.name === "Cancelled");
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    doneStatusId = doneStatus ? doneStatus.id : statuses[3].id;
    cancelledStatusId = cancelledStatus ? cancelledStatus.id : statuses[4].id;
    todoStatusId = todoStatus ? todoStatus.id : statuses[0].id;

    // Create issues in Done and Cancelled columns so they have counts
    const suffix = Date.now().toString(36);
    await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: `ArchiveDoneTest ${suffix}`,
        statusId: doneStatusId,
        projectId,
      },
    });
    await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: `ArchiveCancelledTest ${suffix}`,
        statusId: cancelledStatusId,
        projectId,
      },
    });
  });

  test("board shows Completed button with archive counts", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    // The "Completed" button should be visible in collapsed state
    const completedBtn = page.locator("button", { hasText: "Completed" }).first();
    await expect(completedBtn).toBeVisible();

    // It should show "Done" and "Cancelled" column names with counts
    await expect(completedBtn.locator("text=Done").first()).toBeVisible();
    await expect(completedBtn.locator("text=Cancelled").first()).toBeVisible();
  });

  test("click Completed to expand archive columns", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    // Done and Cancelled columns should NOT be visible initially (they are inside collapsed group)
    const allH2Before = await page.locator("h2").allTextContents();
    const namesBefore = allH2Before.map((n) => n.replace(/\s*\d+$/, "").trim());
    // Active columns should be visible
    expect(namesBefore).toContain("Todo");
    expect(namesBefore).toContain("In Progress");
    expect(namesBefore).toContain("In Review");
    // Done/Cancelled columns should NOT be in the h2 list (collapsed)
    expect(namesBefore).not.toContain("Done");
    expect(namesBefore).not.toContain("Cancelled");

    // Click the "Completed" button to expand
    await page.locator("button", { hasText: "Completed" }).click();

    // Now Done and Cancelled columns should appear as full columns with h2 headings
    const allH2After = await page.locator("h2").allTextContents();
    const namesAfter = allH2After.map((n) => n.replace(/\s*\d+$/, "").trim());
    expect(namesAfter).toContain("Done");
    expect(namesAfter).toContain("Cancelled");

    // Archived issue cards should be visible
    await expect(
      page.locator("p", { hasText: "ArchiveDoneTest" }).first(),
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.locator("p", { hasText: "ArchiveCancelledTest" }).first(),
    ).toBeVisible({ timeout: 5000 });
  });

  test("click Completed again to collapse archive columns", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    // Expand first
    await page.locator("button", { hasText: "Completed" }).click();

    // Verify expanded — Done h2 should be visible (use .first() to handle extra test statuses)
    await expect(
      page.locator("h2", { hasText: /^Done\d*$/ }).first(),
    ).toBeVisible({ timeout: 5000 });

    // Now click the toggle button again (it now shows a down arrow + "Completed" text)
    await page.locator("button", { hasText: "Completed" }).first().click();

    // Should collapse back — Done/Cancelled h2s gone (the ones from the archive group)
    // Use the default status names exactly — "Done" followed by only a count number
    await expect(
      page.locator("h2", { hasText: /^Done\d*$/ }).first(),
    ).not.toBeVisible({ timeout: 5000 });
    await expect(
      page.locator("h2", { hasText: /^Cancelled\d*$/ }).first(),
    ).not.toBeVisible({ timeout: 5000 });
  });

  test("archive columns are separate from active columns", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    // Active columns (Todo, In Progress, In Review) are always visible
    const activeCols = page.locator(".bg-gray-100.rounded-lg");
    const activeCount = await activeCols.count();
    expect(activeCount).toBeGreaterThanOrEqual(3);

    // Expand archive
    await page.locator("button", { hasText: "Completed" }).click();

    // After expanding, there should be MORE columns visible
    const allColsAfter = page.locator(".bg-gray-100.rounded-lg");
    const allCountAfter = await allColsAfter.count();
    expect(allCountAfter).toBeGreaterThan(activeCount);
  });
});
