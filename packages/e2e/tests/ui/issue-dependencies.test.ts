import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("Issue dependencies UI", () => {
  let projectId: string;
  let todoStatusId: string;
  const createdIssueIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const activeRes = await request.get(`${SERVER_URL}/api/preferences/active-project`);
    const { projectId: activeId } = await activeRes.json();
    projectId = activeId;

    const statusesRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/statuses`);
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    todoStatusId = todoStatus ? todoStatus.id : statuses[0].id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  async function createIssue(request: Parameters<Parameters<typeof test>[1]>[0]["request"], title: string) {
    const res = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title, statusId: todoStatusId, projectId },
    });
    const { id } = await res.json();
    createdIssueIds.push(id);
    return id as string;
  }

  async function openIssueDetailPanel(page: Parameters<Parameters<typeof test>[1]>[0]["page"], title: string) {
    await page.goto("/");
    await page.waitForSelector("[data-testid='board-stats-bar']", { timeout: 10000 });
    // Click the issue card to open the detail panel
    const card = page.locator("p", { hasText: title }).first();
    await expect(card).toBeVisible({ timeout: 10000 });
    await card.click();
    // Wait for the detail panel to open
    await expect(page.locator("text=Dependencies").first()).toBeVisible({ timeout: 5000 });
  }

  test("Dependencies section is visible in issue detail panel", async ({ page, request }) => {
    const suffix = Date.now().toString(36);
    // Create two issues so the "Add dependency" input renders (it only shows when candidates exist)
    const titleA = `DepTest-Visible-A-${suffix}`;
    const titleB = `DepTest-Visible-B-${suffix}`;
    await createIssue(request, titleA);
    await createIssue(request, titleB);

    await openIssueDetailPanel(page, titleA);

    await expect(page.locator("label", { hasText: "Dependencies" }).first()).toBeVisible();
    await expect(page.locator("input[placeholder*='Add dependency']")).toBeVisible();
  });

  test("Add depends_on dependency creates blue badge", async ({ page, request }) => {
    const suffix = Date.now().toString(36);
    const issueATitle = `DepTest-A-${suffix}`;
    const issueBTitle = `DepTest-B-${suffix}`;
    await createIssue(request, issueATitle);
    await createIssue(request, issueBTitle);

    await openIssueDetailPanel(page, issueATitle);

    // Type in the dependency search box to find issue B
    const depInput = page.locator("input[placeholder*='Add dependency']");
    await depInput.fill(issueBTitle.slice(0, 10));

    // Select the dependency from the dropdown
    const dropdownOption = page.locator("button", { hasText: issueBTitle }).first();
    await expect(dropdownOption).toBeVisible({ timeout: 5000 });
    await dropdownOption.click();

    // The "Depends on" label should appear with a blue badge
    await expect(page.locator("text=Depends on:").first()).toBeVisible({ timeout: 5000 });
    const badge = page.locator("span.bg-blue-50.text-blue-700").first();
    await expect(badge).toBeVisible();
    await expect(badge).toContainText(issueBTitle.slice(0, 10));
  });

  test("Add blocked_by dependency creates red badge", async ({ page, request }) => {
    const suffix = Date.now().toString(36);
    const issueATitle = `DepTest-BlockedBy-A-${suffix}`;
    const issueBTitle = `DepTest-BlockedBy-B-${suffix}`;
    await createIssue(request, issueATitle);
    await createIssue(request, issueBTitle);

    await openIssueDetailPanel(page, issueATitle);

    // Change dependency type to "blocked by"
    const typeSelect = page.locator("select").filter({ hasText: "depends on" });
    await typeSelect.selectOption("blocked_by");

    // Type in the dependency search box
    const depInput = page.locator("input[placeholder*='Add dependency']");
    await depInput.fill(issueBTitle.slice(0, 10));

    const dropdownOption = page.locator("button", { hasText: issueBTitle }).first();
    await expect(dropdownOption).toBeVisible({ timeout: 5000 });
    await dropdownOption.click();

    // The "Blocked by" label should appear with a red badge
    await expect(page.locator("text=Blocked by:").first()).toBeVisible({ timeout: 5000 });
    const badge = page.locator("span.bg-red-50.text-red-700").first();
    await expect(badge).toBeVisible();
  });

  test("Add related_to dependency creates gray badge", async ({ page, request }) => {
    const suffix = Date.now().toString(36);
    const issueATitle = `DepTest-Related-A-${suffix}`;
    const issueBTitle = `DepTest-Related-B-${suffix}`;
    await createIssue(request, issueATitle);
    await createIssue(request, issueBTitle);

    await openIssueDetailPanel(page, issueATitle);

    // Change dependency type to "related to"
    const typeSelect = page.locator("select").filter({ hasText: "depends on" });
    await typeSelect.selectOption("related_to");

    const depInput = page.locator("input[placeholder*='Add dependency']");
    await depInput.fill(issueBTitle.slice(0, 10));

    const dropdownOption = page.locator("button", { hasText: issueBTitle }).first();
    await expect(dropdownOption).toBeVisible({ timeout: 5000 });
    await dropdownOption.click();

    await expect(page.locator("text=Related to:").first()).toBeVisible({ timeout: 5000 });
    const badge = page.locator("span.bg-gray-50.text-gray-700").first();
    await expect(badge).toBeVisible();
  });

  test("Remove dependency badge disappears", async ({ page, request }) => {
    const suffix = Date.now().toString(36);
    const issueATitle = `DepTest-Remove-A-${suffix}`;
    const issueBTitle = `DepTest-Remove-B-${suffix}`;
    const idA = await createIssue(request, issueATitle);
    const idB = await createIssue(request, issueBTitle);

    // Add dependency via API
    await request.post(`${SERVER_URL}/api/issues/${idA}/dependencies`, {
      data: { dependsOnId: idB, type: "related_to" },
    });

    await openIssueDetailPanel(page, issueATitle);

    // Badge should be visible
    await expect(page.locator("text=Related to:").first()).toBeVisible({ timeout: 5000 });
    const badge = page.locator("span.bg-gray-50.text-gray-700").first();
    await expect(badge).toBeVisible();

    // Click the × button inside the badge to remove it
    const removeBtn = badge.locator("button");
    await removeBtn.click();

    // Badge should disappear
    await expect(page.locator("span.bg-gray-50.text-gray-700").first()).not.toBeVisible({ timeout: 5000 });
    await expect(page.locator("text=Related to:").first()).not.toBeVisible();
  });

  test("Cycle detection shows error when creating circular dependency", async ({ page, request }) => {
    const suffix = Date.now().toString(36);
    const issueATitle = `DepTest-CycleA-${suffix}`;
    const issueBTitle = `DepTest-CycleB-${suffix}`;
    const idA = await createIssue(request, issueATitle);
    const idB = await createIssue(request, issueBTitle);

    // A depends_on B
    await request.post(`${SERVER_URL}/api/issues/${idA}/dependencies`, {
      data: { dependsOnId: idB, type: "depends_on" },
    });

    // Now open B's detail panel and try to add A as a depends_on — creating a cycle
    await openIssueDetailPanel(page, issueBTitle);

    const depInput = page.locator("input[placeholder*='Add dependency']");
    await depInput.fill(issueATitle.slice(0, 10));

    const dropdownOption = page.locator("button", { hasText: issueATitle }).first();
    await expect(dropdownOption).toBeVisible({ timeout: 5000 });
    await dropdownOption.click();

    // A toast/error message about the cycle should appear
    await expect(
      page.locator("text=/cycle|circular|would create/i").first()
    ).toBeVisible({ timeout: 5000 });
  });

  test("Blocked filter shows only blocked issues and toggle restores all", async ({ page, request }) => {
    // This flow is already covered in board-stats-bar.test.ts; we add a quick sanity check here
    const suffix = Date.now().toString(36);
    const blockerTitle = `DepBoardBlocker-${suffix}`;
    const blockedTitle = `DepBoardBlocked-${suffix}`;
    const normalTitle = `DepBoardNormal-${suffix}`;

    const blockerId = await createIssue(request, blockerTitle);
    const blockedId = await createIssue(request, blockedTitle);
    await createIssue(request, normalTitle);

    await request.post(`${SERVER_URL}/api/issues/${blockedId}/dependencies`, {
      data: { dependsOnId: blockerId, type: "depends_on" },
    });

    await page.goto("/");
    await page.waitForSelector("[data-testid='board-stats-bar']", { timeout: 10000 });

    await expect(page.locator("p", { hasText: blockerTitle }).first()).toBeVisible();
    await expect(page.locator("p", { hasText: blockedTitle }).first()).toBeVisible();
    await expect(page.locator("p", { hasText: normalTitle }).first()).toBeVisible();

    const blockedToggle = page.locator("button", { hasText: /^Blocked$/ });
    await expect(blockedToggle).toBeVisible();
    await blockedToggle.click();

    await expect(page.locator("p", { hasText: blockedTitle }).first()).toBeVisible();
    await expect(page.locator("p", { hasText: blockerTitle })).not.toBeVisible();
    await expect(page.locator("p", { hasText: normalTitle })).not.toBeVisible();

    await blockedToggle.click();

    await expect(page.locator("p", { hasText: blockerTitle }).first()).toBeVisible();
    await expect(page.locator("p", { hasText: blockedTitle }).first()).toBeVisible();
    await expect(page.locator("p", { hasText: normalTitle }).first()).toBeVisible();
  });
});
