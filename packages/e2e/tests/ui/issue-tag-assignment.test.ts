import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

test.describe("Issue tag assignment from detail panel", () => {
  let projectId: string;
  let todoStatusId: string;
  const createdIssueIds: string[] = [];
  const createdTagIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    projectId = await getE2EProjectId(request);

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find(
      (s: { name: string }) => s.name === "Todo",
    );
    if (!todoStatus) {
      throw new Error(
        `No "Todo" status found in project ${projectId}. Available: ${statuses.map((s: { name: string }) => s.name).join(", ")}`,
      );
    }
    todoStatusId = todoStatus.id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request
        .delete(`${SERVER_URL}/api/issues/${id}`)
        .catch(() => {});
    }
    for (const id of createdTagIds) {
      await request.delete(`${SERVER_URL}/api/tags/${id}`).catch(() => {});
    }
  });

  async function createIssue(
    request: import("@playwright/test").APIRequestContext,
    title: string,
  ) {
    const res = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title,
        description: "Test issue for tag assignment",
        statusId: todoStatusId,
        projectId,
      },
    });
    if (!res.ok()) {
      throw new Error(
        `Failed to create issue "${title}": ${res.status()} ${await res.text()}`,
      );
    }
    const { id } = await res.json();
    createdIssueIds.push(id);
    return id as string;
  }

  async function createTag(
    request: import("@playwright/test").APIRequestContext,
    name: string,
    color = "#6366F1",
  ) {
    const res = await request.post(`${SERVER_URL}/api/tags`, {
      data: { name, color },
    });
    if (!res.ok()) {
      throw new Error(
        `Failed to create tag "${name}": ${res.status()} ${await res.text()}`,
      );
    }
    const { id } = await res.json();
    createdTagIds.push(id);
    return id as string;
  }

  /**
   * Find the tag <select> by evaluating all selects' option values.
   * Retries until found or timeout (React may not have re-rendered yet).
   */
  async function findTagSelect(
    panel: import("@playwright/test").Locator,
    tid: string,
    timeout = 10000,
  ) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const index = await panel.evaluate((el, tid) => {
        const selects = el.querySelectorAll("select");
        for (let i = 0; i < selects.length; i++) {
          if (Array.from(selects[i].options).some((opt) => opt.value === tid)) {
            return i;
          }
        }
        return -1;
      }, tid);
      if (index >= 0) return panel.locator("select").nth(index);
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  test("assign and remove tags from issue detail panel", async ({
    page,
    request,
  }) => {
    test.setTimeout(90000);

    // ── Setup: create tag + issue ──
    const suffix = Date.now().toString(36);
    const tagName = `panel-tag-${suffix}`;
    const issueTitle = `TagPanelTest-${suffix}`;
    const tagId = await createTag(request, tagName, "#6366F1");
    const issueId = await createIssue(request, issueTitle);

    // ── Navigate to board and open detail panel ──
    await page.goto("/");
    await page.waitForSelector("h2", { timeout: 15000 });

    const card = page.getByLabel(`Open issue ${issueTitle}`);
    await expect(card).toBeVisible({ timeout: 15000 });

    // Set up response listeners BEFORE clicking
    const tagsLoaded = page.waitForResponse(
      (resp) =>
        resp.url().includes("/api/tags") &&
        !resp.url().includes("/issues/") &&
        resp.request().method() === "GET" &&
        resp.ok(),
    );
    const issueTagsLoaded = page.waitForResponse(
      (resp) =>
        resp.url().match(/\/api\/issues\/[^/]+\/tags$/) &&
        resp.request().method() === "GET" &&
        resp.ok(),
    );

    await card.click();

    const panel = page.locator("[data-panel]").filter({
      has: page.getByRole("heading", { name: "Issue Details" }),
    });
    await expect(panel).toBeVisible({ timeout: 10000 });

    // Wait for tag data to finish loading
    await Promise.all([tagsLoaded, issueTagsLoaded]);

    // ── Step 1: Verify "Tags" section is visible ──
    await expect(
      panel.locator("label", { hasText: /^Tags$/ }),
    ).toBeVisible();

    // ── Step 2: Assign the tag via the dropdown ──
    const tagSelect = await findTagSelect(panel, tagId);
    if (!tagSelect) {
      const selectInfo = await panel.evaluate((el) => ({
        count: el.querySelectorAll("select").length,
        details: Array.from(el.querySelectorAll("select")).map((s, i) => ({
          index: i,
          optionCount: s.options.length,
          firstValues: Array.from(s.options)
            .slice(0, 3)
            .map((o) => o.value),
        })),
      }));
      throw new Error(
        `Tag select not found for tagId=${tagId}. Panel selects: ${JSON.stringify(selectInfo)}`,
      );
    }

    const assignPromise = page.waitForResponse(
      (resp) =>
        resp.url().includes(`/api/issues/${issueId}/tags`) &&
        resp.request().method() === "POST" &&
        resp.ok(),
    );
    await tagSelect.selectOption({ value: tagId });
    await assignPromise;

    // Tag badge appears with color
    const tagBadge = panel.locator("span.rounded-full", {
      hasText: tagName,
    });
    await expect(tagBadge).toBeVisible({ timeout: 5000 });

    // Verify the badge has the indigo color (browser normalizes hex to rgb)
    const badgeStyle = await tagBadge.evaluate((el) =>
      el.getAttribute("style"),
    );
    expect(badgeStyle).toContain("102, 241");

    // ── Step 3: Remove the tag via × button ──
    const removePromise = page.waitForResponse(
      (resp) =>
        resp.url().includes(`/api/issues/${issueId}/tags/${tagId}`) &&
        resp.request().method() === "DELETE" &&
        resp.ok(),
    );
    await tagBadge.locator("button").click();
    await removePromise;

    // Tag badge disappears
    await expect(tagBadge).not.toBeVisible({ timeout: 5000 });

    // ── Step 4: Verify removal via API ──
    const tagsRes = await request.get(
      `${SERVER_URL}/api/issues/${issueId}/tags`,
    );
    const tags: { id: string; name: string }[] = await tagsRes.json();
    expect(tags.find((t) => t.id === tagId)).toBeUndefined();

    // ── Step 5: Re-assign to verify the dropdown still works after removal ──
    const tagSelectAgain = await findTagSelect(panel, tagId);
    if (!tagSelectAgain) {
      throw new Error(
        `Tag select not found after removal for tagId=${tagId}`,
      );
    }

    const reassignPromise = page.waitForResponse(
      (resp) =>
        resp.url().includes(`/api/issues/${issueId}/tags`) &&
        resp.request().method() === "POST" &&
        resp.ok(),
    );
    await tagSelectAgain.selectOption({ value: tagId });
    await reassignPromise;

    await expect(tagBadge).toBeVisible({ timeout: 5000 });
  });

  test("pre-assigned tag is visible in detail panel and can be removed", async ({
    page,
    request,
  }) => {
    test.setTimeout(60000);

    const suffix = Date.now().toString(36);
    const tagName = `preassign-tag-${suffix}`;
    const issueTitle = `PreassignTest-${suffix}`;
    const tagId = await createTag(request, tagName, "#EF4444");
    const issueId = await createIssue(request, issueTitle);

    // Pre-assign the tag via API
    const assignRes = await request.post(
      `${SERVER_URL}/api/issues/${issueId}/tags`,
      { data: { tagId } },
    );
    if (!assignRes.ok()) {
      throw new Error(
        `Failed to pre-assign tag: ${assignRes.status()} ${await assignRes.text()}`,
      );
    }

    // Navigate to board and open panel
    await page.goto("/about:blank");
    await page.goto("/");
    await page.waitForSelector("h2", { timeout: 15000 });

    const card = page.getByLabel(`Open issue ${issueTitle}`);
    await expect(card).toBeVisible({ timeout: 15000 });

    const issueTagsLoaded = page.waitForResponse(
      (resp) =>
        resp.url().match(/\/api\/issues\/[^/]+\/tags$/) &&
        resp.request().method() === "GET" &&
        resp.ok(),
    );

    await card.click();

    const panel = page.locator("[data-panel]").filter({
      has: page.getByRole("heading", { name: "Issue Details" }),
    });
    await expect(panel).toBeVisible({ timeout: 10000 });
    await issueTagsLoaded;

    // Pre-assigned tag badge should be visible
    const tagBadge = panel.locator("span.rounded-full", {
      hasText: tagName,
    });
    await expect(tagBadge).toBeVisible({ timeout: 10000 });

    // Remove it
    const removePromise = page.waitForResponse(
      (resp) =>
        resp.url().includes(`/api/issues/${issueId}/tags/${tagId}`) &&
        resp.request().method() === "DELETE" &&
        resp.ok(),
    );
    await tagBadge.locator("button").click();
    await removePromise;

    await expect(tagBadge).not.toBeVisible({ timeout: 5000 });

    // Verify via API
    const tagsRes = await request.get(
      `${SERVER_URL}/api/issues/${issueId}/tags`,
    );
    const tags: { id: string; name: string }[] = await tagsRes.json();
    expect(tags.find((t) => t.id === tagId)).toBeUndefined();
  });
});
