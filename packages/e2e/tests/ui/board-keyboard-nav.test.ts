import { test, expect, type Page } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

/**
 * Drives the board's arrow / vim keyboard navigation against the REAL rendered
 * board and asserts the keyboard-focused card marker (`aria-current="true"`,
 * rendered by IssueCard) actually moves to the expected card. This is the
 * keyboard-operability accessibility outcome that the pure-arithmetic unit test
 * (`packages/client/src/lib/boardKeyboardNav.test.ts` → computeNavTarget) cannot
 * cover: it only checks the math, never that a keydown re-paints the focus ring
 * on the right DOM node.
 *
 * Determinism trick: we seed issues across two active columns (Todo + In Review),
 * leave the column between them (In Progress) empty, then filter the board to our
 * unique suffix. `activeColumns` derives from the search-filtered columns, so the
 * navigable model becomes exactly Todo(3) / In Progress(0) / In Review(2) — no
 * other issues can perturb the cursor. We then verify the rendered DOM column
 * order matches that premise before asserting movements.
 */

test.describe("Board keyboard navigation (a11y)", () => {
  // @covers board-ui.shortcuts.keyboardNav [accessibility]

  let projectId: string;
  let todoStatusId: string;
  let inProgressStatusId: string;
  let inReviewStatusId: string;
  let suffix: string;
  let marker: string;
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

  const cardLabel = (title: string) => `Open issue ${title}`;

  // Synthetic window-level keydown — mirrors tests/ui/shortcuts.test.ts. The real
  // window listener installed by useBoardKeyboardShortcuts handles it, exercising
  // the full computeNavTarget → setKeyboardCursorIssueId → re-render → aria-current
  // path. target is `window` (not an input), so the text-entry guard lets it pass.
  async function pressNavKey(page: Page, key: string) {
    await page.evaluate(
      (k) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })),
      key,
    );
  }

  // Titles of MY cards (filtered by marker) within one column, in DOM order.
  async function columnCardTitles(page: Page, statusId: string): Promise<string[]> {
    const labels = await page
      .locator(`[id="column-${statusId}"] [aria-label*="${marker}"]`)
      .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
    return labels.map((l) => l.replace(/^Open issue /, ""));
  }

  // Assert exactly one of MY cards is keyboard-focused and it is `title`.
  async function expectFocused(page: Page, title: string) {
    await expect(page.getByLabel(cardLabel(title))).toHaveAttribute("aria-current", "true");
    await expect(
      page.locator(`[aria-current="true"][aria-label*="${marker}"]`),
    ).toHaveCount(1);
  }

  test.beforeAll(async ({ request }) => {
    projectId = await withRetry(() => getE2EProjectId(request), "getE2EProjectId");

    const statuses = await withRetry(async () => {
      const res = await request.get(`${SERVER_URL}/api/projects/${projectId}/statuses`);
      if (!res.ok()) throw new Error(`statuses ${res.status()}`);
      return res.json() as Promise<{ id: string; name: string }[]>;
    }, "fetch statuses");

    const byName = (name: string) => statuses.find((s) => s.name === name);
    const todo = byName("Todo");
    const inProgress = byName("In Progress");
    const inReview = byName("In Review");
    if (!todo || !inProgress || !inReview) {
      throw new Error(
        `[setup] expected Todo / In Progress / In Review statuses, got: ${statuses
          .map((s) => s.name)
          .join(", ")}`,
      );
    }
    todoStatusId = todo.id;
    inProgressStatusId = inProgress.id;
    inReviewStatusId = inReview.id;

    suffix = Date.now().toString(36);
    marker = `kbdnav-${suffix}`;

    // Seed Todo (3 cards) and In Review (2 cards); In Progress is left empty so
    // horizontal navigation must SKIP it. Created sequentially so server-side
    // ordering is stable; expectations are still read from the live DOM order.
    const seed: { status: string; tag: string }[] = [
      { status: todoStatusId, tag: "t1" },
      { status: todoStatusId, tag: "t2" },
      { status: todoStatusId, tag: "t3" },
      { status: inReviewStatusId, tag: "r1" },
      { status: inReviewStatusId, tag: "r2" },
    ];
    for (const s of seed) {
      const id = await withRetry(async () => {
        const res = await request.post(`${SERVER_URL}/api/issues`, {
          data: { title: `${marker} ${s.tag}`, statusId: s.status, projectId },
        });
        if (!res.ok()) throw new Error(`create issue ${s.tag}: ${res.status()}`);
        return (await res.json()).id as string;
      }, `create ${s.tag}`);
      createdIssueIds.push(id);
    }
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`).catch(() => {});
    }
  });

  test("arrow/vim keys move the focused-card marker across columns and clamp at edges", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    // Filter the board down to ONLY our seeded issues. `activeColumns` derives
    // from the search-filtered columns, so this makes the keyboard nav model
    // deterministic regardless of any other issues on the board.
    const myCards = page.locator(`[aria-label^="Open issue "][aria-label*="${marker}"]`);
    await page.locator("#search-input").fill(marker);
    await expect(myCards).toHaveCount(5, { timeout: 15000 });

    // Move focus off the search input so single-key/arrow shortcuts are not
    // swallowed by the text-entry guard. (No fixed sleep — blur is synchronous.)
    await page.locator("#search-input").evaluate((el) => (el as HTMLInputElement).blur());

    // --- Verify the navigable premise from the live DOM ---------------------
    const todoTitles = await columnCardTitles(page, todoStatusId);
    const reviewTitles = await columnCardTitles(page, inReviewStatusId);
    const inProgressTitles = await columnCardTitles(page, inProgressStatusId);
    expect(todoTitles).toHaveLength(3);
    expect(reviewTitles).toHaveLength(2);
    expect(inProgressTitles).toHaveLength(0); // the empty column nav must skip

    // Todo precedes (empty) In Progress precedes In Review in render order, so a
    // rightward move from Todo must hop over In Progress to land in In Review.
    const colOrder = await page
      .locator('[id^="column-"]')
      .evaluateAll((els) => els.map((e) => e.id));
    const idxTodo = colOrder.indexOf(`column-${todoStatusId}`);
    const idxInProg = colOrder.indexOf(`column-${inProgressStatusId}`);
    const idxReview = colOrder.indexOf(`column-${inReviewStatusId}`);
    expect(idxTodo).toBeGreaterThanOrEqual(0);
    expect(idxTodo).toBeLessThan(idxInProg);
    expect(idxInProg).toBeLessThan(idxReview);

    // Nothing focused before the first keypress.
    await expect(
      page.locator(`[aria-current="true"][aria-label*="${marker}"]`),
    ).toHaveCount(0);

    // --- Seed: any nav key lands on the first card of the first non-empty col -
    await pressNavKey(page, "ArrowDown");
    await expectFocused(page, todoTitles[0]);

    // --- Vertical down (ArrowDown, then vim j) ------------------------------
    await pressNavKey(page, "ArrowDown");
    await expectFocused(page, todoTitles[1]);
    await pressNavKey(page, "j");
    await expectFocused(page, todoTitles[2]);

    // --- Clamp at bottom edge (stays on last card) --------------------------
    await pressNavKey(page, "ArrowDown");
    await expectFocused(page, todoTitles[2]);

    // --- Vertical up (ArrowUp, then vim k) ----------------------------------
    await pressNavKey(page, "ArrowUp");
    await expectFocused(page, todoTitles[1]);
    await pressNavKey(page, "k");
    await expectFocused(page, todoTitles[0]);

    // --- Clamp at top edge (stays on first card) ----------------------------
    await pressNavKey(page, "ArrowUp");
    await expectFocused(page, todoTitles[0]);

    // --- Horizontal right SKIPS the empty In Progress column ----------------
    // From Todo row 0 → over empty In Progress → In Review row min(0,1)=0.
    await pressNavKey(page, "ArrowRight");
    await expectFocused(page, reviewTitles[0]);

    // --- Horizontal left skips back over the empty column -------------------
    await pressNavKey(page, "ArrowLeft");
    await expectFocused(page, todoTitles[0]);

    // --- Horizontal right with row CLAMP ------------------------------------
    // Drop to Todo row 2, then vim l → In Review clamps row min(2,1)=1.
    await pressNavKey(page, "ArrowDown");
    await pressNavKey(page, "ArrowDown");
    await expectFocused(page, todoTitles[2]);
    await pressNavKey(page, "l");
    await expectFocused(page, reviewTitles[1]);

    // --- Clamp at right edge (no further non-empty column) ------------------
    await pressNavKey(page, "ArrowRight");
    await expectFocused(page, reviewTitles[1]);

    // --- vim h moves left, preserving the clamped row -----------------------
    // From In Review row 1 → Todo row min(1,2)=1.
    await pressNavKey(page, "h");
    await expectFocused(page, todoTitles[1]);
  });
});
