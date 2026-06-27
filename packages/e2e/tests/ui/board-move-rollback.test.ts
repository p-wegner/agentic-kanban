// @covers board-ui.move.rollback [error-handling,state-transition]
import { test, expect, type APIRequestContext } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

/**
 * board-ui.move.rollback — a server-REJECTED optimistic move must snap the card
 * back to its exact prior column and surface the server's rejection message.
 *
 * The happy-path drag is covered by board.test.ts ("drag issue between columns").
 * Here we force the PATCH /api/issues/:id to fail (page.route → 409 with a server
 * error body), drop the card into another column, and assert the rollback:
 *   1. the server error message is surfaced to the user (error toast), and
 *   2. the card is back in its ORIGINAL column, NOT the drop target.
 *
 * Mutation rationale: if the catch-branch rollback in useBoardIssueMovement.handleDrop
 * (setColumns(snapshotColumns)) were removed, the optimistic move would leave the card
 * stuck in the target column after the PATCH fails — the "card visible in Todo" /
 * "absent from In Progress" assertions would go RED. If the showToast(err.message)
 * were removed, the toast assertion would go RED.
 */

const REJECT_MESSAGE = "Cannot move a completed ticket back to an active column";

async function getStatuses(
  request: APIRequestContext,
  projectId: string,
): Promise<{ id: string; name: string }[]> {
  const res = await request.get(`${SERVER_URL}/api/projects/${projectId}/statuses`);
  if (!res.ok()) throw new Error(`statuses ${res.status()}`);
  return res.json();
}

test.describe("Board move rollback UI", () => {
  let projectId: string;
  let todoStatusId: string;
  let inProgressStatusId: string;
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

    const statuses = await withRetry(() => getStatuses(request, projectId), "fetch statuses");
    const todo = statuses.find((s) => s.name === "Todo") ?? statuses[0];
    const inProgress = statuses.find((s) => s.name === "In Progress") ?? statuses[1];
    todoStatusId = todo.id;
    inProgressStatusId = inProgress.id;

    suffix = Date.now().toString(36);
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`).catch(() => {});
    }
  });

  test("server-rejected move snaps the card back to its source column and surfaces the error", async ({
    page,
    request,
  }) => {
    const title = `RollbackMove ${suffix}`;

    // Arrange: a card sitting in Todo.
    const issueId = await withRetry(async () => {
      const res = await request.post(`${SERVER_URL}/api/issues`, {
        data: { title, projectId, statusId: todoStatusId },
      });
      if (!res.ok()) throw new Error(`create issue ${res.status()}`);
      return (await res.json()).id as string;
    }, "create issue");
    createdIssueIds.push(issueId);

    await page.goto("/");
    await page.waitForSelector("h2");

    const todoColumn = page.locator(`#column-${todoStatusId}`);
    const inProgressColumn = page.locator(`#column-${inProgressStatusId}`);
    const cardInTodo = todoColumn.getByLabel(`Open issue ${title}`);
    const cardInProgress = inProgressColumn.getByLabel(`Open issue ${title}`);

    // Precondition: the card starts in Todo.
    await expect(cardInTodo).toBeVisible({ timeout: 10000 });

    // Force the server to REJECT the move PATCH with a real error body.
    let patchAttempted = false;
    await page.route(`**/api/issues/${issueId}`, async (route) => {
      if (route.request().method() === "PATCH") {
        patchAttempted = true;
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: REJECT_MESSAGE }),
        });
      } else {
        await route.continue();
      }
    });

    // Act: drive a real drag — fire `dragstart` on the card so the app's
    // onDragStart handler populates its module-level drag payload (the board no
    // longer reads a window global), then dispatch `drop` on the target column.
    await page.evaluate(
      ({ cardLabel, tgtId }) => {
        const card = document.querySelector<HTMLElement>(`[aria-label="Open issue ${cardLabel}"]`);
        if (!card) throw new Error(`card "${cardLabel}" not found`);
        const targetCol = document.getElementById(`column-${tgtId}`);
        if (!targetCol) throw new Error(`target column ${tgtId} not found`);

        const startEvent = new DragEvent("dragstart", { bubbles: true, cancelable: true });
        Object.defineProperty(startEvent, "dataTransfer", { value: new DataTransfer() });
        card.dispatchEvent(startEvent);

        const dropEvent = new DragEvent("drop", { bubbles: true, cancelable: true });
        Object.defineProperty(dropEvent, "dataTransfer", { value: new DataTransfer() });
        targetCol.dispatchEvent(dropEvent);
      },
      { cardLabel: title, tgtId: inProgressStatusId },
    );

    // Assert 1 (error-handling): the server's rejection message is surfaced to the user.
    await expect(page.locator("text=" + REJECT_MESSAGE)).toBeVisible({ timeout: 10000 });

    // The move was actually attempted (guards against a false-positive where the drop never fired).
    expect(patchAttempted).toBe(true);

    // Assert 2 (state-transition): the card rolled back to its ORIGINAL column...
    await expect(cardInTodo).toBeVisible();
    // ...and is NOT left stranded in the drop target.
    await expect(cardInProgress).toHaveCount(0);

    // And the server's persisted state still matches the pre-move snapshot (Todo).
    await expect
      .poll(async () => {
        const boardRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/board`);
        const board: { name: string; issues: { title: string }[] }[] = await boardRes.json();
        return board.find((c) => c.issues.some((i) => i.title === title))?.name ?? null;
      }, { timeout: 5000 })
      .toBe("Todo");
  });
});
