import { expect, test } from "@playwright/test";
import { getE2EProjectId } from "../helpers/e2e-project.js";

test.describe("Board header monitor toolbar", () => {
  test.beforeAll(async ({ request }) => {
    await getE2EProjectId(request);
  });

  // #1102: the bare "Monitor" button became the Autopilot chip. The full Monitor popover is one
  // link inside the chip's panel.
  test("opens the Autopilot chip, reaches the full Monitor, and triggers a run-now cycle", async ({
    page,
  }) => {
    await page.goto("/");

    const chip = page.getByTestId("autopilot-chip");
    await expect(chip).toBeVisible();
    await chip.click();

    const panel = page.getByTestId("autopilot-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("radiogroup", { name: "Start Mode" })).toBeVisible();
    await panel.getByRole("button", { name: "Full monitor…" }).click();

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
