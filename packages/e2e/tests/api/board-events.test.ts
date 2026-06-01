import { test, expect } from "@playwright/test";
import { SERVER_URL, SERVER_PORT } from "../helpers/port.js";

const BOARD_EVENT_TIMEOUT_MS = 5_000;

function withEventTimeout<T>(
  promise: Promise<T>,
  expectedEvent: string,
  getDiagnostics?: () => Promise<string>,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(async () => {
      const diagnostics = getDiagnostics ? await getDiagnostics() : "";
      reject(
        new Error(
          [
            `Timed out after ${BOARD_EVENT_TIMEOUT_MS}ms waiting for ${expectedEvent}`,
            diagnostics,
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      );
    }, BOARD_EVENT_TIMEOUT_MS);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

function describeBoardEventState(
  ws: WebSocket,
  reason: string,
  getLastMessage: () => string | undefined,
  getLastError: () => string | undefined,
): Promise<string> {
  return Promise.resolve(
    [
      `Expected reason: ${reason}`,
      `WebSocket readyState: ${ws.readyState}`,
      `Last message: ${getLastMessage() ?? "none"}`,
      `Last error: ${getLastError() ?? "none"}`,
    ].join("\n"),
  );
}

async function listenForBoardEvent(
  projectId: string,
  reason: string,
): Promise<{ messagePromise: Promise<string>; close: () => void }> {
  let lastMessage: string | undefined;
  let lastError: string | undefined;
  let messageSettled = false;
  const ws = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/ws/board/${projectId}`);
  const diagnostics = () =>
    describeBoardEventState(ws, reason, () => lastMessage, () => lastError);

  const messagePromise = new Promise<string>((resolveMessage, rejectMessage) => {
    ws.addEventListener("message", (event) => {
      const message = String(event.data);
      lastMessage = message;
      let data: { type?: string; reason?: string };
      try {
        data = JSON.parse(message);
      } catch {
        lastError = `Received non-JSON WebSocket message before board_changed event with reason "${reason}"`;
        messageSettled = true;
        rejectMessage(new Error(lastError));
        return;
      }

      if (data.type === "board_changed" && data.reason === reason) {
        messageSettled = true;
        resolveMessage(message);
        ws.close();
      }
    });

    ws.addEventListener("close", () => {
      if (messageSettled) return;
      lastError = `WebSocket closed before board_changed event with reason "${reason}"`;
      messageSettled = true;
      rejectMessage(new Error(lastError));
    });
  });

  await withEventTimeout(
    new Promise<void>((resolveOpen, rejectOpen) => {
      ws.addEventListener("open", () => {
        if (ws.readyState === WebSocket.OPEN) {
          resolveOpen();
          return;
        }

        lastError = `WebSocket open event fired with readyState ${ws.readyState}`;
        rejectOpen(new Error(lastError));
      });
      ws.addEventListener("error", () => {
        lastError = `WebSocket error before board_changed event with reason "${reason}"`;
        rejectOpen(new Error(lastError));
      });
    }),
    `WebSocket OPEN before board_changed event with reason "${reason}"`,
    diagnostics,
  );

  return {
    messagePromise: withEventTimeout(
      messagePromise,
      `board_changed event with reason "${reason}"`,
      diagnostics,
    ),
    close: () => ws.close(),
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
    request,
  }) => {
    const listener = await listenForBoardEvent(projectId, "issue_created");

    const suffix = Date.now().toString(36);
    let messageStr = "";
    try {
      const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
        data: {
          title: `Board events test issue ${suffix}`,
          statusId,
          projectId,
        },
      });
      expect(issueRes.status()).toBe(201);
      createdIssueIds.push((await issueRes.json()).id);

      messageStr = await listener.messagePromise;
    } finally {
      listener.close();
    }
    const message = JSON.parse(messageStr);

    expect(message.type).toBe("board_changed");
    expect(message.projectId).toBe(projectId);
    expect(message.reason).toBe("issue_created");
  });

  test("WS /ws/board/:projectId receives event on issue update", async ({
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
    createdIssueIds.push(issueId);

    const listener = await listenForBoardEvent(projectId, "issue_updated");

    let messageStr = "";
    try {
      await request.patch(`${SERVER_URL}/api/issues/${issueId}`, {
        data: { title: "Board events updated title" },
      });

      messageStr = await listener.messagePromise;
    } finally {
      listener.close();
    }
    const message = JSON.parse(messageStr);

    expect(message.type).toBe("board_changed");
    expect(message.reason).toBe("issue_updated");
  });

  test("WS /ws/board/:projectId receives event on issue delete", async ({
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

    const listener = await listenForBoardEvent(projectId, "issue_deleted");

    let messageStr = "";
    try {
      await request.delete(`${SERVER_URL}/api/issues/${issueId}`);

      messageStr = await listener.messagePromise;
    } finally {
      listener.close();
    }
    const message = JSON.parse(messageStr);

    expect(message.type).toBe("board_changed");
    expect(message.reason).toBe("issue_deleted");
  });
});
