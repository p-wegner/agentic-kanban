import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

// @covers board-ui.wip.visualLimit [feature]
//
// The WIP classifier (evaluateWipLimit: under/at/over) is unit-tested in
// packages/client/src/lib/wipLimits.test.ts, but the USER-VISIBLE outcome — a
// column header rendering its red "over" tint once its card count exceeds the
// column's wip_limit — is asserted by no test. This closes that gap end-to-end:
// seed cards into a column, set a wip_limit BELOW that column's count via the
// real preferences API, load the board, and assert the column header's count
// pill carries the "over" red marker. A second column whose limit is ABOVE its
// count must NOT carry it. The move is never blocked — the limit is advisory.
//
// Stable marker asserted: the header count pill <span> (the only span inside the
// column's <h2>) gains the Tailwind class `bg-red-100` exactly when
// wipStatus === "over" (BoardColumn.tsx line ~344). There is no data-attribute
// or aria for this state, so per the brief we assert the class the component
// actually sets. We additionally assert the pill text shows the limit
// (`count / limit`) to confirm we are targeting the WIP pill, not another badge.
//
// Mutation check: if the "over" tint logic broke (e.g. evaluateWipLimit always
// returned "under", or the ternary dropped the red branch), the over column's
// pill would render the neutral `bg-surface-raised` class instead of
// `bg-red-100` ⇒ the toHaveClass(/bg-red-100/) assertion on line marked below
// goes RED. The under-column assertion guards the other direction (a regression
// that always painted red would fail the not.toHaveClass check).

test.describe("WIP visual limit", () => {
  let projectId: string;
  let overStatusId: string; // column we drive OVER its limit (Todo)
  let underStatusId: string; // column we keep UNDER its limit (In Progress)
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
    const inProgress = statuses.find((s: { name: string }) => s.name === "In Progress");
    overStatusId = todo ? todo.id : statuses[0].id;
    underStatusId = inProgress ? inProgress.id : statuses[1]?.id ?? statuses[0].id;

    suffix = Date.now().toString(36);
  });

  test.afterAll(async ({ request }) => {
    // Reset the wip_limit prefs we set (empty string clears them — getWipLimit
    // treats "" as null), then delete every issue we created.
    try {
      await request.put(`${SERVER_URL}/api/preferences/settings`, {
        data: {
          [`wip_limit_${overStatusId}`]: "",
          [`wip_limit_${underStatusId}`]: "",
        },
      });
    } catch { /* best-effort */ }

    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  test("column header shows red 'over' tint when card count exceeds its WIP limit", async ({
    page,
    request,
  }) => {
    // Arrange — seed cards into both columns via API (deterministic, fast).
    async function seed(statusId: string, n: number, label: string) {
      for (let i = 0; i < n; i++) {
        const id = await withRetry(async () => {
          const res = await request.post(`${SERVER_URL}/api/issues`, {
            data: { title: `WIP ${label} ${i} ${suffix}`, statusId, projectId },
          });
          if (!res.ok()) throw new Error(`create issue ${res.status()}`);
          return (await res.json()).id;
        }, `create issue ${label}`);
        createdIssueIds.push(id);
      }
    }
    await seed(overStatusId, 3, "over");
    await seed(underStatusId, 2, "under");

    // Read the columns' real counts (they may hold pre-existing cards too).
    const board = await withRetry(async () => {
      const res = await request.get(`${SERVER_URL}/api/projects/${projectId}/board`);
      if (!res.ok()) throw new Error(`board ${res.status()}`);
      return res.json();
    }, "fetch board");
    const overCol = board.find((c: { id: string }) => c.id === overStatusId);
    const underCol = board.find((c: { id: string }) => c.id === underStatusId);
    const overCount: number = overCol?.issues?.length ?? 0;
    const underCount: number = underCol?.issues?.length ?? 0;
    expect(overCount).toBeGreaterThanOrEqual(2);

    // Set limits: OVER column gets a limit below its count (count-1, >=1) so it
    // is decisively over even if a concurrent test adds more cards. UNDER column
    // gets a generous headroom so concurrent adds can't flip it to "over".
    const overLimit = overCount - 1;
    const underLimit = underCount + 50;
    await withRetry(async () => {
      const res = await request.put(`${SERVER_URL}/api/preferences/settings`, {
        data: {
          [`wip_limit_${overStatusId}`]: String(overLimit),
          [`wip_limit_${underStatusId}`]: String(underLimit),
        },
      });
      if (!res.ok()) throw new Error(`set wip prefs ${res.status()}`);
    }, "set wip prefs");

    // Act — load the board fresh (fresh JS context => fresh settings fetch).
    await page.goto("/");
    await page.waitForSelector("h2", { timeout: 10000 });

    // The count pill is the single <span> inside each column's <h2>.
    const overPill = page.locator("h2", { hasText: overCol.name }).locator("span").first();
    const underPill = page.locator("h2", { hasText: underCol.name }).locator("span").first();

    // The pill renders "count / limit" once a limit is set — confirms we are on
    // the WIP pill and the limit reached the UI.
    await expect(overPill).toHaveText(new RegExp(`\\d+ / ${overLimit}\\b`), { timeout: 10000 });
    await expect(underPill).toHaveText(new RegExp(`\\d+ / ${underLimit}\\b`), { timeout: 10000 });

    // Assert — OVER column header carries the red "over" marker; UNDER does not.
    await expect(overPill).toHaveClass(/bg-red-100/); // <-- mutation check fails here if "over" tint regressed
    await expect(underPill).not.toHaveClass(/bg-red-100/);
  });
});
