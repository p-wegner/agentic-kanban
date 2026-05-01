import { test, expect } from "@playwright/test";

test.describe("Board API", () => {
  let projectId: string;
  let todoStatusId: string;
  let doneStatusId: string;

  test.beforeAll(async ({ request }) => {
    // Create a dedicated project for board tests
    const projRes = await request.post("http://localhost:3001/api/projects", {
      data: { name: "Board Test Project" },
    });
    projectId = (await projRes.json()).id;

    // Create statuses
    const todoRes = await request.post(
      `http://localhost:3001/api/projects/${projectId}/statuses`,
      { data: { name: "Todo", sortOrder: 0 } },
    );
    todoStatusId = (await todoRes.json()).id;

    const doneRes = await request.post(
      `http://localhost:3001/api/projects/${projectId}/statuses`,
      { data: { name: "Done", sortOrder: 1 } },
    );
    doneStatusId = (await doneRes.json()).id;

    // Create issues
    await request.post("http://localhost:3001/api/issues", {
      data: { title: "Board task 1", statusId: todoStatusId, projectId },
    });
    await request.post("http://localhost:3001/api/issues", {
      data: { title: "Board task 2", statusId: doneStatusId, projectId },
    });
  });

  test("GET /api/projects/:id/board returns statuses with nested issues", async ({
    request,
  }) => {
    const res = await request.get(
      `http://localhost:3001/api/projects/${projectId}/board`,
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    expect(body.length).toBe(2);
    expect(body[0].name).toBe("Todo");
    expect(body[0].issues.length).toBe(1);
    expect(body[0].issues[0].title).toBe("Board task 1");
    expect(body[0].issues[0].statusName).toBe("Todo");
    expect(body[1].name).toBe("Done");
    expect(body[1].issues.length).toBe(1);
  });

  test("GET /api/projects/:id/board returns 404 for missing project", async ({
    request,
  }) => {
    const res = await request.get(
      "http://localhost:3001/api/projects/00000000-0000-0000-0000-000000000000/board",
    );
    expect(res.status()).toBe(404);
  });

  test("Board endpoint includes all statuses even with no issues", async ({
    request,
  }) => {
    // Create empty status
    await request.post(
      `http://localhost:3001/api/projects/${projectId}/statuses`,
      { data: { name: "Review", sortOrder: 2 } },
    );

    const res = await request.get(
      `http://localhost:3001/api/projects/${projectId}/board`,
    );
    const body = await res.json();
    expect(body.length).toBe(3);

    const reviewCol = body.find(
      (s: { name: string }) => s.name === "Review",
    );
    expect(reviewCol).toBeDefined();
    expect(reviewCol.issues.length).toBe(0);
  });
});
