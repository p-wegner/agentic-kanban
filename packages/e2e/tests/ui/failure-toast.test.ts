import { test, expect } from "@playwright/test";
import { getE2EProjectId } from "../helpers/e2e-project.js";

// #184 — FAILURE toast notification lifecycle.
//
// Source of selectors:
//   Toast.tsx — ToastContainer renders a fixed bottom-right stack
//     (`.fixed.bottom-4.right-4`); each error toast is `.bg-red-600.text-white`
//     containing `<span>{message}</span>`; success is `.bg-green-600`. showToast()
//     auto-removes the toast after 4000ms.
//   createIssueService.ts — a failing `POST /api/issues` runs the catch branch and
//     calls showToast("Failed to create issue", "error"). We force that failure
//     deterministically with page.route() returning a 500, so the error path is
//     guaranteed regardless of backend state.
//   CreateIssueForm.tsx / BoardColumn.tsx — the inline create form is opened with
//     the column's `button[title="Add issue"]`, the title goes in the
//     `textarea[placeholder="Issue title"]`, and the form is submitted via the
//     `button` with text "Add" (type=submit).

test.describe("Failure toast (#184)", () => {
  let suffix: string;

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
    await withRetry(() => getE2EProjectId(request), "getE2EProjectId");
    suffix = Date.now().toString(36);
  });

  // No created issues to clean up: the create POST is intercepted and never reaches
  // the DB, so nothing is persisted.

  test("error toast appears and auto-dismisses when issue creation fails", async ({ page }) => {
    // Force the issue-creation POST to fail with a 500 — but only the exact create
    // endpoint (path ends with /api/issues), not nested routes like
    // /api/issues/:id/tags.
    await page.route("**/api/issues", async (route, request) => {
      if (request.method() === "POST" && /\/api\/issues$/.test(new URL(request.url()).pathname)) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "forced failure for E2E" }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto("/");
    await page.waitForSelector("h2");

    // Open the inline create form in the first column.
    await page.locator('button[title="Add issue"]').first().click();
    // Scope to the create form so the title input + submit button are unambiguous.
    const form = page.locator("form", {
      has: page.locator('textarea[placeholder="Issue title"]'),
    }).first();
    const titleInput = form.locator('textarea[placeholder="Issue title"]');
    await expect(titleInput).toBeVisible({ timeout: 5000 });
    await titleInput.fill(`ToastFail ${suffix}`);

    // Submit — the intercepted POST 500s, driving showToast(..., "error").
    await form.locator('button[type="submit"]').click();

    // Scope to the toast container; assert a RED (error) toast with the message.
    const toastContainer = page.locator("div.fixed.bottom-4.right-4");
    const errorToast = toastContainer.locator("div.bg-red-600", {
      hasText: "Failed to create issue",
    });
    await expect(errorToast).toBeVisible({ timeout: 5000 });

    // It auto-dismisses (showToast removes after 4000ms). Allow margin.
    await expect(errorToast).toBeHidden({ timeout: 8000 });
  });
});
