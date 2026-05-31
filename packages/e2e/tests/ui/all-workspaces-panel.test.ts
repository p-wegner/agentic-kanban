import { test, expect, type APIRequestContext } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

// Ensure the board has an active project so the All Workspaces panel can render.
// The active project may change between test runs (other test files modify it).
async function ensureProjectActive(request: APIRequestContext): Promise<string> {
  const res = await request.get(`${SERVER_URL}/api/projects`);
  expect(res.ok(), `GET /api/projects failed with ${res.status()}`).toBe(true);
  const projects: { id: string; name: string }[] = await res.json();
  const proj =
    projects.find((p) => p.name === "agentic-kanban") ??
    projects[0];
  if (!proj) {
    throw new Error("No project is registered; cannot render All Workspaces panel");
  }
  const prefRes = await request.put(`${SERVER_URL}/api/preferences/active-project`, {
    data: { projectId: proj.id },
  });
  expect(prefRes.ok(), `PUT active-project failed with ${prefRes.status()}`).toBe(true);
  return proj.id;
}

// Wait for the board columns to appear (i.e. a project is loaded and rendered).
async function waitForBoard(page: import("@playwright/test").Page) {
  // The board renders column headers as h2 elements when a project is active.
  // Fall back to checking the header button as a minimum signal the app is loaded.
  await page.waitForLoadState("networkidle");
  // Give React time to render the project data
  const colsVisible = await page
    .locator("h2")
    .first()
    .isVisible({ timeout: 5000 })
    .catch(() => false);
  if (!colsVisible) {
    // Board may show "No projects registered" — wait for the header button at minimum
    await expect(page.locator('button[title="All Workspaces"]')).toBeVisible({
      timeout: 5000,
    });
  }
}

async function openPanel(page: import("@playwright/test").Page) {
  await waitForBoard(page);
  await page.evaluate(() =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true }),
    ),
  );
  await expect(
    page.locator("h2", { hasText: "All Workspaces" }),
  ).toBeVisible({ timeout: 5000 });
}

test.describe("All Workspaces Panel — open/close", () => {
  test.beforeEach(async ({ page, request }) => {
    await ensureProjectActive(request);
    await page.goto("/");
    await waitForBoard(page);
  });

  test("opens via keyboard shortcut 'a'", async ({ page }) => {
    await openPanel(page);
    await expect(
      page.locator("h2", { hasText: "All Workspaces" }),
    ).toBeVisible();
  });

  test("opens via header icon button", async ({ page }) => {
    await page.locator('button[title="All Workspaces"]').click();
    await expect(
      page.locator("h2", { hasText: "All Workspaces" }),
    ).toBeVisible({ timeout: 5000 });
  });

  test("closes via × button", async ({ page }) => {
    await openPanel(page);
    await page.locator("button", { hasText: "×" }).click();
    await expect(
      page.locator("h2", { hasText: "All Workspaces" }),
    ).not.toBeVisible({ timeout: 3000 });
  });

  test("closes via backdrop click", async ({ page }) => {
    await openPanel(page);
    await page.mouse.click(10, 10);
    await expect(
      page.locator("h2", { hasText: "All Workspaces" }),
    ).not.toBeVisible({ timeout: 3000 });
  });

  test("pressing 'a' again toggles panel off", async ({ page }) => {
    await openPanel(page);
    await page.evaluate(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", bubbles: true }),
      ),
    );
    await expect(
      page.locator("h2", { hasText: "All Workspaces" }),
    ).not.toBeVisible({ timeout: 3000 });
  });
});

test.describe("All Workspaces Panel — filters and search", () => {
  test.beforeEach(async ({ page, request }) => {
    await ensureProjectActive(request);
    await page.goto("/");
    await openPanel(page);
  });

  test("shows all seven filter chips", async ({ page }) => {
    const chips = page.locator("div.flex.gap-1\\.5");
    for (const label of [
      "All",
      "Active",
      "Running",
      "Idle",
      "Reviewing",
      "Fixing",
      "Closed",
    ]) {
      await expect(
        chips.locator("button", { hasText: new RegExp(`^${label}$`) }),
      ).toBeVisible();
    }
  });

  test("'All' chip is selected by default", async ({ page }) => {
    const chips = page.locator("div.flex.gap-1\\.5");
    await expect(
      chips.locator("button", { hasText: /^All$/ }),
    ).toHaveClass(/bg-brand-600/);
  });

  test("clicking a filter chip selects it", async ({ page }) => {
    const chips = page.locator("div.flex.gap-1\\.5");
    const idleChip = chips.locator("button", { hasText: /^Idle$/ });
    await idleChip.click();
    await expect(idleChip).toHaveClass(/bg-brand-600/);
    await expect(
      chips.locator("button", { hasText: /^All$/ }),
    ).not.toHaveClass(/bg-brand-600/);
  });

  test("clicking All chip resets selection", async ({ page }) => {
    const chips = page.locator("div.flex.gap-1\\.5");
    await chips.locator("button", { hasText: /^Idle$/ }).click();
    await chips.locator("button", { hasText: /^All$/ }).click();
    await expect(
      chips.locator("button", { hasText: /^All$/ }),
    ).toHaveClass(/bg-brand-600/);
  });

  test("shows search input", async ({ page }) => {
    await expect(
      page.locator('input[placeholder*="Search by title or branch"]'),
    ).toBeVisible();
  });

  test("search with no matches shows empty state", async ({ page }) => {
    const searchInput = page.locator(
      'input[placeholder*="Search by title or branch"]',
    );
    await searchInput.fill("ZZZNOMATCH_xyzzy_99999");
    const noMatch = page.locator("text=No workspaces match the current filter.");
    const noWs = page.locator("text=No workspaces yet.");
    await expect(noMatch.or(noWs).first()).toBeVisible({ timeout: 3000 });
  });

  test("clearing search restores list", async ({ page }) => {
    const searchInput = page.locator(
      'input[placeholder*="Search by title or branch"]',
    );
    await searchInput.fill("ZZZNOMATCH");
    const noMatch = page.locator("text=No workspaces match the current filter.");
    const noWs = page.locator("text=No workspaces yet.");
    await expect(noMatch.or(noWs).first()).toBeVisible({ timeout: 3000 });
    await searchInput.fill("");
    await expect(noMatch).not.toBeVisible({ timeout: 3000 });
  });

  test("status filter chip applies filter", async ({ page }) => {
    const chips = page.locator("div.flex.gap-1\\.5");
    const reviewingChip = chips.locator("button", { hasText: /^Reviewing$/ });
    await reviewingChip.click();
    await expect(reviewingChip).toHaveClass(/bg-brand-600/);
    await expect
      .poll(
        async () => {
          const items = await page.locator(".divide-y > div").count();
          const hasEmpty = await page
            .locator("text=No workspaces match the current filter.")
            .isVisible()
            .catch(() => false);
          const hasNoWs = await page
            .locator("text=No workspaces yet.")
            .isVisible()
            .catch(() => false);
          return items > 0 || hasEmpty || hasNoWs;
        },
        { timeout: 3000 },
      )
      .toBe(true);
  });
});

test.describe("All Workspaces Panel — workspace list content", () => {
  let firstIssueTitle = "";
  let firstBranch = "";
  let issueId = "";
  let workspaceId = "";
  let originalClaudeProfile = "";
  const suffix = Date.now().toString(36);

  test.beforeAll(async ({ request }) => {
    const projectId = await ensureProjectActive(request);

    const settingsRes = await request.get(
      `${SERVER_URL}/api/preferences/settings`,
    );
    expect(
      settingsRes.ok(),
      `GET settings failed with ${settingsRes.status()}`,
    ).toBe(true);
    originalClaudeProfile = ((await settingsRes.json()).claude_profile ??
      "") as string;
    const mockSettingsRes = await request.put(
      `${SERVER_URL}/api/preferences/settings`,
      {
        data: { claude_profile: "mock" },
      },
    );
    expect(
      mockSettingsRes.ok(),
      `PUT mock settings failed with ${mockSettingsRes.status()}`,
    ).toBe(true);

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    expect(
      statusesRes.ok(),
      `GET statuses failed with ${statusesRes.status()}`,
    ).toBe(true);
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    const statusId = todoStatus?.id ?? statuses[0]?.id;
    if (!statusId) {
      throw new Error("Project has no statuses; cannot create test issue");
    }

    firstIssueTitle = `All workspaces panel E2E ${suffix}`;
    firstBranch = `feature/all-workspaces-panel-${suffix}`;

    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: firstIssueTitle,
        statusId,
        projectId,
        skipAutoReview: true,
      },
    });
    expect(issueRes.status(), `POST issue failed with ${issueRes.status()}`).toBe(
      201,
    );
    issueId = (await issueRes.json()).id;
    if (!issueId) {
      throw new Error("Issue setup did not return an id");
    }

    const workspaceRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: {
        issueId,
        branch: firstBranch,
        requiresReview: false,
      },
    });
    expect(
      workspaceRes.status(),
      `POST workspace failed with ${workspaceRes.status()}`,
    ).toBe(201);
    workspaceId = (await workspaceRes.json()).id;
    if (!workspaceId) {
      throw new Error("Workspace setup did not return an id");
    }
  });

  test.afterAll(async ({ request }) => {
    if (workspaceId) {
      await request
        .delete(`${SERVER_URL}/api/workspaces/${workspaceId}`)
        .catch(() => {});
    }
    if (issueId) {
      await request.delete(`${SERVER_URL}/api/issues/${issueId}`).catch(() => {});
    }
    await request
      .put(`${SERVER_URL}/api/preferences/settings`, {
        data: { claude_profile: originalClaudeProfile },
      })
      .catch(() => {});
  });

  test.beforeEach(async ({ page, request }) => {
    await ensureProjectActive(request);
    await page.goto("/");
    await openPanel(page);
  });

  test("shows issue number badges", async ({ page }) => {
    await expect(
      page.locator("span", { hasText: /^#\d+$/ }).first(),
    ).toBeVisible({ timeout: 5000 });
  });

  test("shows a workspace status badge", async ({ page }) => {
    const statusTexts = [
      "idle",
      "active",
      "closed",
      "AI Reviewing",
      "AI Fixing Conflicts",
    ];
    let found = false;
    for (const text of statusTexts) {
      if ((await page.locator("span", { hasText: text }).count()) > 0) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  test("shows workspace count in header", async ({ page }) => {
    await expect(
      page.locator("span", { hasText: /^\(\d+\)$/ }).first(),
    ).toBeVisible();
  });

  test("shows issue title in list", async ({ page }) => {
    await expect(
      page.locator(`text=${firstIssueTitle}`).first(),
    ).toBeVisible({ timeout: 5000 });
  });

  test("shows branch name in list", async ({ page }) => {
    await expect(
      page.locator(`text=${firstBranch}`).first(),
    ).toBeVisible({ timeout: 5000 });
  });

  test("text search filters by issue title", async ({ page }) => {
    const queryWord = firstIssueTitle.split(" ").at(-1)!;
    const searchInput = page.locator(
      'input[placeholder*="Search by title or branch"]',
    );
    await searchInput.fill(queryWord);
    await expect(
      page.locator(`text=${firstIssueTitle}`).first(),
    ).toBeVisible({ timeout: 3000 });
  });

  test("text search filters by branch name", async ({ page }) => {
    const queryPart = firstBranch.split("/").at(-1)!.slice(0, 12);
    const searchInput = page.locator(
      'input[placeholder*="Search by title or branch"]',
    );
    await searchInput.fill(queryPart);
    await expect(
      page.locator(`text=${firstIssueTitle}`).first(),
    ).toBeVisible({ timeout: 3000 });
  });

  test("clicking an issue row opens issue detail and closes panel", async ({
    page,
  }) => {
    await page.locator(`text=${firstIssueTitle}`).first().click();
    await expect(
      page.locator("h2", { hasText: "Issue Details" }),
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.locator("h2", { hasText: "All Workspaces" }),
    ).not.toBeVisible({ timeout: 3000 });
  });
});
