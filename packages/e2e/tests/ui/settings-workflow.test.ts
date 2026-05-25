import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

let originalWorkflowSettings: Record<string, string> = {};

test.beforeAll(async ({ request }) => {
  // Capture current workflow settings before any test modifies them.
  const res = await request.get(`${SERVER_URL}/api/preferences/settings`);
  if (res.ok()) {
    const all = await res.json();
    originalWorkflowSettings = {
      auto_review: all.auto_review ?? "true",
      review_auto_fix: all.review_auto_fix ?? "true",
      auto_merge: all.auto_merge ?? "true",
      auto_monitor: all.auto_monitor ?? "false",
    };
  }
});

async function openWorkflowTab(page: any) {
  await page.goto("/");
  await page.waitForSelector("h2");
  await page.locator('button[title="Settings"]').click();
  await expect(page.locator("h2", { hasText: "Settings" })).toBeVisible();
  await page.locator("button", { hasText: "Workflow" }).click();
}

test.describe("Settings > Workflow tab", () => {
  test("workflow tab is accessible from settings", async ({ page }) => {
    await openWorkflowTab(page);
    await expect(page.locator("text=Process pipeline")).toBeVisible();
  });

  test("pipeline visualization section is visible", async ({ page }) => {
    await openWorkflowTab(page);
    // Pipeline container with description text
    await expect(page.locator("text=Process pipeline")).toBeVisible();
    // Always-present pipeline steps (scoped to the pipeline container span elements)
    await expect(
      page.locator(".bg-blue-100.text-blue-700", { hasText: "Agent runs" }).first()
    ).toBeVisible();
    await expect(
      page.locator(".bg-blue-100.text-blue-700", { hasText: "Merge" }).first()
    ).toBeVisible();
    await expect(
      page.locator("text=Green steps are optional")
    ).toBeVisible();
  });

  test("auto code review toggle persists after save", async ({ page }) => {
    await openWorkflowTab(page);

    const label = page.locator("label", { hasText: "Auto Code Review" });
    const checkbox = label.locator('input[type="checkbox"]');
    const before = await checkbox.isChecked();

    await checkbox.click();
    await expect(checkbox).toBeChecked({ checked: !before });

    await page.locator('button:has-text("Save")').click();
    await expect(page.locator("text=Settings saved")).toBeVisible();

    // Reopen and verify
    await page.locator('button[title="Settings"]').click();
    await page.locator("button", { hasText: "Workflow" }).click();
    const labelAfter = page.locator("label", { hasText: "Auto Code Review" });
    await expect(labelAfter.locator('input[type="checkbox"]')).toBeChecked({
      checked: !before,
    });

    // Restore
    await labelAfter.locator('input[type="checkbox"]').click();
    await page.locator('button:has-text("Save")').click();
    await expect(page.locator("text=Settings saved")).toBeVisible();
  });

  test("auto-fix toggle persists after save", async ({ page }) => {
    await openWorkflowTab(page);

    // Ensure auto review is on first (auto-fix is nested under it)
    const reviewLabel = page.locator("label", { hasText: "Auto Code Review" });
    const reviewCheckbox = reviewLabel.locator('input[type="checkbox"]');
    if (!(await reviewCheckbox.isChecked())) {
      await reviewCheckbox.click();
      await expect(reviewCheckbox).toBeChecked();
    }

    const label = page.locator("label", {
      hasText: "Auto-fix issues found in review",
    });
    const checkbox = label.locator('input[type="checkbox"]');
    const before = await checkbox.isChecked();

    await checkbox.click();
    await expect(checkbox).toBeChecked({ checked: !before });

    await page.locator('button:has-text("Save")').click();
    await expect(page.locator("text=Settings saved")).toBeVisible();

    // Reopen and verify
    await page.locator('button[title="Settings"]').click();
    await page.locator("button", { hasText: "Workflow" }).click();
    const labelAfter = page.locator("label", {
      hasText: "Auto-fix issues found in review",
    });
    await expect(labelAfter.locator('input[type="checkbox"]')).toBeChecked({
      checked: !before,
    });

    // Restore
    await labelAfter.locator('input[type="checkbox"]').click();
    await page.locator('button:has-text("Save")').click();
    await expect(page.locator("text=Settings saved")).toBeVisible();
  });

  test("auto-merge toggle persists after save", async ({ page }) => {
    await openWorkflowTab(page);

    // Ensure auto review is on
    const reviewLabel = page.locator("label", { hasText: "Auto Code Review" });
    const reviewCheckbox = reviewLabel.locator('input[type="checkbox"]');
    if (!(await reviewCheckbox.isChecked())) {
      await reviewCheckbox.click();
      await expect(reviewCheckbox).toBeChecked();
    }

    const label = page.locator("label", { hasText: "Auto-merge after review" });
    const checkbox = label.locator('input[type="checkbox"]');
    const before = await checkbox.isChecked();

    await checkbox.click();
    await expect(checkbox).toBeChecked({ checked: !before });

    await page.locator('button:has-text("Save")').click();
    await expect(page.locator("text=Settings saved")).toBeVisible();

    // Reopen and verify
    await page.locator('button[title="Settings"]').click();
    await page.locator("button", { hasText: "Workflow" }).click();
    const labelAfter = page.locator("label", {
      hasText: "Auto-merge after review",
    });
    await expect(labelAfter.locator('input[type="checkbox"]')).toBeChecked({
      checked: !before,
    });

    // Restore
    await labelAfter.locator('input[type="checkbox"]').click();
    await page.locator('button:has-text("Save")').click();
    await expect(page.locator("text=Settings saved")).toBeVisible();
  });

  test("board monitoring toggle persists after save", async ({ page }) => {
    await openWorkflowTab(page);

    await expect(
      page.locator("text=Board Monitor")
    ).toBeVisible();

    const label = page.locator("label", { hasText: "Auto-monitor" });
    const checkbox = label.locator('input[type="checkbox"]');
    const before = await checkbox.isChecked();

    await checkbox.click();
    await expect(checkbox).toBeChecked({ checked: !before });

    await page.locator('button:has-text("Save")').click();
    await expect(page.locator("text=Settings saved")).toBeVisible();

    // Reopen and verify
    await page.locator('button[title="Settings"]').click();
    await page.locator("button", { hasText: "Workflow" }).click();
    const labelAfter = page.locator("label", { hasText: "Auto-monitor" });
    await expect(labelAfter.locator('input[type="checkbox"]')).toBeChecked({
      checked: !before,
    });

    // Restore
    await labelAfter.locator('input[type="checkbox"]').click();
    await page.locator('button:has-text("Save")').click();
    await expect(page.locator("text=Settings saved")).toBeVisible();
  });

  test("board monitor section shows Run now button", async ({ page }) => {
    await openWorkflowTab(page);
    await expect(
      page.locator('button[title="Run a monitor cycle now and restart the interval timer"]')
    ).toBeVisible();
  });

  test("auto-monitor interval input appears when auto-monitor is enabled", async ({
    page,
  }) => {
    await openWorkflowTab(page);

    const label = page.locator("label", { hasText: "Auto-monitor" });
    const checkbox = label.locator('input[type="checkbox"]');

    // Enable auto-monitor if not already on
    const wasOn = await checkbox.isChecked();
    if (!wasOn) {
      await checkbox.click();
      await expect(checkbox).toBeChecked();
    }

    // Interval input should be visible
    await expect(page.locator('input[type="number"]')).toBeVisible();
    await expect(page.locator("span.text-xs.text-gray-500", { hasText: "min" })).toBeVisible();

    // Restore if we changed it
    if (!wasOn) {
      await checkbox.click();
      await page.locator('button:has-text("Save")').click();
      await expect(page.locator("text=Settings saved")).toBeVisible();
    }
  });
});

test.afterAll(async ({ request }) => {
  // Restore original workflow settings (not hardcoded defaults) to avoid corrupting the real DB.
  try {
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: originalWorkflowSettings,
    });
  } catch { /* best-effort */ }
});
