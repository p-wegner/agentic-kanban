import { test, expect } from "@playwright/test";

test.describe("Output parser verification", () => {
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

  test("renders parsed stream-json output correctly", async ({ page, request }) => {
    // Create an issue and workspace with a completed session that produced stream-json output
    const issueRes = await request.post("http://localhost:3001/api/issues", {
      data: { title: "Verify output parser", statusId, projectId },
    });
    const issueId = (await issueRes.json()).id;

    const branchName = "feature/test-parser";
    const wsRes = await request.post("http://localhost:3001/api/workspaces", {
      data: { issueId, branch: branchName },
    });
    const workspaceId = (await wsRes.json()).id;

    // Setup workspace (retry)
    let setupOk = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const setupRes = await request.post(
          `http://localhost:3001/api/workspaces/${workspaceId}/setup`,
          { data: {} },
        );
        if (setupRes.ok()) { setupOk = true; break; }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!setupOk) { test.skip(); return; }

    // Launch with a mock agent that produces stream-json output
    const mockAgentScript = `
const lines = [
  JSON.stringify({type:"system",subtype:"init",session_id:"test-123",tools:["Read","PowerShell"],model:"glm-5.1",mcp_servers:[{name:"deepwiki"}]}),
  JSON.stringify({type:"assistant",message:{role:"assistant",content:[{type:"text",text:"Let me explore the current state"}]}}),
  JSON.stringify({type:"assistant",message:{role:"assistant",content:[{type:"tool_use",id:"tu1",name:"Read",input:{file_path:"test.txt"}}]}}),
  JSON.stringify({type:"assistant",message:{role:"assistant",content:[{type:"tool_use",id:"tu2",name:"PowerShell",input:{command:"ls"}}]}}),
  JSON.stringify({type:"user",message:{role:"user",content:[{type:"tool_result",tool_use_id:"tu1",content:"unknown"}]}}),
  JSON.stringify({type:"user",message:{role:"user",content:[{type:"tool_result",tool_use_id:"tu2",content:"unknown",is_error:true}]}}),
  JSON.stringify({type:"result",result:"Completed",session_id:"test-123",cost_usd:0.042,duration_ms:5000}),
];
for (const line of lines) { console.log(line); }
process.exit(0);
`.replace(/\n/g, " ");

    const launchRes = await request.post(
      `http://localhost:3001/api/workspaces/${workspaceId}/launch`,
      {
        data: {
          prompt: "test output parser",
          agentCommand: `node -e "${mockAgentScript}"`,
        },
      },
    );

    if (launchRes.status() !== 201) { test.skip(); return; }

    // Wait for session to complete
    await new Promise((resolve) => setTimeout(resolve, 2000));

    await page.goto("/");
    await page.waitForSelector("h2");

    // Click the issue card
    await page.locator("p", { hasText: "Verify output parser" }).first().click();
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
      await page.waitForTimeout(300);
    }

    // Expand the workspace
    await page.locator(`text=${branchName}`).first().click();

    // Wait for terminal output to render
    await page.waitForSelector(".bg-gray-900", { timeout: 5000 });

    // Verify key parsed elements are visible
    await expect(page.locator("text=Session initialized")).toBeVisible();
    await expect(page.locator("text=glm-5.1")).toBeVisible();
    await expect(page.locator("text=Let me explore the current state")).toBeVisible();
    await expect(page.locator("text=Tool: Read")).toBeVisible();
    await expect(page.locator("text=Tool: PowerShell")).toBeVisible();
    await expect(page.locator("text=Result: unknown").first()).toBeVisible();
    await expect(page.locator("text=Error: unknown").first()).toBeVisible();
    await expect(page.locator("text=Completed")).toBeVisible();
    await expect(page.locator(/Cost: \$0\.\d+/)).toBeVisible();
    await expect(page.locator("text=deepwiki")).toBeVisible();
    await expect(page.locator("text=stream-json")).toBeVisible();
    await expect(page.locator("text=Process exited with code 0")).toBeVisible();

    // Verify NO raw JSON dumps visible
    await expect(page.locator('pre:has-text(\'"type":"user"\')')).toHaveCount(0);
  });
});
