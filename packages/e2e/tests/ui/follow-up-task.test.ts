import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

// #198 — follow-up task creation in the issue detail panel.
// Source: IssueDetailPanel.tsx (handleCreateFollowUp + showFollowUp UI):
//   collapsed trigger button text: "Create follow-up task"
//   expanded form input: placeholder="Follow-up task title..."
//   submit button text: "Create"
//   on success: POST /api/issues (priority "medium") + a depends_on dependency
//   back to this issue, toast "Follow-up task created", form resets.
// NOTE: this flow is pure API/UI in the panel — it does NOT require a workspace
// or a mock agent profile.
test.describe("Follow-up task creation UI", () => {
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
    // Find any follow-up issue created via the UI (tracked below) — fall back to a
    // title scan so we never leak the generated follow-up issue.
    try {
      const res = await request.get(`${SERVER_URL}/api/issues?projectId=${projectId}`);
      if (res.ok()) {
        const issues: { id: string; title: string }[] = await res.json();
        for (const i of issues) {
          if (i.title.includes(`FollowUpChild ${suffix}`) && !createdIssueIds.includes(i.id)) {
            createdIssueIds.push(i.id);
          }
        }
      }
    } catch {
      /* best-effort cleanup scan */
    }
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  test("creating a follow-up task adds a dependent issue and confirms", async ({ page, request }) => {
    test.setTimeout(60000);
    const parentTitle = `FollowUpParent ${suffix}`;
    const childTitle = `FollowUpChild ${suffix}`;

    const parentId = await withRetry(async () => {
      const res = await request.post(`${SERVER_URL}/api/issues`, {
        data: { title: parentTitle, statusId, projectId },
      });
      if (!res.ok()) throw new Error(`create issue ${res.status()}`);
      return (await res.json()).id;
    }, "create parent issue");
    createdIssueIds.push(parentId);

    await page.goto("/");
    await page.waitForSelector("h2");

    const card = page.locator("p", { hasText: parentTitle }).first();
    await expect(card).toBeAttached({ timeout: 20000 });
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeVisible({ timeout: 5000 });
    await card.click();
    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();

    const panel = page.locator("[data-panel]");

    // Open the follow-up form via its collapsed trigger.
    const trigger = panel.locator("button", { hasText: "Create follow-up task" });
    await expect(trigger).toBeVisible({ timeout: 10000 });
    await trigger.click();

    // Fill the title input (scoped by placeholder) and submit.
    const input = panel.locator("input[placeholder='Follow-up task title...']");
    await expect(input).toBeVisible();
    await input.fill(childTitle);

    // Submit button is the exact-text "Create" (distinct from the now-hidden
    // "Create follow-up task" trigger).
    const createBtn = panel.getByRole("button", { name: "Create", exact: true });
    await expect(createBtn).toBeEnabled();
    await createBtn.click();

    // Success toast confirms creation, and the form collapses back to the trigger.
    await expect(page.locator("text=Follow-up task created").first()).toBeVisible({ timeout: 10000 });
    await expect(panel.locator("button", { hasText: "Create follow-up task" })).toBeVisible({ timeout: 10000 });

    // The follow-up issue now exists in the project, depending on the parent.
    await expect
      .poll(async () => {
        const res = await request.get(`${SERVER_URL}/api/issues?projectId=${projectId}`);
        if (!res.ok()) return false;
        const issues: { id: string; title: string }[] = await res.json();
        const match = issues.find((i) => i.title === childTitle);
        if (match && !createdIssueIds.includes(match.id)) createdIssueIds.push(match.id);
        return Boolean(match);
      }, { timeout: 10000 })
      .toBe(true);
  });
});
