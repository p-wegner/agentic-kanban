import { test, expect } from "@playwright/test";

test.describe("Board API", () => {
  let projectId: string;
  let todoStatusId: string;
  let doneStatusId: string;

  test.beforeAll(async ({ request }) => {
    // Get the project created by global setup
    const projectsRes = await request.get("http://localhost:3001/api/projects");
    const projects = await projectsRes.json();
    projectId = projects[0].id;

    // Create statuses
    const todoRes = await request.post(
      `http://localhost:3001/api/projects/${projectId}/statuses`,
      { data: { name: "Board Todo", sortOrder: 0 } },
    );
    todoStatusId = (await todoRes.json()).id;

    const doneRes = await request.post(
      `http://localhost:3001/api/projects/${projectId}/statuses`,
      { data: { name: "Board Done", sortOrder: 1 } },
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

    expect(body.length).toBeGreaterThanOrEqual(2);
    const todoCol = body.find((s: { name: string }) => s.name === "Board Todo");
    const doneCol = body.find((s: { name: string }) => s.name === "Board Done");
    expect(todoCol).toBeDefined();
    expect(todoCol.issues.length).toBe(1);
    expect(todoCol.issues[0].title).toBe("Board task 1");
    expect(todoCol.issues[0].statusName).toBe("Board Todo");
    expect(doneCol).toBeDefined();
    expect(doneCol.issues.length).toBe(1);
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
    const reviewCol = body.find(
      (s: { name: string }) => s.name === "Review",
    );
    expect(reviewCol).toBeDefined();
    expect(reviewCol.issues.length).toBe(0);
  });
});
