import { test, expect } from "@playwright/test";

test.describe("Board Events API", () => {
  let projectId: string;
  let statusId: string;

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get("http://localhost:3001/api/projects");
    const projects = await projectsRes.json();
    projectId = projects[0].id;

    const statusesRes = await request.get(
      `http://localhost:3001/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todoStatus ? todoStatus.id : statuses[0].id;
  });

  test("WS /ws/board/:projectId receives board_changed event on issue create", async ({
    page,
    request,
  }) => {
    // Navigate to establish browser context
    await page.goto("/");
    await page.waitForSelector("h2");

    // Set up WebSocket listener that filters for issue_created
    const wsMessagePromise = page.evaluate((pid) => {
      return new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://localhost:3001/ws/board/${pid}`);
        ws.onmessage = (event) => {
          const data = JSON.parse(event.data as string);
          if (data.type === "board_changed" && data.reason === "issue_created") {
            resolve(event.data as string);
            ws.close();
          }
        };
      });
    }, projectId);

    // Small delay to ensure WS is connected
    await page.waitForTimeout(500);

    // Create an issue via API
    const issueRes = await request.post("http://localhost:3001/api/issues", {
      data: {
        title: "Board events test issue",
        statusId,
        projectId,
      },
    });
    expect(issueRes.status()).toBe(201);

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
    const issueRes = await request.post("http://localhost:3001/api/issues", {
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
    const wsMessagePromise = page.evaluate((pid) => {
      return new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://localhost:3001/ws/board/${pid}`);
        ws.onmessage = (event) => {
          const data = JSON.parse(event.data as string);
          if (data.type === "board_changed" && data.reason === "issue_updated") {
            resolve(event.data as string);
            ws.close();
          }
        };
      });
    }, projectId);

    await page.waitForTimeout(500);

    // Update the issue
    await request.patch(`http://localhost:3001/api/issues/${issueId}`, {
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
    const issueRes = await request.post("http://localhost:3001/api/issues", {
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
    const wsMessagePromise = page.evaluate((pid) => {
      return new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://localhost:3001/ws/board/${pid}`);
        ws.onmessage = (event) => {
          const data = JSON.parse(event.data as string);
          if (data.type === "board_changed" && data.reason === "issue_deleted") {
            resolve(event.data as string);
            ws.close();
          }
        };
      });
    }, projectId);

    await page.waitForTimeout(500);

    // Delete the issue
    await request.delete(`http://localhost:3001/api/issues/${issueId}`);

    const messageStr = await wsMessagePromise;
    const message = JSON.parse(messageStr);

    expect(message.type).toBe("board_changed");
    expect(message.reason).toBe("issue_deleted");
  });
});
