import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("Settings UI", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");
  });

  test("gear icon is visible in header", async ({ page }) => {
    const gearButton = page.locator('button[title="Settings"]');
    await expect(gearButton).toBeVisible();
  });

  test("click gear opens settings panel", async ({ page }) => {
    await page.locator('button[title="Settings"]').click();

    // Panel should be visible with heading
    await expect(page.locator("h2", { hasText: "Settings" })).toBeVisible();

    // Should have the main agent fields (use exact label text)
    await expect(page.locator("label", { hasText: "Agent Command" })).toBeVisible();
    await expect(page.locator("label", { hasText: "Additional Arguments" })).toBeVisible();
    await expect(page.locator("label", { hasText: "Agent Profile" })).toBeVisible();
  });

  test("fill agent command and save", async ({ page }) => {
    await page.locator('button[title="Settings"]').click();
    await expect(page.locator("h2", { hasText: "Settings" })).toBeVisible();

    // Fill agent command
    const input = page.locator('input[placeholder="claude"]');
    await input.fill("claude-test-binary");

    // Save
    await page.locator('button:has-text("Save")').click();

    // Panel should close
    await expect(page.locator("h2", { hasText: "Settings" })).not.toBeVisible();

    // Toast should appear
    await expect(page.locator("text=Settings saved")).toBeVisible();
  });

  test("settings persist after reopening", async ({ page }) => {
    // Open settings
    await page.locator('button[title="Settings"]').click();
    await expect(page.locator("h2", { hasText: "Settings" })).toBeVisible();

    // Fill a value
    const input = page.locator('input[placeholder="claude"]');
    await input.fill("claude-persist-test");
    await page.locator('button:has-text("Save")').click();

    // Wait for save confirmation and panel to close
    await expect(page.locator("text=Settings saved")).toBeVisible();
    await expect(page.locator("h2", { hasText: "Settings" })).not.toBeVisible();

    // Reopen
    await page.locator('button[title="Settings"]').click();
    await expect(page.locator("h2", { hasText: "Settings" })).toBeVisible();

    // Value should be preserved
    const inputAfter = page.locator('input[placeholder="claude"]');
    await expect(inputAfter).toHaveValue("claude-persist-test");
  });

  test("select mock profile from agent profile dropdown", async ({ page }) => {
    await page.locator('button[title="Settings"]').click();
    await expect(page.locator("h2", { hasText: "Settings" })).toBeVisible();

    // The Agent Profile dropdown should include the built-in Claude mock option
    const profileSelect = page.locator("label", { hasText: "Agent Profile" }).locator("xpath=..").locator("select");
    await expect(profileSelect).toBeVisible();
    await expect(profileSelect.locator('option[value="claude:mock"]')).toHaveCount(1);

    // Select mock profile
    await profileSelect.selectOption("claude:mock");
    await expect(profileSelect).toHaveValue("claude:mock");

    // Save and reopen
    await page.locator('button:has-text("Save")').click();
    await expect(page.locator("h2", { hasText: "Settings" })).not.toBeVisible();

    await page.locator('button[title="Settings"]').click();
    await expect(page.locator("h2", { hasText: "Settings" })).toBeVisible();

    // Should still be selected
    const profileSelectAfter = page.locator("label", { hasText: "Agent Profile" }).locator("xpath=..").locator("select");
    await expect(profileSelectAfter).toHaveValue("claude:mock");
  });

  test("agent profile dropdown exposes Copilot without Claude or Codex labeling", async ({ page }) => {
    await page.locator('button[title="Settings"]').click();
    await expect(page.locator("h2", { hasText: "Settings" })).toBeVisible();

    const profileSelect = page.locator("label", { hasText: "Agent Profile" }).locator("xpath=..").locator("select");
    await expect(profileSelect.locator('optgroup[label="Copilot"]')).toHaveCount(1);
    await expect(profileSelect.locator('option[value="copilot:default"]')).toHaveText("Default");

    await profileSelect.selectOption("copilot:default");
    await expect(profileSelect).toHaveValue("copilot:default");
  });

  test("cancel closes panel without saving", async ({ page }) => {
    await page.locator('button[title="Settings"]').click();
    await expect(page.locator("h2", { hasText: "Settings" })).toBeVisible();

    // Fill a value
    const input = page.locator('input[placeholder="claude"]');
    await input.fill("should-not-persist");

    // Cancel (use exact match to avoid "Cancelled" column group button)
    await page.locator('button', { hasText: /^Cancel$/ }).click();
    await expect(page.locator("h2", { hasText: "Settings" })).not.toBeVisible();

    // Reopen — value should NOT be there
    await page.locator('button[title="Settings"]').click();
    const inputAfter = page.locator('input[placeholder="claude"]');
    await expect(inputAfter).not.toHaveValue("should-not-persist");
  });
});

test.afterAll(async ({ request }) => {
  // Clean up settings
  await request.put(`${SERVER_URL}/api/preferences/settings`, {
    data: {
      agent_command: "",
      agent_args: "",
      output_parser: "true",
      claude_profile: "",
      codex_profile: "",
      provider: "claude",
    },
  });
});
