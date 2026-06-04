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

    // Navigate to the agents view — this is where the EmptySlot drop targets live.
    await page.goto("/agents");
    await page.waitForSelector("[data-testid='board-stats-bar']", { timeout: 15000 });

    // The EmptySlot renders "Drop issue here" when no drag is in progress.
    // It only appears when activeAgentsTarget > activeAgentCount, which we've ensured
    // by setting nudge_wip_limit=3 above.
    const emptySlot = page.locator("p", { hasText: "Drop issue here" }).first();
    await expect(emptySlot).toBeVisible({ timeout: 10000 });

    // Simulate the drag: set window.__dragData (as IssueCard's onDragStart would),
    // then dispatch proper DragEvents on the EmptySlot container.
    // React 17+ uses root delegation — dispatching native DragEvents bubbles up correctly.
    // We use page.evaluate for both steps so __dragData is set before the events fire.
    await page.evaluate(
      ({ id, statusId, slotSelector }) => {
        // Step 1: set drag data (normally set by IssueCard's onDragStart).
        (window as unknown as Record<string, unknown>).__dragData = {
          issueId: id,
          sourceStatusId: statusId,
        };

        // Step 2: find the EmptySlot container div (parent of the "Drop issue here" paragraph).
        const para = Array.from(document.querySelectorAll("p")).find(
          (el) => el.textContent?.trim() === "Drop issue here",
        );
        const slot = para?.parentElement;
        if (!slot) throw new Error(`EmptySlot not found via selector "${slotSelector}"`);

        // Step 3: dispatch DragEvent — needed so React receives the right event type.
        const dragover = new DragEvent("dragover", { bubbles: true, cancelable: true });
        slot.dispatchEvent(dragover);

        const drop = new DragEvent("drop", { bubbles: true, cancelable: true });
        slot.dispatchEvent(drop);
      },
      { id: issueId, statusId: backlogStatusId, slotSelector: "p:has-text('Drop issue here')" },
    );

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
