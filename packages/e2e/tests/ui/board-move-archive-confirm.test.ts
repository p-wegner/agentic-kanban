// @covers board-ui.move.archiveConfirm [error-handling,state-transition]
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

/**
 * board-ui.move.archiveConfirm — moving a ticket that still has a LIVE (non-closed)
 * workspace into an archive column (Done/Cancelled) must pop a blocking confirm gate
 * BEFORE committing. Confirming proceeds (issue lands in Done); cancelling is a no-op
 * (the card stays in its original column, the workspace untouched).
 *
 * This is high blast-radius: the gate is what stops a stray drag from silently
 * discarding in-flight agent work. The only neighbouring terminal-move tests
 * (ai-reviewed-column.test.ts) move issues WITHOUT a live workspace, so the gate
 * never fires there — this is the first test that exercises it.
 *
 * Workflow modelled (a real operator journey):
 *   1. seed an issue + a real (mock-agent) workspace, let it reach idle (non-closed),
 *   2. open the board, expand the Completed (archive) drop zone,
 *   3. drag the workspace-bearing card onto Done → assert the "Move to Done" confirm
 *      dialog blocks the move,
 *   4. Cancel → dialog closes AND the server board still shows the issue in its
 *      original column (no PATCH ran),
 *   5. drag again, choose "Delete workspace & move to Done" → dialog closes AND the
 *      server board now shows the issue in Done (the move commits only on confirm).
 *
 * Mutation rationale: the gate lives in useBoardIssueMovement.handleDrop —
 *   `if (issue && ws && ws.status !== "closed") { setMoveToDonePending(...); return; }`.
 *   • If that guard were removed (archive happens with no confirmation), the first
 *     drop would optimistically move the card + PATCH straight to Done: the "dialog
 *     visible" assertion goes RED, and the post-cancel "issue still NOT in Done"
 *     assertion goes RED (it would already be in Done).
 *   • If Cancel failed to no-op (e.g. it ran the confirm callback instead of just
 *     clearing the pending state), the post-cancel "issue still in original column"
 *     poll goes RED.
 *   • If the confirm path were broken (PATCH never fired), the final "issue in Done"
 *     poll goes RED.
 */

const ARCHIVE_DROP_ZONE = "#completed-grid-scroll";

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

test.describe("Board move archive-confirm UI", () => {
  let projectId: string;
  let todoStatusId: string;
  let doneStatusId: string;
  let suffix: string;
  let mainIssueId: string;
  let mainTitle: string;
  let originalColumnName: string;
  const createdIssueIds: string[] = [];
  const createdWorkspaceIds: string[] = [];

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
      return res.json() as Promise<{ id: string; name: string }[]>;
    }, "fetch statuses");
    const todo = statuses.find((s) => s.name === "Todo") ?? statuses[0];
    const done = statuses.find((s) => s.name === "Done");
    if (!done) throw new Error("E2E project has no 'Done' status — cannot test archive confirm");
    todoStatusId = todo.id;
    doneStatusId = done.id;

    // Mock agent (exits fast) + no auto-review/merge so the workspace settles at
    // `idle` (non-closed) and is NOT auto-merged away mid-test.
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { claude_profile: "mock", auto_review: "false", auto_merge: "false" },
    });

    suffix = Date.now().toString(36);

    // (a) A throwaway issue already in Done, so the collapsed "Completed" archive
    // bar (and its drop zone) actually renders — CompletedGrid returns null when
    // there are zero completed issues.
    const seedId = await withRetry(async () => {
      const res = await request.post(`${SERVER_URL}/api/issues`, {
        data: { title: `ArchiveSeed ${suffix}`, projectId, statusId: doneStatusId },
      });
      if (!res.ok()) throw new Error(`seed issue ${res.status()}`);
      return (await res.json()).id as string;
    }, "create seed Done issue");
    createdIssueIds.push(seedId);

    // (b) The issue under test, with a live workspace.
    mainTitle = `ArchiveConfirm ${suffix}`;
    mainIssueId = await withRetry(async () => {
      const res = await request.post(`${SERVER_URL}/api/issues`, {
        data: { title: mainTitle, projectId, statusId: todoStatusId },
      });
      if (!res.ok()) throw new Error(`main issue ${res.status()}`);
      return (await res.json()).id as string;
    }, "create main issue");
    createdIssueIds.push(mainIssueId);

    const wsId = await withRetry(async () => {
      const res = await request.post(`${SERVER_URL}/api/workspaces`, {
        data: { issueId: mainIssueId, branch: `feature/archive-confirm-${suffix}` },
      });
      if (!res.ok()) throw new Error(`create workspace ${res.status()}`);
      return (await res.json()).id as string;
    }, "create workspace");
    createdWorkspaceIds.push(wsId);

    // The gate only fires when the board issue carries a NON-CLOSED workspaceSummary
    // (active OR idle both qualify). Wait until the board reflects a live workspace.
    await expect
      .poll(
        async () => {
          const board = await fetchBoard(request, projectId);
          const issue = board.flatMap((c) => c.issues).find((i) => i.id === mainIssueId) as
            | { workspaceSummary?: { main?: { status?: string } } }
            | undefined;
          const status = issue?.workspaceSummary?.main?.status ?? null;
          return status !== null && status !== "closed";
        },
        { timeout: 30000 },
      )
      .toBe(true);

    originalColumnName = (await issueColumnName(request, projectId, mainIssueId)) ?? "Todo";
    expect(originalColumnName).not.toBe("Done");
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdWorkspaceIds) {
      await request.delete(`${SERVER_URL}/api/workspaces/${id}`).catch(() => {});
    }
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`).catch(() => {});
    }
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { claude_profile: "", auto_review: "true", auto_merge: "true" },
    });
  });

  /** Expand the collapsed "Completed" archive group so the Done drop zone exists. */
  async function expandCompleted(page: Page) {
    const dropZone = page.locator(ARCHIVE_DROP_ZONE);
    if (await dropZone.isVisible().catch(() => false)) return;
    const completedBar = page.getByRole("button").filter({ hasText: "Completed" }).first();
    await expect(completedBar).toBeVisible({ timeout: 10000 });
    await completedBar.click();
    await expect(dropZone).toBeVisible({ timeout: 10000 });
  }

  /**
   * Drive a real drag of the workspace-bearing card onto the Done drop zone:
   * fire `dragstart` on the card (populates the board's drag payload), then
   * dispatch `drop` on the archive grid (CompletedGrid.onDrop → board handleDrop
   * with the Done status id). Mirrors board-move-rollback.test.ts.
   */
  async function dragCardToDone(page: Page) {
    await page.evaluate(
      ({ cardLabel, dropSel }) => {
        const card = document.querySelector<HTMLElement>(`[aria-label="Open issue ${cardLabel}"]`);
        if (!card) throw new Error(`card "${cardLabel}" not found`);
        const target = document.querySelector<HTMLElement>(dropSel);
        if (!target) throw new Error(`archive drop zone ${dropSel} not found`);

        const startEvent = new DragEvent("dragstart", { bubbles: true, cancelable: true });
        Object.defineProperty(startEvent, "dataTransfer", { value: new DataTransfer() });
        card.dispatchEvent(startEvent);

        const dropEvent = new DragEvent("drop", { bubbles: true, cancelable: true });
        Object.defineProperty(dropEvent, "dataTransfer", { value: new DataTransfer() });
        target.dispatchEvent(dropEvent);
      },
      { cardLabel: mainTitle, dropSel: ARCHIVE_DROP_ZONE },
    );
  }

  test("archiving an issue with a live workspace gates on confirm: cancel = no-op, confirm = proceeds", async ({
    page,
    request,
  }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    // The card must be present (its column may be Todo or In Progress depending on
    // how workspace creation transitions it — locate it by its unique aria-label).
    const card = page.locator(`[aria-label="Open issue ${mainTitle}"]`);
    await expect(card).toBeVisible({ timeout: 15000 });

    await expandCompleted(page);

    // Scope every dialog selector to the modal overlay so we never collide with
    // the board's own "Cancel"/heading text (e.g. the collapsed "Cancelled" column).
    const dialog = page.locator("div.fixed.inset-0.bg-black\\/50");
    const dialogHeading = dialog.getByRole("heading", { name: "Move to Done" });
    const cancelBtn = dialog.getByRole("button", { name: "Cancel", exact: true });
    // Confirm via "Delete workspace & move to Done": this branch has an open, unmerged
    // workspace, so the server's AK-535 terminal-move guard rejects a bare status PATCH
    // ("Just move to Done"). The delete-workspace option clears the workspace first, so
    // the move commits — and it also exercises the "workspace handled" side of the gate.
    const confirmBtn = dialog.locator("button", { hasText: "Delete workspace & move to Done" });

    // --- Act 1: drag to Done → the confirm gate must block the move.
    await dragCardToDone(page);
    await expect(dialogHeading).toBeVisible({ timeout: 10000 });

    // --- Assert (error-handling): Cancel is a true no-op.
    await cancelBtn.click();
    await expect(dialogHeading).toBeHidden({ timeout: 10000 });

    // The server board still shows the issue in its ORIGINAL column — no PATCH ran.
    await expect
      .poll(() => issueColumnName(request, projectId, mainIssueId), { timeout: 5000 })
      .toBe(originalColumnName);
    expect(originalColumnName).not.toBe("Done");

    // --- Act 2: drag again, this time confirm (delete workspace & move to Done).
    await dragCardToDone(page);
    await expect(dialogHeading).toBeVisible({ timeout: 10000 });
    await confirmBtn.click();
    await expect(dialogHeading).toBeHidden({ timeout: 15000 });

    // --- Assert (state-transition): only on confirm does the issue land in Done.
    await expect
      .poll(() => issueColumnName(request, projectId, mainIssueId), { timeout: 10000 })
      .toBe("Done");
  });
});
