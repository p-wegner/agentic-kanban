// @covers board-ui.realtime.reflectServerChange [concurrency]
import { test, expect, type APIRequestContext } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

/**
 * board-ui.realtime.reflectServerChange — the rendered card must RELOCATE to the
 * new column in the live UI when a ticket's status is changed server-side
 * (agent / monitor / MCP / CLI / REST), WITHOUT a manual refresh.
 *
 * The existing board-realtime.test.ts ("status changes via API") only asserts the
 * SERVER board reflects the move — it never checks the DOM relocated the card.
 * On an agent-driven board, live card relocation (WS push + coalesced refetch) is
 * the headline value, so here we assert the OUTCOME on the rendered board:
 *   - the card appears under the TARGET column's DOM subtree, and
 *   - it is ABSENT from the SOURCE column,
 * with NO page.goto / reload between the server-side change and the assertion.
 *
 * Concurrency dimension: two concurrent server-side status changes must CONVERGE
 * to the server-final column in the live UI — the card ends up present in EXACTLY
 * one column (no lost-update duplicate, no card stranded in the source column).
 * (Realtime here is full-refetch-based, so this asserts the user-visible
 * convergence OUTCOME; it does not — and does not claim to — exercise an internal
 * out-of-order sequence-guard, which a full refetch would self-heal regardless.)
 *
 * Mutation rationale: if the WS-push + coalesced-refetch wiring were broken so the
 * UI updated the server but NOT the DOM, the card would stay in its original
 * column. The `cardInTarget` (toHaveCount 1) assertion would go RED and the
 * `cardInSource` (toHaveCount 0) assertion would go RED — these assertions read the
 * actual rendered column subtrees, not the API. The board-server poll/REST is
 * deliberately NOT consulted for the relocation assertion, so a green run proves
 * the rendered card moved, not merely that the server persisted the change.
 * (toHaveCount is used over toBeVisible so the in-DOM presence check stays robust
 * against column virtualization at >15 cards.)
 */

async function getStatuses(
  request: APIRequestContext,
  projectId: string,
): Promise<{ id: string; name: string }[]> {
  const res = await request.get(`${SERVER_URL}/api/projects/${projectId}/statuses`);
  if (!res.ok()) throw new Error(`statuses ${res.status()}`);
  return res.json();
}

test.describe("Board real-time card relocation", () => {
  // Statuses whose columns are rendered in a separate "archive" tray (not as a
  // normal `#column-…` board column) — avoid them for relocation assertions.
  const ARCHIVE_STATUS_NAMES = new Set(["Done", "Cancelled", "Backlog"]);

  let projectId: string;
  let todoStatusId: string;
  let inProgressStatusId: string;
  // A second NON-archive column target distinct from Todo / In Progress, used for
  // the concurrency convergence test (its card stays in a real board column).
  let secondTargetId: string;
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

    // Pick a second non-archive column DISTINCT from Todo / In Progress (e.g. "In Review")
    // so the concurrency test's two PATCH targets are genuinely different rendered
    // board columns. No silent fallback to In Progress — that would make both PATCHes
    // hit the same status and double-count the single card (deterministic false failure).
    const second = statuses.find(
      (s) =>
        !ARCHIVE_STATUS_NAMES.has(s.name) &&
        s.id !== todoStatusId &&
        s.id !== inProgressStatusId,
    );
    if (!second) {
      throw new Error(
        "[setup] need a third distinct non-archive column (besides Todo and In Progress) " +
          "for the concurrency convergence test; none found. Available non-archive: " +
          statuses
            .filter((s) => !ARCHIVE_STATUS_NAMES.has(s.name))
            .map((s) => s.name)
            .join(", "),
      );
    }
    secondTargetId = second.id;

    suffix = Date.now().toString(36);
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`).catch(() => {});
    }
  });

  test("server-side status change relocates the rendered card to the new column without a refresh", async ({
    page,
    request,
  }) => {
    const title = `RelocateRT ${suffix}`;

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

    // Precondition: the card starts rendered in Todo (board open + WS connected).
    // toHaveCount(1) (in-DOM) over toBeVisible so it's robust to column virtualization.
    await expect(cardInTodo).toHaveCount(1, { timeout: 10000 });
    await expect(cardInProgress).toHaveCount(0);

    // Act: change status server-side (simulating an agent/monitor/MCP/CLI/REST mutation).
    // No page.goto / reload after this point — the UI must self-update.
    const patchRes = await request.patch(`${SERVER_URL}/api/issues/${issueId}`, {
      data: { statusId: inProgressStatusId },
    });
    expect(patchRes.ok()).toBe(true);

    // Assert (the headline outcome): the rendered card relocated to In Progress...
    await expect(cardInProgress).toHaveCount(1, { timeout: 10000 });
    // ...and is gone from its old column — proves a real relocation, not a duplicate.
    await expect(cardInTodo).toHaveCount(0);
  });

  test("two rapid server-side changes converge the rendered card to the correct final column", async ({
    page,
    request,
  }) => {
    const title = `RelocateConcur ${suffix}`;

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

    const cardInTodo = page.locator(`#column-${todoStatusId}`).getByLabel(`Open issue ${title}`);
    const cardInProgress = page
      .locator(`#column-${inProgressStatusId}`)
      .getByLabel(`Open issue ${title}`);
    const cardInSecond = page.locator(`#column-${secondTargetId}`).getByLabel(`Open issue ${title}`);

    await expect(cardInTodo).toHaveCount(1, { timeout: 10000 });

    // Concurrency: fire two server-side moves at once (Todo→In Progress and
    // Todo→second-target) so the resulting WS pushes / coalesced refetches overlap.
    // The board must converge to whichever the server records as FINAL — no card
    // stranded in an intermediate column, no duplicate render.
    const [r1, r2] = await Promise.all([
      request.patch(`${SERVER_URL}/api/issues/${issueId}`, {
        data: { statusId: inProgressStatusId },
      }),
      request.patch(`${SERVER_URL}/api/issues/${issueId}`, {
        data: { statusId: secondTargetId },
      }),
    ]);
    expect(r1.ok()).toBe(true);
    expect(r2.ok()).toBe(true);

    // Read the server's CONVERGED final column (order of two parallel PATCHes is
    // non-deterministic) — the UI must match this exact column, whichever won.
    await expect
      .poll(async () => {
        const res = await request.get(`${SERVER_URL}/api/issues/${issueId}`);
        const sid = (await res.json()).statusId as string;
        return sid === inProgressStatusId || sid === secondTargetId;
      }, { timeout: 10000 })
      .toBe(true);
    const finalRes = await request.get(`${SERVER_URL}/api/issues/${issueId}`);
    const finalStatusId = (await finalRes.json()).statusId as string;

    const cardInFinal = page.locator(`#column-${finalStatusId}`).getByLabel(`Open issue ${title}`);

    // Outcome: the rendered card converged to the server's final column and is gone
    // from Todo (never stranded in the source column). toHaveCount keeps this robust
    // to column virtualization (a card below the fold is still in the DOM).
    await expect(cardInFinal).toHaveCount(1, { timeout: 10000 });
    await expect(cardInTodo).toHaveCount(0);

    // Present in EXACTLY one of the two candidate columns (no lost-update duplicate).
    const inProgressCount = await cardInProgress.count();
    const secondCount = await cardInSecond.count();
    expect(inProgressCount + secondCount).toBe(1);
  });
});
