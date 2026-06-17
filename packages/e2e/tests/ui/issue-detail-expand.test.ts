import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

// #190 — expand button that grows the detail panel from the narrow sidebar to a
// wider modal and finally to full-width (fullscreen) mode.
// Source: IssueDetailPanel.tsx + usePanelLayout.ts
//   Panel root: div[data-panel]. Mode → root className:
//     sidebar    -> "right-0 top-0 h-full ..." (+ inline width min(560px,100vw))
//     modal      -> "w-[min(1200px,96vw)] h-[90vh] ..."
//     fullscreen -> "inset-0"
//   Expand button has rotating title:
//     "Expand to modal" -> "Expand to fullscreen" -> "Collapse to sidebar".
//   Persisted in localStorage key "panelLayout:issueDetail" — cleared on init so
//   each run starts deterministically in sidebar mode.
test.describe("Issue detail panel expand UI", () => {
  let projectId: string;
  let statusId: string;
  let suffix: string;
  const createdIssueIds: string[] = [];

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
    projectId = await withRetry(() => getE2EProjectId(request), "getE2EProjectId");

    const statuses = await withRetry(async () => {
      const res = await request.get(`${SERVER_URL}/api/projects/${projectId}/statuses`);
      if (!res.ok()) throw new Error(`statuses ${res.status()}`);
      return res.json();
    }, "fetch statuses");
    const todo = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todo ? todo.id : statuses[0].id;

    suffix = Date.now().toString(36);
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  test("expand button cycles sidebar -> modal -> fullscreen and back", async ({ page, request }) => {
    test.setTimeout(60000);
    const title = `ExpandPanel ${suffix}`;
    const issueId = await withRetry(async () => {
      const res = await request.post(`${SERVER_URL}/api/issues`, {
        data: { title, statusId, projectId },
      });
      if (!res.ok()) throw new Error(`create issue ${res.status()}`);
      return (await res.json()).id;
    }, "create issue");
    createdIssueIds.push(issueId);

    // Start every run in the narrow sidebar mode regardless of prior persisted state.
    await page.addInitScript(() => {
      try {
        window.localStorage.removeItem("panelLayout:issueDetail");
      } catch {
        /* ignore */
      }
    });

    await page.goto("/");
    await page.waitForSelector("h2");

    const card = page.locator("p", { hasText: title }).first();
    await expect(card).toBeAttached({ timeout: 20000 });
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeVisible({ timeout: 5000 });
    await card.click();
    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();

    const panel = page.locator("[data-panel]");
    await expect(panel).toBeVisible();

    // Sidebar mode: anchored right, not full-screen.
    await expect(panel).toHaveClass(/right-0/);
    await expect(panel).not.toHaveClass(/inset-0/);

    // The expand button is identified by its rotating title attribute.
    const expandToModal = panel.locator("button[title='Expand to modal']");
    await expect(expandToModal).toBeVisible();
    await expandToModal.click();

    // Modal mode: wider fixed width, no longer right-anchored.
    await expect(panel).toHaveClass(/w-\[min\(1200px,96vw\)\]/);
    await expect(panel).not.toHaveClass(/inset-0/);

    const expandToFullscreen = panel.locator("button[title='Expand to fullscreen']");
    await expect(expandToFullscreen).toBeVisible();
    await expandToFullscreen.click();

    // Fullscreen mode: inset-0 = full-width / full-height.
    await expect(panel).toHaveClass(/inset-0/);

    // One more click collapses back to the sidebar.
    const collapse = panel.locator("button[title='Collapse to sidebar']");
    await expect(collapse).toBeVisible();
    await collapse.click();

    await expect(panel).toHaveClass(/right-0/);
    await expect(panel).not.toHaveClass(/inset-0/);
  });
});
