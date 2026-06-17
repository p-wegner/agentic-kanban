import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

// #174 — "Skip auto AI code review" toggle in the issue detail EDIT form.
// Source: IssueDetailPanel.tsx
//   - pencil header button: aria-label="Edit issue" (enters edit mode)
//   - checkbox label span: "Skip auto AI code review" (checkbox -> skipAutoReview state)
//   - Save header button: aria-label="Save issue"
//   - after save in view mode a badge "Skip review" renders when issue.skipAutoReview is true
test.describe("Skip auto review toggle UI", () => {
  let projectId: string;
  let statusId: string;
  let suffix: string;
  const createdIssueIds: string[] = [];

  async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    throw new Error(`[${label}] failed after 3 attempts: ${String(lastErr)}`);
  }

  test.beforeAll(async ({ request }) => {
    projectId = await withRetry(() => getE2EProjectId(request), "getE2EProjectId");

    const statuses = await withRetry(async () => {
      const res = await request.get(`${SERVER_URL}/api/projects/${projectId}/statuses`);
      if (!res.ok()) throw new Error(`statuses ${res.status()}`);
      return res.json();
    }, "fetch statuses");
    const todo = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todo ? todo.id : statuses[0].id;

    suffix = Date.now().toString(36);
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  test("toggling skip-auto-review in edit form persists and shows the badge", async ({ page, request }) => {
    test.setTimeout(60000);
    const title = `SkipReview ${suffix}`;
    const issueId = await withRetry(async () => {
      const res = await request.post(`${SERVER_URL}/api/issues`, {
        data: { title, description: "skip review test", priority: "medium", statusId, projectId },
      });
      if (!res.ok()) throw new Error(`create issue ${res.status()}`);
      return (await res.json()).id;
    }, "create issue");
    createdIssueIds.push(issueId);

    await page.goto("/");
    await page.waitForSelector("h2");

    const card = page.locator("p", { hasText: title }).first();
    await expect(card).toBeAttached({ timeout: 20000 });
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeVisible({ timeout: 5000 });
    await card.click();
    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();

    const panel = page.locator("[data-panel]");

    // Enter edit mode via the pencil button (aria-label="Edit issue").
    await panel.getByRole("button", { name: "Edit issue" }).click();
    // Save button confirms we're in edit mode (only rendered while editing).
    await expect(panel.getByRole("button", { name: "Save issue", exact: true })).toBeVisible();

    // The skip-auto-review checkbox: scope by its label text span.
    const skipLabel = panel.locator("label", { hasText: "Skip auto AI code review" });
    await expect(skipLabel).toBeVisible();
    const skipCheckbox = skipLabel.locator("input[type='checkbox']");
    await expect(skipCheckbox).not.toBeChecked();

    await skipCheckbox.check();
    await expect(skipCheckbox).toBeChecked();

    // Save and return to view mode.
    await panel.getByRole("button", { name: "Save issue", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Edit issue" })).toBeVisible({ timeout: 10000 });

    // View mode shows the "Skip review" badge once skipAutoReview is persisted.
    await expect(panel.locator("span", { hasText: "Skip review" }).first()).toBeVisible({ timeout: 10000 });

    // Confirm the server persisted skipAutoReview = true.
    await expect
      .poll(async () => {
        const res = await request.get(`${SERVER_URL}/api/issues/${issueId}`);
        if (!res.ok()) return null;
        return (await res.json()).skipAutoReview;
      }, { timeout: 10000 })
      .toBe(true);

    // Re-enter edit mode and untoggle to verify the checkbox reflects persisted state.
    await panel.getByRole("button", { name: "Edit issue" }).click();
    await expect(panel.getByRole("button", { name: "Save issue", exact: true })).toBeVisible();
    const skipCheckbox2 = panel
      .locator("label", { hasText: "Skip auto AI code review" })
      .locator("input[type='checkbox']");
    await expect(skipCheckbox2).toBeChecked();
    await skipCheckbox2.uncheck();
    await panel.getByRole("button", { name: "Save issue", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Edit issue" })).toBeVisible({ timeout: 10000 });

    await expect
      .poll(async () => {
        const res = await request.get(`${SERVER_URL}/api/issues/${issueId}`);
        if (!res.ok()) return null;
        return (await res.json()).skipAutoReview;
      }, { timeout: 10000 })
      .toBe(false);
  });
});
