import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function mockSettingsDependencies(page: Page) {
  await page.route(/\/api\/projects(?:\?.*)?$/, async (route) => route.fulfill({ json: [] }));
  await page.route(/\/api\/agent-skills(?:\?.*)?$/, async (route) => route.fulfill({ json: [] }));
  await page.route(/\/api\/tags(?:\?.*)?$/, async (route) => route.fulfill({ json: [] }));
  await page.route(/\/api\/scheduled-runs(?:\?.*)?$/, async (route) => route.fulfill({ json: [] }));
  await page.route(/\/api\/projects\/[^/]+\/branches(?:\?.*)?$/, async (route) => route.fulfill({ json: { local: ["master"], remote: [] } }));
}

test.describe("Settings provider capability dashboard", () => {
  test("shows empty and error states", async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__agentProfileHealth = { profiles: [] };
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("/api/preferences/agent-profiles/health")) {
          return Promise.resolve(new Response(JSON.stringify((window as any).__agentProfileHealth), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }));
        }
        return originalFetch(input, init);
      };
    });

    await page.goto("/");
    await page.waitForSelector("h2");
    await mockSettingsDependencies(page);
    await page.locator('button[title="Settings"]').click();
    await expect(page.locator("h2", { hasText: "Settings" })).toBeVisible();
    await expect(page.getByText("Loading...")).not.toBeVisible();
    await expect(page.getByText("No provider profiles found.")).toBeVisible();
    await page.locator('button', { hasText: /^Cancel$/ }).click();

    await page.evaluate(() => {
      (window as any).__agentProfileHealth = {
        profiles: [{
          id: "codex:fast",
          provider: "codex",
          profileName: "fast",
          command: "codex",
          selected: false,
          status: "error",
          preflight: {
            ok: false,
            status: "error",
            errors: ["Profile config not found: C:/Users/test/.codex/fast.config.toml"],
            warnings: [],
            command: "codex",
            provider: "codex",
            profileName: "fast",
            flags: ["--json", "--profile fast"],
          },
          latestFailure: {
            at: "2026-06-01T12:00:00.000Z",
            summary: "Agent launch failed without assistant output.",
            exitCode: 1,
          },
        }],
      };
    });

    await page.locator('button[title="Settings"]').click();
    await expect(page.getByText("Loading...")).not.toBeVisible();
    await expect(page.getByText("Provider capability")).toBeVisible();
    await expect(page.getByText("Codex", { exact: true })).toBeVisible();
    await expect(page.getByText("Profile config not found").first()).toBeVisible();
    await expect(page.getByText("Agent launch failed without assistant output.")).toBeVisible();
  });
});
