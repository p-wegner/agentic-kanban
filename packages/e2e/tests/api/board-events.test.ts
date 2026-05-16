import { test, expect } from "@playwright/test";
import { SERVER_URL, SERVER_PORT } from "../helpers/port.js";

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

    // Set up WebSocket listener that filters for issue_created
    const wsMessagePromise = page.evaluate(([pid, port]) => {
      return new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://localhost:${port}/ws/board/${pid}`);
        ws.onmessage = (event) => {
          const data = JSON.parse(event.data as string);
          if (data.type === "board_changed" && data.reason === "issue_created") {
            resolve(event.data as string);
            ws.close();
          }
        };
      });
    }, [projectId, SERVER_PORT] as [string, number]);

    // Small delay to ensure WS is connected
    await page.waitForTimeout(500);

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

    // Set up WS listener that filters for issue_updated
    const wsMessagePromise = page.evaluate(([pid, port]) => {
      return new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://localhost:${port}/ws/board/${pid}`);
        ws.onmessage = (event) => {
          const data = JSON.parse(event.data as string);
          if (data.type === "board_changed" && data.reason === "issue_updated") {
            resolve(event.data as string);
            ws.close();
          }
        };
      });
    }, [projectId, SERVER_PORT] as [string, number]);

    await page.waitForTimeout(500);

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

    // Set up WS listener that filters for issue_deleted
    const wsMessagePromise = page.evaluate(([pid, port]) => {
      return new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://localhost:${port}/ws/board/${pid}`);
        ws.onmessage = (event) => {
          const data = JSON.parse(event.data as string);
          if (data.type === "board_changed" && data.reason === "issue_deleted") {
            resolve(event.data as string);
            ws.close();
          }
        };
      });
    }, [projectId, SERVER_PORT] as [string, number]);

    await page.waitForTimeout(500);

    // Delete the issue
    await request.delete(`${SERVER_URL}/api/issues/${issueId}`);

    const messageStr = await wsMessagePromise;
    const message = JSON.parse(messageStr);

    expect(message.type).toBe("board_changed");
    expect(message.reason).toBe("issue_deleted");
  });
});
