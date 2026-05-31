import { test, expect, type Page } from "@playwright/test";
import { SERVER_URL, SERVER_PORT } from "../helpers/port.js";

const BOARD_EVENT_TIMEOUT_MS = 5_000;

function withEventTimeout<T>(
  promise: Promise<T>,
  expectedEvent: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(
          new Error(
            `Timed out after ${BOARD_EVENT_TIMEOUT_MS}ms waiting for ${expectedEvent}`,
          ),
        );
      }, BOARD_EVENT_TIMEOUT_MS);
    }),
  ]);
}

async function listenForBoardEvent(
  page: Page,
  projectId: string,
  reason: string,
): Promise<{ messagePromise: Promise<string> }> {
  await withEventTimeout(
    page.evaluate(
      ([pid, port, expectedReason]) => {
        const state = window as unknown as {
          __boardEventTestEventPromise: Promise<string>;
        };

        return new Promise<void>((resolveOpen, rejectOpen) => {
          let opened = false;
          const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/board/${pid}`);

          state.__boardEventTestEventPromise = new Promise<string>(
            (resolveMessage, rejectMessage) => {
              const rejectConnection = (message: string) => {
                const error = new Error(message);
                if (!opened) {
                  rejectOpen(error);
                }
                rejectMessage(error);
              };

              ws.onopen = () => {
                if (ws.readyState === WebSocket.OPEN) {
                  opened = true;
                  resolveOpen();
                }
              };
              ws.onerror = () => {
                rejectConnection(
                  `WebSocket error before board_changed event with reason "${expectedReason}"`,
                );
              };
              ws.onmessage = (event) => {
                const data = JSON.parse(event.data as string);
                if (
                  data.type === "board_changed" &&
                  data.reason === expectedReason
                ) {
                  resolveMessage(event.data as string);
                  ws.close();
                }
              };
            },
          );
        });
      },
      [projectId, SERVER_PORT, reason] as [string, number, string],
    ),
    `WebSocket OPEN before board_changed event with reason "${reason}"`,
  );

  return {
    messagePromise: withEventTimeout(
      page.evaluate(() => {
        const state = window as unknown as {
          __boardEventTestEventPromise: Promise<string>;
        };
        return state.__boardEventTestEventPromise;
      }),
      `board_changed event with reason "${reason}"`,
    ),
  };
}

test.describe("Board Events API", () => {
  let projectId: string;
  let statusId: string;
  const createdIssueIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get(`${SERVER_URL}/api/projects`);
    const projects = await projectsRes.json();
    projectId = projects[0].id;

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todoStatus ? todoStatus.id : statuses[0].id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  test("WS /ws/board/:projectId receives board_changed event on issue create", async ({
    page,
    request,
  }) => {
    // Navigate to establish browser context
    await page.goto("/");
    await page.waitForSelector("h2");

    const { messagePromise: wsMessagePromise } = await listenForBoardEvent(
      page,
      projectId,
      "issue_created",
    );

    const suffix = Date.now().toString(36);
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: `Board events test issue ${suffix}`,
        statusId,
        projectId,
      },
    });
    expect(issueRes.status()).toBe(201);
    createdIssueIds.push((await issueRes.json()).id);

    // Wait for the board_changed event
    const messageStr = await wsMessagePromise;
    const message = JSON.parse(messageStr);

    expect(message.type).toBe("board_changed");
    expect(message.projectId).toBe(projectId);
    expect(message.reason).toBe("issue_created");
  });

  test("WS /ws/board/:projectId receives event on issue update", async ({
    page,
    request,
  }) => {
    // Create an issue first
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: "Board events update test",
        statusId,
        projectId,
      },
    });
    const { id: issueId } = await issueRes.json();

    await page.goto("/");
    await page.waitForSelector("h2");

    const { messagePromise: wsMessagePromise } = await listenForBoardEvent(
      page,
      projectId,
      "issue_updated",
    );

    // Update the issue
    await request.patch(`${SERVER_URL}/api/issues/${issueId}`, {
      data: { title: "Board events updated title" },
    });

    const messageStr = await wsMessagePromise;
    const message = JSON.parse(messageStr);

    expect(message.type).toBe("board_changed");
    expect(message.reason).toBe("issue_updated");
  });

  test("WS /ws/board/:projectId receives event on issue delete", async ({
    page,
    request,
  }) => {
    // Create an issue
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: "Board events delete test",
        statusId,
        projectId,
      },
    });
    const { id: issueId } = await issueRes.json();

    await page.goto("/");
    await page.waitForSelector("h2");

    const { messagePromise: wsMessagePromise } = await listenForBoardEvent(
      page,
      projectId,
      "issue_deleted",
    );

    // Delete the issue
    await request.delete(`${SERVER_URL}/api/issues/${issueId}`);

    const messageStr = await wsMessagePromise;
    const message = JSON.parse(messageStr);

    expect(message.type).toBe("board_changed");
    expect(message.reason).toBe("issue_deleted");
  });
});
