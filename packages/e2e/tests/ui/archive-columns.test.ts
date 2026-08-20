import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";
import { boardColumn, completedToggle, issueCard, narrowBoardTo } from "../helpers/board-ui.js";

test.describe("Archive Column Group UI", () => {
  let projectId: string;
  let doneStatusId: string;
  let cancelledStatusId: string;
  let suffix: string;
  const createdIssueIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    projectId = await getE2EProjectId(request);

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const doneStatus = statuses.find((s: { name: string }) => s.name === "Done");
    const cancelledStatus = statuses.find((s: { name: string }) => s.name === "Cancelled");
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");

    if (!doneStatus) throw new Error("[archive-columns] 'Done' status not found in project — is the board seeded correctly?");
    if (!cancelledStatus) throw new Error("[archive-columns] 'Cancelled' status not found in project — is the board seeded correctly?");
    if (!todoStatus) throw new Error("[archive-columns] 'Todo' status not found in project — is the board seeded correctly?");

    doneStatusId = doneStatus.id;
    cancelledStatusId = cancelledStatus.id;

    suffix = Date.now().toString(36);
    const doneRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: `ArchiveDoneTest ${suffix}`,
        statusId: doneStatusId,
        projectId,
      },
    });
    createdIssueIds.push((await doneRes.json()).id);

    const cancelledRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: `ArchiveCancelledTest ${suffix}`,
        statusId: cancelledStatusId,
        projectId,
      },
    });
    createdIssueIds.push((await cancelledRes.json()).id);
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  test("board shows Completed button with archive counts", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    const toggle = completedToggle(page);
    await expect(toggle).toBeVisible();
    // The bar summarises the archive rather than listing status columns: a total, then a
    // done/cancelled breakdown. Both of this suite's fixtures are archived, so both parts
    // of the breakdown are present.
    await expect(toggle).toContainText("Completed");
    await expect(toggle).toContainText("done");
    await expect(toggle).toContainText("cancelled");
  });

  test("expanding Completed reveals the archived cards", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    // Done and Cancelled are NOT board columns any more — they are folded into the
    // Completed group. The old version of this spec scraped every <h2> and asserted they
    // appeared as column headings after expanding, i.e. it described the pre-CompletedGrid
    // UI; it could only ever fail, and it failed as "expected list to contain Done".
    await expect(boardColumn(page, "Done")).toHaveCount(0);
    await expect(boardColumn(page, "Cancelled")).toHaveCount(0);
    await expect(page.locator("[data-testid='completed-grid']")).toHaveCount(0);

    await narrowBoardTo(page, suffix);
    await completedToggle(page).click();

    await expect(page.locator("[data-testid='completed-grid']")).toBeVisible();
    await expect(issueCard(page, `ArchiveDoneTest ${suffix}`)).toBeVisible({ timeout: 5000 });
    await expect(issueCard(page, `ArchiveCancelledTest ${suffix}`)).toBeVisible({ timeout: 5000 });
  });

  test("clicking Completed again collapses the grid", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");
    await narrowBoardTo(page, suffix);

    const grid = page.locator("[data-testid='completed-grid']");
    await completedToggle(page).click();
    await expect(grid).toBeVisible({ timeout: 5000 });

    // The collapse bar stays in flow while the grid is open, so it is still the control.
    await completedToggle(page).click();
    await expect(grid).toHaveCount(0);
  });

  test("the archive is not a set of extra columns", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    const columns = page.locator("[data-testid='board-column']").filter({ visible: true });
    const before = await columns.count();
    expect(before).toBeGreaterThanOrEqual(3);

    await narrowBoardTo(page, suffix);
    await completedToggle(page).click();
    await expect(page.locator("[data-testid='completed-grid']")).toBeVisible();

    // Expanding the archive opens a card GRID; it does not add columns. The old spec
    // asserted the opposite ("there should be MORE columns visible"), which is what the
    // archive used to do.
    expect(await columns.count()).toBe(before);
  });
});
