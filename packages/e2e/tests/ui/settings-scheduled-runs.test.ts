import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

async function getActiveProjectId(request: APIRequestContext): Promise<string | null> {
  try {
    const prefRes = await request.get(`${SERVER_URL}/api/preferences/active-project`);
    const pref: { projectId: string | null } = await prefRes.json();
    if (pref.projectId) return pref.projectId;
  } catch {
    // fall through to first project
  }
  const projRes = await request.get(`${SERVER_URL}/api/projects`);
  const projects: Array<{ id: string }> = await projRes.json();
  return projects[0]?.id ?? null;
}

async function openScheduleTab(page: Page) {
  await page.goto("/");
  // Wait for the board to finish loading before interacting with Settings
  await page.locator('button[title="Settings"]').waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle");
  await page.locator('button[title="Settings"]').click();
  // Wait for the Settings modal card (max-w-5xl is unique to SettingsPanel)
  const settingsCard = page.locator("div.max-w-5xl");
  await expect(settingsCard.locator("h2", { hasText: "Settings" })).toBeVisible({ timeout: 8000 });
  // Click the Schedule tab — scope to the tab bar to avoid board button collisions
  await settingsCard.locator("div.flex.border-b").locator("button", { hasText: "Schedule" }).click();
  await expect(
    page.locator("p", { hasText: "Configure recurring agent runs" })
  ).toBeVisible({ timeout: 10000 });
  // Wait for scheduled runs data to load from the API
  await page.waitForTimeout(1000);
}

/** Locator scoped to the Schedule tab content (avoids matching board issue cards). */
function schedulePanel(page: Page) {
  return page
    .locator("div", {
      has: page.locator("p", { hasText: "Configure recurring agent runs" }),
    })
    .last();
}

const createdRunIds: string[] = [];

test.describe("Settings Schedule tab", () => {
  test("schedule tab is visible and shows empty state or list", async ({
    page,
  }) => {
    await openScheduleTab(page);

    const panel = schedulePanel(page);
    const emptyState = panel.locator("p.italic", {
      hasText: "No scheduled runs configured yet",
    });
    const anyRun = panel.locator("div.border.border-gray-200.rounded-md").first();

    const hasEmpty = await emptyState.isVisible().catch(() => false);
    const hasRun = await anyRun.isVisible().catch(() => false);
    expect(hasEmpty || hasRun).toBe(true);
  });

  test("add a scheduled run via UI form", async ({ page, request }) => {
    const runName = `e2e-run-${Date.now().toString(36)}`;
    const runPrompt = "Test prompt for E2E scheduled run";

    const projectId = await getActiveProjectId(request);
    if (!projectId) test.skip();

    await openScheduleTab(page);

    await page
      .locator('input[placeholder="Name (e.g. Daily standup update)"]')
      .fill(runName);
    await page
      .locator('textarea[placeholder="Prompt for the agent"]')
      .fill(runPrompt);

    const intervalInput = page.locator('input[type="number"]');
    await intervalInput.fill("30");

    await page.locator("button", { hasText: "Add" }).click();

    await expect(page.locator("text=Scheduled run created")).toBeVisible();

    const panel = schedulePanel(page);
    const row = panel.locator("div.border.border-gray-200.rounded-md", {
      hasText: runName,
    });
    await expect(row).toBeVisible();
    await expect(row.locator("text=every 30m")).toBeVisible();

    // Record id for cleanup (and immediately disable to prevent scheduler from running it)
    const runsRes = await request.get(
      `${SERVER_URL}/api/scheduled-runs?projectId=${projectId}`
    );
    const runs: Array<{ id: string; name: string }> = await runsRes.json();
    const created = runs.find((r) => r.name === runName);
    if (created) {
      createdRunIds.push(created.id);
      // Disable immediately so the scheduler doesn't attempt to run it
      await request
        .put(`${SERVER_URL}/api/scheduled-runs/${created.id}`, {
          data: { enabled: false },
        })
        .catch(() => {});
    }
  });

  test("created run appears in list with correct details", async ({
    page,
    request,
  }) => {
    const runName = `e2e-detail-${Date.now().toString(36)}`;
    const runPrompt = "Detail verification prompt";

    const projectId = await getActiveProjectId(request);
    if (!projectId) test.skip();

    const createRes = await request.post(`${SERVER_URL}/api/scheduled-runs`, {
      data: {
        name: runName,
        prompt: runPrompt,
        intervalMinutes: 45,
        projectId,
        enabled: false,
      },
    });
    const created: { id: string } = await createRes.json();
    createdRunIds.push(created.id);

    await openScheduleTab(page);

    const panel = schedulePanel(page);
    const row = panel.locator("div.border.border-gray-200.rounded-md", {
      hasText: runName,
    });
    await expect(row).toBeVisible();
    await expect(row.locator("text=every 45m")).toBeVisible();
    await expect(row.locator(`text=${runPrompt}`)).toBeVisible();
  });

  test("delete a scheduled run removes it from the list", async ({
    page,
    request,
  }) => {
    const runName = `e2e-delete-${Date.now().toString(36)}`;

    const projectId = await getActiveProjectId(request);
    if (!projectId) test.skip();

    await request.post(`${SERVER_URL}/api/scheduled-runs`, {
      data: {
        name: runName,
        prompt: "delete me",
        intervalMinutes: 60,
        projectId,
        enabled: false,
      },
    });

    await openScheduleTab(page);

    const panel = schedulePanel(page);
    const row = panel.locator("div.border.border-gray-200.rounded-md", {
      hasText: runName,
    });
    await expect(row).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await row.locator("button", { hasText: "Delete" }).click();

    // Toast is in the fixed bottom-right overlay (z-[60])
    await expect(page.locator("div.fixed.bottom-4", { hasText: "Deleted" })).toBeVisible();
    await expect(
      panel.locator("div.border.border-gray-200.rounded-md", {
        hasText: runName,
      })
    ).not.toBeVisible();
  });

  test("pause/resume controls update run state", async ({
    page,
    request,
  }) => {
    const runName = `e2e-toggle-${Date.now().toString(36)}`;

    const projectId = await getActiveProjectId(request);
    if (!projectId) test.skip();

    // Start disabled so enabling it doesn't trigger workspace creation
    const createRes = await request.post(`${SERVER_URL}/api/scheduled-runs`, {
      data: {
        name: runName,
        prompt: "toggle test",
        intervalMinutes: 60,
        projectId,
        enabled: false,
      },
    });
    const created: { id: string } = await createRes.json();
    createdRunIds.push(created.id);

    await openScheduleTab(page);

    const panel = schedulePanel(page);
    const row = panel.locator("div.border.border-gray-200.rounded-md", {
      hasText: runName,
    });
    const checkbox = row.locator('input[type="checkbox"]');
    await expect(checkbox).not.toBeChecked();
    await expect(row.locator("button", { hasText: "Resume" })).toBeVisible();

    // Click Resume and wait for the PUT request to complete
    const putPromise = page.waitForResponse(
      (res) =>
        res.url().includes("/api/scheduled-runs/") &&
        res.request().method() === "PUT",
      { timeout: 8000 }
    );
    await row.locator("button", { hasText: "Resume" }).click();
    await putPromise;
    // Poll for the checkbox to become checked (React re-renders async after state update)
    await expect(checkbox).toBeChecked({ timeout: 3000 });
    await expect(row.locator("button", { hasText: "Pause" })).toBeVisible();

    // Immediately disable again so the scheduler doesn't start a workspace
    const pausePromise = page.waitForResponse(
      (res) =>
        res.url().includes("/api/scheduled-runs/") &&
        res.request().method() === "PUT",
      { timeout: 8000 }
    );
    await row.locator("button", { hasText: "Pause" }).click();
    await pausePromise;
    await expect(checkbox).not.toBeChecked({ timeout: 3000 });
  });
});

test.afterAll(async ({ request }) => {
  for (const id of createdRunIds) {
    await request
      .delete(`${SERVER_URL}/api/scheduled-runs/${id}`)
      .catch(() => {});
  }
});
