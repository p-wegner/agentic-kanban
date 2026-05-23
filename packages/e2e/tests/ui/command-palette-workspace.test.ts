import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("command palette workspace actions", () => {
  let projectId: string;
  let todoStatusId: string;
  const createdWorkspaceIds: string[] = [];
  const createdIssueIds: string[] = [];

  // Pre-created test data — populated in beforeAll
  let reviewIssue: { issueNumber: number; workspaceId: string; issueTitle: string };
  let mergeIssue: { issueNumber: number; workspaceId: string };
  let reviewTriggerIssue: { issueNumber: number; workspaceId: string };
  let noWsIssueNumber: number;
  let noWsIssueTitle: string;

  test.beforeAll(async ({ request }) => {
    const activePrefRes = await request.get(`${SERVER_URL}/api/preferences/active-project`);
    const activePref = await activePrefRes.json();
    projectId = activePref.projectId;

    const statusesRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/statuses`);
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    todoStatusId = todoStatus ? todoStatus.id : statuses[0].id;

    // Use mock profile so agent exits quickly; disable auto_review/auto_merge so workspace reaches idle
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { claude_profile: "mock", auto_review: "false", auto_merge: "false" },
    });

    // Create all needed workspaces up-front before any page interaction
    const suffix = Date.now().toString(36);

    async function makeWorkspace(prefix: string, idx: number) {
      const title = `${prefix} ${suffix}-${idx}`;
      const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
        data: { title, statusId: todoStatusId, projectId },
      });
      const issue = await issueRes.json();
      createdIssueIds.push(issue.id);

      const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
        data: { issueId: issue.id, branch: `feature/cp-ws-${suffix}-${idx}` },
      });
      const ws = await wsRes.json();
      createdWorkspaceIds.push(ws.id);
      return { issueNumber: issue.issueNumber as number, workspaceId: ws.id as string, issueTitle: title };
    }

    reviewIssue = await makeWorkspace("CPReview", 1);
    mergeIssue = await makeWorkspace("CPMerge", 2);
    reviewTriggerIssue = await makeWorkspace("CPTrigger", 3);

    // Issue with no workspace
    const noWsSuffix = Date.now().toString(36);
    noWsIssueTitle = `CPNoWs ${noWsSuffix}`;
    const noWsRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: noWsIssueTitle, statusId: todoStatusId, projectId },
    });
    const noWsIssue = await noWsRes.json();
    createdIssueIds.push(noWsIssue.id);
    noWsIssueNumber = noWsIssue.issueNumber;

    // Wait for all workspaces to be idle (mock agent exits quickly)
    const deadline = Date.now() + 60000;
    const pendingIds = new Set([
      reviewIssue.workspaceId,
      mergeIssue.workspaceId,
      reviewTriggerIssue.workspaceId,
    ]);
    while (pendingIds.size > 0 && Date.now() < deadline) {
      for (const id of Array.from(pendingIds)) {
        const res = await request.get(`${SERVER_URL}/api/workspaces/${id}`);
        if (res.ok()) {
          const ws = await res.json();
          if (ws?.status === "idle") pendingIds.delete(id);
        }
      }
      if (pendingIds.size > 0) await new Promise((r) => setTimeout(r, 500));
    }
    if (pendingIds.size > 0) {
      throw new Error(`Workspaces did not reach idle: ${[...pendingIds].join(", ")}`);
    }
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdWorkspaceIds) {
      await request.delete(`${SERVER_URL}/api/workspaces/${id}`).catch(() => {});
    }
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`).catch(() => {});
    }
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { claude_profile: "", auto_review: "true", auto_merge: "true" },
    });
  });

  async function openCommandPalette(page: import("@playwright/test").Page) {
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "k",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });
  }

  test("Review action appears in command palette for idle workspace", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    await openCommandPalette(page);

    const input = page.locator('input[placeholder="Search actions..."]');
    await expect(input).toBeVisible({ timeout: 5000 });

    await input.fill("Review");

    // Should show the Review action for this workspace
    const reviewAction = page.locator(`text=Review: #${reviewIssue.issueNumber}`).first();
    await expect(reviewAction).toBeVisible({ timeout: 5000 });

    // Close palette
    await page.keyboard.press("Escape");
  });

  test("Merge action appears in command palette for idle workspace", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    await openCommandPalette(page);

    const input = page.locator('input[placeholder="Search actions..."]');
    await expect(input).toBeVisible({ timeout: 5000 });

    await input.fill("Merge");

    // Should show the Merge action for this workspace (idle status qualifies)
    const mergeAction = page.locator(`text=Merge: #${mergeIssue.issueNumber}`).first();
    await expect(mergeAction).toBeVisible({ timeout: 5000 });

    await page.keyboard.press("Escape");
  });

  test("Review action not present for issue with no workspace", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    await openCommandPalette(page);

    const input = page.locator('input[placeholder="Search actions..."]');
    await expect(input).toBeVisible({ timeout: 5000 });

    // Search by the exact unique issue title — if a Review action existed for this issue
    // it would have label "Review: #N CPNoWs <suffix>" and would match
    await input.fill(noWsIssueTitle);

    // No Review action should exist for this issue (no workspace)
    const count = await page.locator(`text=Review: #${noWsIssueNumber} ${noWsIssueTitle}`).count();
    expect(count).toBe(0);

    await page.keyboard.press("Escape");
  });

  test("triggering Review action from palette transitions workspace to reviewing", async ({ page, request }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await openCommandPalette(page);

    const input = page.locator('input[placeholder="Search actions..."]');
    await expect(input).toBeVisible({ timeout: 5000 });

    await input.fill("Review");

    const reviewAction = page.locator(`text=Review: #${reviewTriggerIssue.issueNumber}`).first();
    await expect(reviewAction).toBeVisible({ timeout: 5000 });

    // Click the action to trigger the review
    await reviewAction.click();

    // Palette closes after clicking
    await expect(input).not.toBeVisible({ timeout: 3000 });

    // Workspace should transition to "reviewing"
    const deadline = Date.now() + 10000;
    let reached = false;
    while (Date.now() < deadline) {
      const res = await request.get(`${SERVER_URL}/api/workspaces/${reviewTriggerIssue.workspaceId}`);
      if (res.ok()) {
        const ws = await res.json();
        if (ws?.status === "reviewing") { reached = true; break; }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(reached).toBe(true);
  });
});
