import { expect, test } from "@playwright/test";
import { getE2EProjectId } from "../helpers/e2e-project.js";

test.describe("Board header monitor toolbar", () => {
  test.beforeAll(async ({ request }) => {
    await getE2EProjectId(request);
  });

  test("opens the Monitor control and triggers a run-now cycle", async ({
    page,
  }) => {
    await page.goto("/");

    const monitorButton = page.getByRole("button", { name: "Monitor", exact: true });
    await expect(monitorButton).toBeVisible();
    await monitorButton.click();

    const popover = page.locator("#monitor-popover");
    await expect(popover).toBeVisible();
    await expect(popover.locator("span", { hasText: "Board Monitor" })).toBeVisible();

    const runResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/internal/monitor-run" &&
        response.request().method() === "POST" &&
        response.ok(),
    );
    await popover.getByRole("button", { name: "Run now" }).click();

    const runResponse = await runResponsePromise;
    await expect(await runResponse.json()).toMatchObject({ triggered: true });

    await expect(popover.locator("text=Last run")).toBeVisible();
  });
});
