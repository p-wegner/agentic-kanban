// @covers board-ui.move.dependencyPreview [workflow, feature]
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

/**
 * board-ui.move.dependencyPreview — advancing a ticket that has DEPENDENTS (other
 * issues that depend on it) via the card's "Move to <next>" quick-action must pop a
 * dependency-impact preview BEFORE the move commits. The preview lists the affected
 * relationships; the move proceeds only on "Continue". "Cancel" is a true no-op.
 *
 * Why this is the first test of the gate: the only neighbouring move tests either
 * drag without dependencies (board.test.ts) or exercise the *archive* confirm
 * (board-move-archive-confirm.test.ts) — none seed a dependent and assert the
 * dependency-impact dialog blocks/commits a non-archive advance.
 *
 * Workflow modelled (a real operator journey):
 *   1. seed issue A (the dependency) in Todo + issue B that depends_on A,
 *      so getDependencies(A) reports B as an incoming dependent,
 *   2. open the board, hover A's card, click its "Move to <next>" quick-action,
 *   3. assert the dependency-impact preview appears and names dependent B,
 *      while the SERVER board still shows A in its original column (no move yet),
 *   4. Cancel → dialog closes AND A is still in its original column (no PATCH ran),
 *   5. trigger again, click Continue → dialog closes AND the SERVER board now shows
 *      A advanced to the next column (the move commits only on acknowledgement).
 *
 * Mutation rationale: the gate lives in useBoardIssueMovement.handleMoveToNext —
 *   it fetches /api/issues/:id/dependencies and, when `dependencies.length > 0`,
 *   `setDependencyImpactPending(...)` + `return` WITHOUT running the optimistic move;
 *   `doMove()` only runs from the dialog's `confirm` callback.
 *   • If that preview branch were removed (advance happens immediately), clicking the
 *     quick-action would PATCH A to the next status straight away: the "dialog visible"
 *     assertion goes RED, and the post-cancel "A still in original column" poll goes RED
 *     (A would already have advanced).
 *   • If Cancel ran the confirm callback instead of just clearing pending state, the
 *     post-cancel "A still in original column" poll goes RED.
 *   • If Continue were wired to NOT call doMove(), the final "A advanced" poll goes RED.
 */

async function fetchBoard(
  request: APIRequestContext,
  projectId: string,
): Promise<{ name: string; issues: { id: string }[] }[]> {
  const res = await request.get(`${SERVER_URL}/api/projects/${projectId}/board`);
  if (!res.ok()) throw new Error(`board ${res.status()}`);
  return res.json();
}

/** Status-column name the given issue currently sits in on the SERVER board, or null. */
async function issueColumnName(
  request: APIRequestContext,
  projectId: string,
  issueId: string,
): Promise<string | null> {
  const board = await fetchBoard(request, projectId);
  return board.find((c) => c.issues.some((i) => i.id === issueId))?.name ?? null;
}

test.describe("Board move dependency-impact preview UI", () => {
  let projectId: string;
  let todoStatusId: string;
  let nextStatusName: string;
  let suffix: string;
  let depTitle: string; // A — the dependency (issue under test, has a dependent)
  let dependentTitle: string; // B — depends on A
  let depIssueId: string;
  let dependentIssueId: string;
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
      return res.json() as Promise<{ id: string; name: string; sortOrder?: number }[]>;
    }, "fetch statuses");

    // Order columns the way the board does (by sortOrder) so "next status" matches
    // the UI's quick-action target exactly.
    const sorted = [...statuses].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    const todoIdx = sorted.findIndex((s) => s.name === "Todo");
    const baseIdx = todoIdx >= 0 ? todoIdx : 0;
    const todo = sorted[baseIdx];
    const next = sorted[baseIdx + 1];
    if (!next) throw new Error("E2E project has no status after the first — cannot test move-to-next");
    todoStatusId = todo.id;
    nextStatusName = next.name;

    suffix = Date.now().toString(36);

    // (A) The issue under test — the dependency that B waits on.
    depTitle = `DepImpact A ${suffix}`;
    depIssueId = await withRetry(async () => {
      const res = await request.post(`${SERVER_URL}/api/issues`, {
        data: { title: depTitle, projectId, statusId: todoStatusId },
      });
      if (!res.ok()) throw new Error(`create dep issue ${res.status()}`);
      return (await res.json()).id as string;
    }, "create dependency issue A");
    createdIssueIds.push(depIssueId);

    // (B) The dependent — it depends_on A, so A advancing affects it.
    dependentTitle = `DepImpact B ${suffix}`;
    dependentIssueId = await withRetry(async () => {
      const res = await request.post(`${SERVER_URL}/api/issues`, {
        data: { title: dependentTitle, projectId, statusId: todoStatusId },
      });
      if (!res.ok()) throw new Error(`create dependent issue ${res.status()}`);
      return (await res.json()).id as string;
    }, "create dependent issue B");
    createdIssueIds.push(dependentIssueId);

    // Edge: B depends_on A. getDependencies(A) then reports B as an INCOMING
    // dependent — which is what the impact preview surfaces.
    await withRetry(async () => {
      const res = await request.post(`${SERVER_URL}/api/issues/${dependentIssueId}/dependencies`, {
        data: { dependsOnId: depIssueId, type: "depends_on" },
      });
      if (!res.ok()) throw new Error(`add dependency ${res.status()}`);
      return res.json();
    }, "add dependency B->A");

    // Sanity: the server actually reports a dependent for A before we drive the UI.
    await expect
      .poll(
        async () => {
          const res = await request.get(`${SERVER_URL}/api/issues/${depIssueId}/dependencies`);
          if (!res.ok()) return 0;
          const info = (await res.json()) as { dependencies: { issueId: string }[] };
          // incoming dependents have issueId !== A
          return info.dependencies.filter((d) => d.issueId !== depIssueId).length;
        },
        { timeout: 10000 },
      )
      .toBeGreaterThan(0);
  });

  test.afterAll(async ({ request }) => {
    // Deleting the issues cascades their dependency edge.
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`).catch(() => {});
    }
  });

  /** Hover A's card and click its "Move to <next>" quick-action to trigger the gate. */
  async function clickMoveToNext(page: Page) {
    const card = page.locator(`[aria-label="Open issue ${depTitle}"]`);
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.scrollIntoViewIfNeeded();
    await card.hover();
    const moveBtn = card.locator(`button[title="Move to ${nextStatusName}"]`);
    await expect(moveBtn).toBeVisible({ timeout: 10000 });
    await moveBtn.click();
  }

  test("advancing a ticket with a dependent gates on the impact preview: cancel = no-op, continue = proceeds", async ({
    page,
    request,
  }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    const originalColumnName = (await issueColumnName(request, projectId, depIssueId)) ?? "Todo";
    expect(originalColumnName).not.toBe(nextStatusName);

    // Scope every dialog selector to the dependency-impact overlay (its unique
    // descriptive copy) so we never collide with the board's own "Cancel" text or
    // the archive MoveToDone dialog.
    const dialog = page
      .locator("div.fixed.inset-0.bg-black\\/50")
      .filter({ hasText: "Review dependency relationships affected" });
    const continueBtn = dialog.getByRole("button", { name: "Continue", exact: true });
    const cancelBtn = dialog.getByRole("button", { name: "Cancel", exact: true });

    // --- Act 1: advance A → the dependency-impact preview must block the move.
    await clickMoveToNext(page);
    await expect(dialog).toBeVisible({ timeout: 10000 });
    // The preview must name the affected dependent B (feature dimension).
    await expect(dialog).toContainText(dependentTitle, { timeout: 10000 });
    await expect(dialog.getByRole("heading", { name: `Move to ${nextStatusName}` })).toBeVisible();

    // --- Assert (workflow): while the preview is up, the move has NOT committed.
    expect(await issueColumnName(request, projectId, depIssueId)).toBe(originalColumnName);

    // --- Assert (no-op): Cancel closes the dialog and leaves A in place.
    await cancelBtn.click();
    await expect(dialog).toBeHidden({ timeout: 10000 });
    await expect
      .poll(() => issueColumnName(request, projectId, depIssueId), { timeout: 5000 })
      .toBe(originalColumnName);
    expect(originalColumnName).not.toBe(nextStatusName);

    // --- Act 2: advance again, this time acknowledge with Continue.
    await clickMoveToNext(page);
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await continueBtn.click();
    await expect(dialog).toBeHidden({ timeout: 10000 });

    // --- Assert (state-transition): only on acknowledgement does A advance.
    await expect
      .poll(() => issueColumnName(request, projectId, depIssueId), { timeout: 10000 })
      .toBe(nextStatusName);
  });
});
