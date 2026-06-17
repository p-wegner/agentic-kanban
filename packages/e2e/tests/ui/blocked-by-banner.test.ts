import { test, expect, type APIRequestContext } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

// #185 — blocked-by summary banner in the issue detail panel.
// Source: IssueDetailPanel.tsx — the banner renders when the issue has outgoing
// (issueId === this issue) depends_on/blocked_by deps whose target status is NOT
// in RESOLVED = ["done","cancelled","ai reviewed"]:
//   container: div.bg-amber-50 ... with text "Blocked by N unresolved dependency/dependencies"
//   each blocked dep listed as <li> with the blocker's #number + title.
//
// Dependency direction (cf. issue-dependencies.test.ts): POST to
// /api/issues/<B>/dependencies { dependsOnId: <A>, type: "depends_on" } makes the
// record's issueId === B, so B (the one we open) shows the banner about blocker A.
test.describe("Blocked-by banner UI", () => {
  let projectId: string;
  let todoStatusId: string;
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
    todoStatusId = todo ? todo.id : statuses[0].id;

    suffix = Date.now().toString(36);
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  async function createIssue(
    request: APIRequestContext,
    title: string,
  ): Promise<string> {
    return withRetry(async () => {
      const res = await request.post(`${SERVER_URL}/api/issues`, {
        data: { title, statusId: todoStatusId, projectId },
      });
      if (!res.ok()) throw new Error(`create issue ${res.status()}`);
      const id = (await res.json()).id as string;
      createdIssueIds.push(id);
      return id;
    }, "create issue");
  }

  test("opening a blocked issue shows the blocked-by banner naming the blocker", async ({ page, request }) => {
    test.setTimeout(60000);
    // A is the unfinished blocker (stays in Todo). B depends on A.
    const blockerTitle = `BlockBannerBlocker ${suffix}`;
    const blockedTitle = `BlockBannerBlocked ${suffix}`;
    const blockerId = await createIssue(request, blockerTitle);
    const blockedId = await createIssue(request, blockedTitle);

    // B depends_on A → record.issueId === B → B is the blocked one.
    await withRetry(async () => {
      const res = await request.post(`${SERVER_URL}/api/issues/${blockedId}/dependencies`, {
        data: { dependsOnId: blockerId, type: "depends_on" },
      });
      if (!res.ok()) throw new Error(`create dependency ${res.status()}`);
      return res.json();
    }, "create dependency");

    await page.goto("/");
    await page.waitForSelector("h2");

    const card = page.locator("p", { hasText: blockedTitle }).first();
    await expect(card).toBeAttached({ timeout: 20000 });
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeVisible({ timeout: 5000 });
    await card.click();
    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();

    const panel = page.locator("[data-panel]");

    // The amber banner with the "Blocked by 1 unresolved dependency" heading.
    const banner = panel.locator("div.bg-amber-50", { hasText: "Blocked by" }).first();
    await expect(banner).toBeVisible({ timeout: 10000 });
    await expect(banner).toContainText("Blocked by 1 unresolved dependency");

    // The blocker issue is listed by title inside the banner.
    await expect(banner.locator("li", { hasText: blockerTitle })).toBeVisible();
  });

  test("an issue with no unresolved blockers shows no banner", async ({ page, request }) => {
    test.setTimeout(60000);
    const soloTitle = `BlockBannerSolo ${suffix}`;
    await createIssue(request, soloTitle);

    await page.goto("/");
    await page.waitForSelector("h2");

    const card = page.locator("p", { hasText: soloTitle }).first();
    await expect(card).toBeAttached({ timeout: 20000 });
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeVisible({ timeout: 5000 });
    await card.click();
    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();

    const panel = page.locator("[data-panel]");
    // Title is rendered, so the panel body is loaded; the banner must be absent.
    await expect(panel.locator("h3", { hasText: soloTitle })).toBeVisible({ timeout: 10000 });
    await expect(panel.locator("div.bg-amber-50", { hasText: "Blocked by" })).toHaveCount(0);
  });
});
