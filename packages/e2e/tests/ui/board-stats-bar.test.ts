import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

/**
 * Open the board filter menu. It lives in the SETTINGS panel's board-tools slot
 * (`BoardPageView` → `settingsBoardTools` → `BoardOverlayPanels` → `boardToolsSlot`), so
 * reaching it means opening Settings first. Settings has no toolbar button — it is a command
 * palette action — and Chromium swallows a real Ctrl+K, hence the dispatched KeyboardEvent
 * (same approach as `command-palette.test.ts`).
 */
async function openBoardFilterMenu(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }),
    );
  });
  const paletteInput = page.locator('input[placeholder="Search actions..."]');
  await expect(paletteInput).toBeVisible({ timeout: 5000 });
  await paletteInput.fill("settings");
  // force: true — the palette backdrop intercepts the hit test in headless Chromium.
  await page
    .locator("div.text-sm.font-medium", { hasText: "Open Settings" })
    .first()
    .click({ force: true });
  // The slot lives in the "ui" tab (labelled Appearance); Settings opens on "agent".
  await page.locator("[data-testid='settings-tab-ui']").click();
  const filterMenu = page.locator("[data-testid='board-filter-menu']");
  await expect(filterMenu).toBeVisible({ timeout: 5000 });
  await filterMenu.click();
}

test.describe("Board stats bar", () => {
  let projectId: string;
  let todoStatusId: string;
  const createdIssueIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    // Use the active project (set by global-setup to the E2E Test Project)
    const activeRes = await request.get(`${SERVER_URL}/api/preferences/active-project`);
    const { projectId: activeId } = await activeRes.json();
    projectId = activeId;

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    todoStatusId = todoStatus ? todoStatus.id : statuses[0].id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  test("shows ticket counts per status in stats bar", async ({ page, request }) => {
    const suffix = Date.now().toString(36);
    const titles = [
      `StatsTest A ${suffix}`,
      `StatsTest B ${suffix}`,
      `StatsTest C ${suffix}`,
    ];

    for (const title of titles) {
      const res = await request.post(`${SERVER_URL}/api/issues`, {
        data: { title, statusId: todoStatusId, projectId },
      });
      const { id } = await res.json();
      createdIssueIds.push(id);
    }

    await page.goto("/");

    // Fetch actual board counts to assert accurately
    const boardRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/board`);
    const board = await boardRes.json();
    const todoCol = board.find((c: { name: string }) => c.name === "Todo");
    const todoCount = todoCol?.issues?.length ?? 0;

    // Wait for the stats bar to appear (board loads async after skeleton)
    const statsBar = page.locator("[data-testid='board-stats-bar']");
    await expect(statsBar).toBeVisible({ timeout: 10000 });

    // #659 — the per-status legend lives INSIDE the breakdown popover now; the bar itself
    // shows the completion ring and headline count. Open it before asserting.
    //
    // This spec used to select the row by `div.flex.items-center.gap-1` — utility classes,
    // i.e. styling rather than a contract. A restyle that changed no behaviour broke it, and
    // the failure read "element(s) not found", which says nothing about what actually moved.
    // `data-testid` hooks are the contract now.
    await statsBar.getByRole("button").first().click();
    const todoPart = page.locator("[data-testid='board-stats-status-Todo']");
    await expect(todoPart).toBeVisible();
    await expect(page.locator("[data-testid='board-stats-status-count-Todo']")).toHaveText(String(todoCount));
  });

  test("shows commits counter in stats bar", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("[data-testid='board-stats-bar']", { timeout: 10000 });

    // #659 — the commits counter is inside the breakdown popover, not the always-visible
    // pulse line. Open it, then assert on a stable hook rather than a text regex: a regex
    // over "N commits" also matches any other element that happens to say it.
    await page.locator("[data-testid='board-stats-bar']").getByRole("button").first().click();
    // 30s, not 10s: the commits number comes from `GET /api/projects/:id/stats`, which on a
    // COLD E2E database was measured at 11.9-14.9s in this suite's own server log. The old 10s
    // budget was under the observed latency, so this spec failed on timing while reporting a
    // missing element — the same "says nothing about what actually happened" problem as the
    // class-chain selector above.
    await expect(page.locator("[data-testid='board-stats-commits']")).toBeVisible({ timeout: 30000 });
  });

  test("Blocked filter shows only blocked issues, toggle off restores all", async ({
    page,
    request,
  }) => {
    const suffix = Date.now().toString(36);
    const blockerTitle = `Blocker ${suffix}`;
    const blockedTitle = `Blocked ${suffix}`;
    const normalTitle = `Normal ${suffix}`;

    // Create blocker issue (stays in Todo — so it remains unresolved)
    const blockerRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: blockerTitle, statusId: todoStatusId, projectId },
    });
    const { id: blockerId } = await blockerRes.json();
    createdIssueIds.push(blockerId);

    // Create issue that depends on the blocker (will be blocked)
    const blockedRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: blockedTitle, statusId: todoStatusId, projectId },
    });
    const { id: blockedId } = await blockedRes.json();
    createdIssueIds.push(blockedId);

    // Create unblocked normal issue
    const normalRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: normalTitle, statusId: todoStatusId, projectId },
    });
    const { id: normalId } = await normalRes.json();
    createdIssueIds.push(normalId);

    // Add dependency: blockedId depends_on blockerId
    await request.post(`${SERVER_URL}/api/issues/${blockedId}/dependencies`, {
      data: { dependsOnId: blockerId, type: "depends_on" },
    });

    await page.goto("/");

    // Wait for board to fully load (past the skeleton phase)
    await page.waitForSelector("[data-testid='board-stats-bar']", { timeout: 10000 });

    // Narrow the board to this test's three issues BEFORE asserting on cards.
    // BoardColumn virtualizes a column past VIRTUALIZE_ISSUE_THRESHOLD (15 issues), so on a
    // board of any real size a freshly created issue is simply NOT IN THE DOM — which this
    // spec previously reported as "element(s) not found", i.e. indistinguishable from the
    // card failing to render at all. The shared suffix is unique per run, so this leaves
    // exactly the three issues below, well under the threshold.
    await page.locator("#search-input").fill(suffix);

    // Assert on the card's aria-label, not on a bare `p` tag: `p` is incidental markup that
    // any layout change breaks silently, while the label is the card's accessible identity.
    const card = (title: string) => page.locator(`[aria-label="Open issue ${title}"]`);

    // All three issues should be visible before the Blocked filter
    await expect(card(blockerTitle)).toBeVisible();
    await expect(card(blockedTitle)).toBeVisible();
    await expect(card(normalTitle)).toBeVisible();

    // The Blocked filter is a checkbox inside the filter MENU, and that menu is rendered into
    // the SETTINGS panel's board-tools slot — it was a bare button in the stats bar when this
    // spec was written. `button` + /^Blocked$/ could not survive either move, and reported the
    // result as "element not found" rather than "the control lives somewhere else now".
    await openBoardFilterMenu(page);
    const blockedToggle = page.locator("[data-testid='filter-blocked-only']");
    await expect(blockedToggle).toBeVisible();
    await blockedToggle.check();

    // After filter: only the blocked issue should be visible
    await expect(card(blockedTitle)).toBeVisible();
    await expect(card(blockerTitle)).toHaveCount(0);
    await expect(card(normalTitle)).toHaveCount(0);

    // Toggle Blocked filter off (the menu stays open across the assertions above)
    await blockedToggle.uncheck();

    // All issues reappear
    await expect(card(blockerTitle)).toBeVisible();
    await expect(card(blockedTitle)).toBeVisible();
    await expect(card(normalTitle)).toBeVisible();
  });
});
