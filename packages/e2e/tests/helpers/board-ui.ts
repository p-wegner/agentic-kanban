import { expect, type Page } from "@playwright/test";

/**
 * Stable board locators for UI specs (#659).
 *
 * The specs in this suite were written against incidental markup — Tailwind class chains
 * (`.bg-gray-100.rounded-lg` for a column), bare `p` tags for an issue card — and every one
 * of them broke silently when the markup moved, reporting "element(s) not found" rather than
 * anything about what changed. These helpers go through hooks the components declare on
 * purpose, so a rename of a utility class cannot break a spec, and a genuinely missing
 * element still fails.
 */

/**
 * A board column by its visible name (`Todo`, `In Progress`, …).
 *
 * Filtered to the VISIBLE one: the board renders a desktop and a narrow variant of each
 * column at once and hides one by breakpoint, so an unfiltered locator matches two elements
 * and every click through it dies on a strict-mode violation.
 */
export function boardColumn(page: Page, name: string) {
  return page
    .locator(`[data-testid="board-column"][data-column-name="${name}"]`)
    .filter({ visible: true });
}

/** The Completed (archive) group's collapse/expand bar. Absent when nothing is completed. */
export function completedToggle(page: Page) {
  return page.locator('[data-testid="completed-toggle"]').filter({ visible: true });
}

/**
 * An issue card, located by the accessible name the card declares (`aria-label`), not by the
 * tag that happens to hold the title today.
 */
export function issueCard(page: Page, title: string) {
  return page.locator(`[aria-label="Open issue ${title}"]`).filter({ visible: true });
}

/**
 * Narrow the board to issues matching `query` before asserting on cards.
 *
 * REQUIRED on any board with real content: `BoardColumn` virtualizes a column past
 * VIRTUALIZE_ISSUE_THRESHOLD (15 issues), so a card outside the rendered window is not in the
 * DOM at all — a spec that creates an issue and then looks for it fails with "not found" for
 * reasons that have nothing to do with what it is testing. Specs create titles carrying a
 * unique per-run suffix; passing that suffix here leaves only their own issues on the board.
 */
export async function narrowBoardTo(page: Page, query: string) {
  const search = page.locator("#search-input");
  await expect(search).toBeVisible();
  await search.fill(query);
}
