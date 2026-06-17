import { test, expect } from "@playwright/test";

// SkeletonBoard loading state.
//
// The skeleton only renders while BoardPage's `loading` state is true, which is
// flipped false as soon as the `GET /api/projects/:id/board` fetch resolves — so
// in normal operation it flashes by too fast to observe. We use page.route() to
// DELAY the board response, making the skeleton observable, then assert it shows
// BEFORE the real board content.
//
// Source of selectors:
//   SkeletonBoard.tsx — renders 5 placeholder columns with class
//     `w-full sm:flex-shrink-0 sm:w-72 bg-gray-100 dark:bg-gray-800 rounded-lg`,
//     each containing `animate-pulse` placeholder bars. There is no testid, so we
//     scope to the column class (`.sm\\:w-72.bg-gray-100`) which is unique to the
//     skeleton.
//   BoardPage.tsx — `if (loading) return <SkeletonBoard/>`; once loaded, real
//     board columns render their names in `<h2>` headers. The board fetch is
//     `fetch('/api/projects/${pid}/board')`.

test.describe("SkeletonBoard loading state", () => {
  test("skeleton is shown while the board API is in-flight, then replaced by content", async ({
    page,
  }) => {
    // Delay the board response by ~1.5s so the skeleton is observable. Match the
    // board endpoint specifically (path ends in /board).
    await page.route("**/api/projects/**/board", async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });

    // Skeleton columns: scoped to the class combination unique to SkeletonBoard.
    const skeletonColumn = page.locator("div.sm\\:w-72.bg-gray-100");

    await page.goto("/");

    // While the delayed board fetch is in-flight, the skeleton must be visible
    // and contain pulsing placeholders.
    await expect(skeletonColumn.first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".animate-pulse").first()).toBeVisible();

    // Once the board resolves, real content (column h2 headers) appears and the
    // skeleton is gone.
    await expect(page.locator("h2").first()).toBeVisible({ timeout: 10000 });
    await expect(skeletonColumn).toHaveCount(0);
  });
});
