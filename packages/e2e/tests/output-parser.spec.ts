import { test, expect } from "@playwright/test";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SERVER_URL } from "./helpers/port.js";
import { getE2EProject } from "./helpers/e2e-project.js";

test.describe("Output parser verification", () => {
  let projectId: string;
  let statusId: string;
  let previousActiveProjectId: string | null = null;
  const tmpFiles: string[] = [];
  const createdWorkspaceIds: string[] = [];
  const createdIssueIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    // Capture current active project so afterAll can restore it
    const prevPrefRes = await request.get(`${SERVER_URL}/api/preferences/active-project`);
    if (prevPrefRes.ok()) {
      const pref = await prevPrefRes.json();
      previousActiveProjectId = pref.projectId ?? null;
    }

    // Use the E2E project set by global-setup, never projects[0]
    const project = await getE2EProject(request);
    projectId = project.id;

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todoStatus ? todoStatus.id : statuses[0].id;

    // Ensure output_parser is enabled and the E2E project is active
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { output_parser: "minimal" },
    });
    await request.put(`${SERVER_URL}/api/preferences/active-project`, {
      data: { projectId },
    });
  });

  test("renders parsed stream-json output correctly", async ({ page, request }) => {
    // Use unique suffix to avoid matching issues/workspaces from prior test runs
    const suffix = Date.now().toString(36);
    const issueTitle = `Verify output parser ${suffix}`;
    const branchName = `feature/test-parser-${suffix}`;

    // Create an issue and workspace with a completed session that produced stream-json output
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: issueTitle, statusId, projectId },
    });
    const issueId = (await issueRes.json()).id;
    createdIssueIds.push(issueId);

    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId, branch: branchName },
    });
    const workspaceId = (await wsRes.json()).id;
    createdWorkspaceIds.push(workspaceId);

    // Setup workspace (retry)
    let setupOk = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const setupRes = await request.post(
          `${SERVER_URL}/api/workspaces/${workspaceId}/setup`,
          { data: {} },
        );
        if (setupRes.ok()) { setupOk = true; break; }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!setupOk) {
      throw new Error(`[output-parser] Workspace setup failed after 3 attempts (workspaceId=${workspaceId})`);
    }

    // Launch with a mock agent that produces stream-json output
    // Write to a temp file to avoid Windows cmd.exe quoting issues with node -e "..."
    const mockAgentScript = `
const lines = [
  JSON.stringify({type:"system",subtype:"init",session_id:"test-123",tools:["Read","PowerShell"],model:"glm-5.1",mcp_servers:[{name:"deepwiki"}]}),
  JSON.stringify({type:"assistant",message:{role:"assistant",content:[{type:"text",text:"Let me explore the current state"}]}}),
  JSON.stringify({type:"assistant",message:{role:"assistant",content:[{type:"tool_use",id:"tu1",name:"Read",input:{file_path:"test.txt"}}]}}),
  JSON.stringify({type:"assistant",message:{role:"assistant",content:[{type:"tool_use",id:"tu2",name:"PowerShell",input:{command:"ls"}}]}}),
  JSON.stringify({type:"user",message:{role:"user",content:[{type:"tool_result",tool_use_id:"tu1",content:"unknown"}]}}),
  JSON.stringify({type:"user",message:{role:"user",content:[{type:"tool_result",tool_use_id:"tu2",content:"unknown",is_error:true}]}}),
  JSON.stringify({type:"result",result:"Completed",session_id:"test-123",total_cost_usd:0.042,duration_ms:5000}),
];
for (const line of lines) { console.log(line); }
process.exit(0);
`;
    // File name includes "mock-agent" so isTestMock detection in agent.service.ts works
    const tmpPath = join(tmpdir(), `mock-agent-parser-${Date.now()}.mjs`);
    writeFileSync(tmpPath, mockAgentScript);
    tmpFiles.push(tmpPath);
    const agentCmd = `node ${tmpPath.replace(/\\/g, '/')}`;

    // Stop the auto-launched session (workspace creation auto-launches claude.exe)
    await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/stop`,
      { data: {} },
    );
    await new Promise((r) => setTimeout(r, 500));

    const launchRes = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/launch`,
      {
        data: {
          prompt: "test output parser",
          agentCommand: agentCmd,
        },
      },
    );

    if (launchRes.status() !== 201) {
      throw new Error(
        `[output-parser] Launch failed: HTTP ${launchRes.status()} — ${await launchRes.text()}`,
      );
    }

    const { sessionId } = await launchRes.json();

    // Wait for mock session output to be persisted (retry until exit message appears)
    let sessionMessages: any[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((r) => setTimeout(r, 500));
      const outputRes = await request.get(`${SERVER_URL}/api/sessions/${sessionId}/output`);
      if (outputRes.ok()) {
        sessionMessages = await outputRes.json();
        if (sessionMessages.some((m: { type: string }) => m.type === "exit")) break;
      }
    }
    if (sessionMessages.length === 0) {
      throw new Error(
        `[output-parser] Session ${sessionId} produced no output after 10 polling attempts — mock agent may have failed to launch`,
      );
    }

    // Stop any lingering "running" sessions so the workspace panel shows the mock session's output
    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/stop`, { data: {} });
    await new Promise((r) => setTimeout(r, 500));

    await page.goto("/");
    await page.waitForSelector("h2");

    // Click the issue card
    await page.locator("p", { hasText: issueTitle }).first().click();
    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();

    // Click the workspace button in the Workspaces section
    const wsLabel = page.locator("label", { hasText: "Workspaces" });
    const wsSection = wsLabel.locator("..");
    await wsSection.locator("button").first().click();
    await expect(page.locator("h2", { hasText: "Workspaces —" })).toBeVisible({ timeout: 5000 });

    // Close the detail panel backdrop that blocks clicks on workspace panel content
    const backdrop = page.locator("div.fixed.inset-0.bg-black\\/30").first();
    if (await backdrop.isVisible()) {
      await backdrop.click({ force: true });
      await expect(backdrop).toBeHidden({ timeout: 2000 });
    }

    // Expand the workspace
    await page.locator(`text=${branchName}`).first().click();

    // Wait for terminal output to render
    await page.waitForSelector(".bg-gray-900", { timeout: 5000 });

    // Explicitly select the mock session from the session history list using data-session-id.
    // This ensures we view the mock session's output rather than the auto-launched real claude session.
    const sessionBtn = page.locator(`button[data-session-id="${sessionId}"]`);
    if (await sessionBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await sessionBtn.click();
      await expect(page.locator("text=Session initialized")).toBeVisible({ timeout: 5000 });
    }

    // Verify key parsed elements are visible
    await expect(page.locator("text=Session initialized")).toBeVisible();
    // Model name rendered next to "Model:" label (value comes from init event)
    await expect(page.locator("text=Model:").first()).toBeVisible();
    await expect(page.locator("text=Let me explore the current state")).toBeVisible();
    await expect(page.locator("text=Tool: Read")).toBeVisible();
    await expect(page.locator("text=Tool: PowerShell")).toBeVisible();
    await expect(page.locator("text=Result: Read").first()).toBeVisible();
    await expect(page.locator("text=Error: PowerShell").first()).toBeVisible();
    await expect(page.locator("text=Completed").first()).toBeVisible();
    await expect(page.locator("text=Cost: $0.0420")).toBeVisible();
    await expect(page.locator("text=deepwiki")).toBeVisible();
    await expect(page.locator("text=parsed")).toBeVisible();
    await expect(page.locator("text=Process exited with code 0")).toBeVisible();

    // Verify NO raw JSON dumps visible
    await expect(page.locator('pre:has-text(\'"type":"user"\')')).toHaveCount(0);
  });

  test.afterAll(async ({ request }) => {
    for (const f of tmpFiles) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
    for (const id of createdWorkspaceIds) {
      await request.delete(`${SERVER_URL}/api/workspaces/${id}`);
    }
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
    // Restore the active project to what it was before this suite ran
    if (previousActiveProjectId) {
      await request.put(`${SERVER_URL}/api/preferences/active-project`, {
        data: { projectId: previousActiveProjectId },
      });
    }
  });
});
