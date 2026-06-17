import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

// #199 — the "Auto-start follow-up tasks after merge" toggle on the
// Settings > Workflow tab (WorkflowFollowUpSection).
//
// Source of selectors:
//   SettingsPanel.shared.tsx — WorkflowFollowUpSection renders a <Toggle> with
//     label="Auto-start follow-up tasks after merge", bound to the
//     `auto_start_followup` setting ("true"/"false"). <Toggle> renders a <label>
//     wrapping an <input type="checkbox">.
//   Settings open/Workflow-tab pattern reused from settings-workflow.test.ts:
//     button[title="Settings"] -> "Settings" h2 -> button "Workflow".
//   The pref persists through GET/PUT /api/preferences/settings (auto_start_followup
//     is in the allowed settings keys in preference.service.ts).

const FOLLOWUP_LABEL = "Auto-start follow-up tasks after merge";

let original: Record<string, string> = {};

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
  // Capture the real current value so afterAll can restore it (never hardcode).
  const all = await withRetry(async () => {
    const res = await request.get(`${SERVER_URL}/api/preferences/settings`);
    if (!res.ok()) throw new Error(`settings ${res.status()}`);
    return res.json();
  }, "fetch settings");
  original = { auto_start_followup: all.auto_start_followup ?? "false" };
});

test.afterAll(async ({ request }) => {
  // RULE 6: restore the mutated setting to its original value.
  try {
    await request.put(`${SERVER_URL}/api/preferences/settings`, { data: original });
  } catch {
    /* best-effort */
  }
});

async function openWorkflowTab(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.waitForSelector("h2");
  await page.locator('button[title="Settings"]').click();
  await expect(page.locator("h2", { hasText: "Settings" })).toBeVisible();
  await page.getByRole("button", { name: "Workflow", exact: true }).click();
}

test.describe("Auto-start follow-up tasks setting (#199)", () => {
  test("the follow-up toggle renders on the Workflow tab", async ({ page }) => {
    await openWorkflowTab(page);
    const label = page.locator("label", { hasText: FOLLOWUP_LABEL });
    await expect(label).toBeVisible({ timeout: 5000 });
    await expect(label.locator('input[type="checkbox"]')).toBeAttached();
  });

  test("flipping the toggle and saving persists to the auto_start_followup pref", async ({
    page,
    request,
  }) => {
    await openWorkflowTab(page);

    const label = page.locator("label", { hasText: FOLLOWUP_LABEL });
    const checkbox = label.locator('input[type="checkbox"]');
    const before = await checkbox.isChecked();

    await checkbox.click();
    await expect(checkbox).toBeChecked({ checked: !before });

    await page.locator('button:has-text("Save")').click();
    await expect(page.locator("text=Settings saved")).toBeVisible({ timeout: 5000 });

    // Server-side pref now reflects the flipped value.
    await expect
      .poll(
        async () => {
          const res = await request.get(`${SERVER_URL}/api/preferences/settings`);
          const s = await res.json();
          return s.auto_start_followup;
        },
        { timeout: 5000 },
      )
      .toBe(before ? "false" : "true");

    // Reopen the panel and confirm the UI reflects the persisted value.
    await page.locator('button[title="Settings"]').click();
    await page.getByRole("button", { name: "Workflow", exact: true }).click();
    const labelAfter = page.locator("label", { hasText: FOLLOWUP_LABEL });
    await expect(labelAfter.locator('input[type="checkbox"]')).toBeChecked({
      checked: !before,
    });

    // Restore via UI back to the original value and save (afterAll also restores
    // the pref as a safety net).
    await labelAfter.locator('input[type="checkbox"]').click();
    await page.locator('button:has-text("Save")').click();
    await expect(page.locator("text=Settings saved")).toBeVisible({ timeout: 5000 });
  });
});
