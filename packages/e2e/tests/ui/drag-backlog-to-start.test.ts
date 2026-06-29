import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

test.describe("Drag backlog card onto empty agent slot", () => {
  let projectId: string;
  let backlogStatusId: string;
  let suffix: string;
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

    const statuses: { id: string; name: string }[] = await withRetry(async () => {
      const res = await request.get(`${SERVER_URL}/api/projects/${projectId}/statuses`);
      if (!res.ok()) throw new Error(`statuses ${res.status()}`);
      return res.json();
    }, "fetch statuses");

    const backlog = statuses.find((s) => s.name === "Backlog");
    if (!backlog) {
      throw new Error(
        `[beforeAll] No 'Backlog' status found — available: ${statuses.map((s) => s.name).join(", ")}`,
      );
    }
    backlogStatusId = backlog.id;

    suffix = Date.now().toString(36);

    // Use mock agent so workspace creation doesn't spawn a real Claude process.
    // Turn off auto_review / auto_merge to keep workspace in a predictable state.
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: {
        claude_profile: "mock",
        auto_review: "false",
        auto_merge: "false",
        // Ensure activeAgentsTarget >= 1 so EmptySlot renders on the agents view.
        nudge_wip_limit: "3",
      },
    });
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdWorkspaceIds) {
      await request.delete(`${SERVER_URL}/api/workspaces/${id}`);
    }
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
    // Restore all preferences mutated by this suite.
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: {
        claude_profile: "",
        auto_review: "true",
        auto_merge: "true",
        nudge_wip_limit: "",
      },
    });
  });

  test("dragging a backlog card onto an empty agent slot creates a workspace and moves the issue to In Progress", async ({
    page,
    request,
  }) => {
    const title = `DragStart ${suffix}`;

    // Create a Backlog issue via API.
    const issueId = await withRetry(async () => {
      const res = await request.post(`${SERVER_URL}/api/issues`, {
        data: { title, statusId: backlogStatusId, projectId, priority: "medium" },
      });
      if (!res.ok()) throw new Error(`create issue ${res.status()}`);
      return (await res.json()).id as string;
    }, "create issue");
    createdIssueIds.push(issueId);

    // The backlog card (the drag SOURCE) lives on the Backlog view; the EmptySlot
    // drop target lives on the agents view. The board's drag payload is a
    // module-level singleton (getBoardDragData), populated only by a card's real
    // onDragStart handler — it survives an in-app (no-reload) view switch. So we
    // fire a real `dragstart` on the backlog card here, then SPA-navigate to the
    // agents view (the payload persists) and drop onto the empty slot.
    await page.goto("/backlog");
    const backlogCard = page.getByLabel(`Open issue ${title}`);
    await expect(backlogCard).toBeVisible({ timeout: 15000 });

    await page.evaluate(({ cardLabel }) => {
      const card = document.querySelector<HTMLElement>(
        `[aria-label="Open issue ${cardLabel}"]`,
      );
      if (!card) throw new Error(`backlog card "${cardLabel}" not found`);

      // Real dragstart → the app's onDragStart populates the module-level payload.
      const startEvent = new DragEvent("dragstart", { bubbles: true, cancelable: true });
      Object.defineProperty(startEvent, "dataTransfer", { value: new DataTransfer() });
      card.dispatchEvent(startEvent);

      // In-app navigation (no reload) to the agents view so the module-level drag
      // payload set above is preserved (a full page.goto would reset the module).
      window.history.pushState(null, "", "/agents");
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, { cardLabel: title });

    await page.waitForSelector("[data-testid='board-stats-bar']", { timeout: 15000 });

    // The EmptySlot renders "Drop issue here" when no drag is in progress.
    // It only appears when activeAgentsTarget > activeAgentCount, which we've ensured
    // by setting nudge_wip_limit=3 above.
    const emptySlot = page.locator("p", { hasText: "Drop issue here" }).first();
    await expect(emptySlot).toBeVisible({ timeout: 10000 });

    // Dispatch the drag-over + drop on the EmptySlot container. React 17+ uses root
    // delegation, so native DragEvents bubble up to its handlers. The handlers read
    // the persisted module payload (not the dead `window.__dragData` global) to
    // resolve the dragged issue.
    await page.evaluate(() => {
      // Find the EmptySlot container div (parent of the "Drop issue here" paragraph).
      const para = Array.from(document.querySelectorAll("p")).find(
        (el) => el.textContent?.trim() === "Drop issue here",
      );
      const slot = para?.parentElement;
      if (!slot) throw new Error("EmptySlot container not found");

      const dragover = new DragEvent("dragover", { bubbles: true, cancelable: true });
      Object.defineProperty(dragover, "dataTransfer", { value: new DataTransfer() });
      slot.dispatchEvent(dragover);

      const drop = new DragEvent("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(drop, "dataTransfer", { value: new DataTransfer() });
      slot.dispatchEvent(drop);
    });

    // Assert 1: a workspace was created for this issue.
    // Poll the board until the issue has a workspaceSummary.
    // Use withRetry inside poll to survive transient ECONNRESET during workspace creation.
    await expect
      .poll(
        async () => {
          try {
            const res = await request.get(`${SERVER_URL}/api/projects/${projectId}/board`);
            if (!res.ok()) return 0;
            const board: { issues: { id: string; workspaceSummary?: { total: number; main?: { id: string; status: string } } }[] }[] =
              await res.json();
            return board.flatMap((col) => col.issues).find((i) => i.id === issueId)
              ?.workspaceSummary?.total ?? 0;
          } catch {
            return 0;
          }
        },
        { timeout: 20000, intervals: [500, 1000, 1500] },
      )
      .toBeGreaterThan(0);

    // Collect workspace ID for cleanup and verify workspace status.
    const boardRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/board`);
    const board: { name: string; issues: { id: string; workspaceSummary?: { total: number; main?: { id: string; status: string } } }[] }[] =
      await boardRes.json();
    const allIssues = board.flatMap((col) => col.issues);
    const issueOnBoard = allIssues.find((i) => i.id === issueId);
    const wsId = issueOnBoard?.workspaceSummary?.main?.id;
    if (wsId) createdWorkspaceIds.push(wsId);

    // Assert 2: the workspace was created (status is active or idle — mock agent exits quickly).
    expect(["active", "idle"]).toContain(issueOnBoard?.workspaceSummary?.main?.status);

    // Assert 3: the issue has moved to "In Progress" on the board.
    const inProgressCol = board.find((col) => col.name === "In Progress");
    expect(inProgressCol).toBeDefined();
    expect(inProgressCol?.issues.some((i) => i.id === issueId)).toBe(true);
  });
});
