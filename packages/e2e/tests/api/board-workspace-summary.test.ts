import { test, expect } from "@playwright/test";

test.describe("Board workspace summary", () => {
  let projectId: string;
  let statusId: string;
  let issueId: string;
  const suffix = Date.now().toString(36);

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

    const issueRes = await request.post("http://localhost:3001/api/issues", {
      data: {
        title: `WS summary issue ${suffix}`,
        statusId,
        projectId,
      },
    });
    issueId = (await issueRes.json()).id;
  });

  test("board returns no workspaceSummary for issues without workspaces", async ({
    request,
  }) => {
    const res = await request.get(
      `http://localhost:3001/api/projects/${projectId}/board`,
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    const allIssues = body.flatMap((s: { issues: { id: string; workspaceSummary?: unknown }[] }) => s.issues);
    const issue = allIssues.find((i: { id: string }) => i.id === issueId);
    expect(issue).toBeDefined();
    // No workspaceSummary or undefined for issues without workspaces
    expect(issue.workspaceSummary).toBeUndefined();
  });

  test("board returns workspace summary after creating workspaces", async ({
    request,
  }) => {
    // Create an active workspace
    const wsRes = await request.post("http://localhost:3001/api/workspaces", {
      data: {
        issueId,
        branch: `feature/ws-summary-${suffix}`,
      },
    });
    expect(wsRes.status()).toBe(201);
    const wsBody = await wsRes.json();

    const res = await request.get(
      `http://localhost:3001/api/projects/${projectId}/board`,
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    const allIssues = body.flatMap((s: { issues: { id: string; workspaceSummary?: { total: number; active: number; idle: number; branches: string[]; main?: { branch: string; status: string } } }[] }) => s.issues);
    const issue = allIssues.find((i: { id: string }) => i.id === issueId);
    expect(issue).toBeDefined();
    expect(issue.workspaceSummary).toBeDefined();
    expect(issue.workspaceSummary!.total).toBe(1);
    expect(issue.workspaceSummary!.active).toBe(1);
    expect(issue.workspaceSummary!.idle).toBe(0);
    expect(issue.workspaceSummary!.branches).toContain(`feature/ws-summary-${suffix}`);
    expect(issue.workspaceSummary!.main).toBeDefined();
    expect(issue.workspaceSummary!.main!.branch).toBe(`feature/ws-summary-${suffix}`);
    expect(issue.workspaceSummary!.main!.status).toBe("active");

    // Cleanup: delete workspace
    await request.delete(`http://localhost:3001/api/workspaces/${wsBody.id}`);
  });

  test("summary counts update when workspace status changes", async ({
    request,
  }) => {
    // Create two workspaces
    const ws1Res = await request.post("http://localhost:3001/api/workspaces", {
      data: { issueId, branch: `feature/summary-a-${suffix}` },
    });
    const ws1 = await ws1Res.json();

    const ws2Res = await request.post("http://localhost:3001/api/workspaces", {
      data: { issueId, branch: `feature/summary-b-${suffix}` },
    });
    const ws2 = await ws2Res.json();

    // Both start as active
    let res = await request.get(
      `http://localhost:3001/api/projects/${projectId}/board`,
    );
    let body = await res.json();
    let allIssues = body.flatMap((s: { issues: { id: string; workspaceSummary?: { total: number; active: number; idle: number } }[] }) => s.issues);
    let issue = allIssues.find((i: { id: string }) => i.id === issueId);
    expect(issue.workspaceSummary!.total).toBe(2);
    expect(issue.workspaceSummary!.active).toBe(2);
    expect(issue.workspaceSummary!.idle).toBe(0);

    // Set one to idle
    await request.patch(`http://localhost:3001/api/workspaces/${ws1.id}`, {
      data: { status: "idle" },
    });

    res = await request.get(
      `http://localhost:3001/api/projects/${projectId}/board`,
    );
    body = await res.json();
    allIssues = body.flatMap((s: { issues: { id: string; workspaceSummary?: { total: number; active: number; idle: number } }[] }) => s.issues);
    issue = allIssues.find((i: { id: string }) => i.id === issueId);
    expect(issue.workspaceSummary!.total).toBe(2);
    expect(issue.workspaceSummary!.active).toBe(1);
    expect(issue.workspaceSummary!.idle).toBe(1);

    // Cleanup
    await request.delete(`http://localhost:3001/api/workspaces/${ws1.id}`);
    await request.delete(`http://localhost:3001/api/workspaces/${ws2.id}`);
  });

  test("main workspace picks active over idle over closed", async ({
    request,
  }) => {
    // Create two workspaces
    const ws1Res = await request.post("http://localhost:3001/api/workspaces", {
      data: { issueId, branch: `feature/main-priority-a-${suffix}` },
    });
    const ws1 = await ws1Res.json();

    const ws2Res = await request.post("http://localhost:3001/api/workspaces", {
      data: { issueId, branch: `feature/main-priority-b-${suffix}` },
    });
    const ws2 = await ws2Res.json();

    // Both start active — main should be the more recently updated one
    let res = await request.get(
      `http://localhost:3001/api/projects/${projectId}/board`,
    );
    let body = await res.json();
    let allIssues = body.flatMap((s: { issues: { id: string; workspaceSummary?: { total: number; main?: { branch: string; status: string } } }[] }) => s.issues);
    let issue = allIssues.find((i: { id: string }) => i.id === issueId);
    expect(issue.workspaceSummary!.main).toBeDefined();
    expect(issue.workspaceSummary!.main!.status).toBe("active");

    // Set one to idle — main should still be active
    await request.patch(`http://localhost:3001/api/workspaces/${ws1.id}`, {
      data: { status: "idle" },
    });

    res = await request.get(
      `http://localhost:3001/api/projects/${projectId}/board`,
    );
    body = await res.json();
    allIssues = body.flatMap((s: { issues: { id: string; workspaceSummary?: { main?: { status: string } } }[] }) => s.issues);
    issue = allIssues.find((i: { id: string }) => i.id === issueId);
    expect(issue.workspaceSummary!.main!.status).toBe("active");

    // Set the active one to closed — main should fall back to idle
    await request.patch(`http://localhost:3001/api/workspaces/${ws2.id}`, {
      data: { status: "closed" },
    });

    res = await request.get(
      `http://localhost:3001/api/projects/${projectId}/board`,
    );
    body = await res.json();
    allIssues = body.flatMap((s: { issues: { id: string; workspaceSummary?: { main?: { branch: string; status: string } } }[] }) => s.issues);
    issue = allIssues.find((i: { id: string }) => i.id === issueId);
    expect(issue.workspaceSummary!.main!.status).toBe("idle");
    expect(issue.workspaceSummary!.main!.branch).toBe(`feature/main-priority-a-${suffix}`);

    // Cleanup
    await request.delete(`http://localhost:3001/api/workspaces/${ws1.id}`);
    await request.delete(`http://localhost:3001/api/workspaces/${ws2.id}`);
  });
});
