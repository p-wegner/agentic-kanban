import { test, expect, beforeAll, afterAll } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

const MONOREPO_ROOT = resolve(import.meta.dirname, "../../../..");

let messageId = 0;
function makeRequest(method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id: ++messageId, method, params });
}

function sendAndReceive(proc: ChildProcess, request: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout waiting for response")), 10000);

    let buffer = "";
    const onStdout = (data: Buffer) => {
      buffer += data.toString();
      // Try to parse a complete JSON message
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (line.trim()) {
          try {
            const msg = JSON.parse(line);
            if (msg.id) {
              clearTimeout(timeout);
              proc.stdout!.off("data", onStdout);
              resolve(msg);
              return;
            }
          } catch {
            // Incomplete JSON, keep buffering
          }
        }
      }
    };

    proc.stdout!.on("data", onStdout);
    proc.stdin!.write(request + "\n");
  });
}

test.describe("MCP Server Tools", () => {
  let proc: ChildProcess;
  let projectId: string;

  beforeAll(async () => {
    // Spawn the MCP server
    proc = spawn("pnpm", ["--filter", "@agentic-kanban/mcp-server", "dev"], {
      cwd: MONOREPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    // Wait for server to be ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("MCP server didn't start")), 10000);
      proc.stderr!.on("data", (data: Buffer) => {
        if (data.toString().includes("running on stdio")) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    // Initialize
    const initResp = await sendAndReceive(proc, makeRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.1.0" },
    }));
    expect(initResp.result.serverInfo.name).toBe("agentic-kanban");

    // Send initialized notification
    proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  });

  afterAll(() => {
    if (proc) {
      proc.kill();
    }
  });

  test("get_context returns project info", async () => {
    const resp = await sendAndReceive(proc, makeRequest("tools/call", {
      name: "get_context",
      arguments: {},
    }));
    expect(resp.result.content[0].type).toBe("text");
    const data = JSON.parse(resp.result.content[0].text);
    expect(data.project).toBeDefined();
    expect(data.project.name).toBe("Default Project");
    projectId = data.project.id;
  });

  test("list_issues returns issues array", async () => {
    const resp = await sendAndReceive(proc, makeRequest("tools/call", {
      name: "list_issues",
      arguments: { projectId },
    }));
    expect(resp.result.content[0].type).toBe("text");
    const data = JSON.parse(resp.result.content[0].text);
    expect(Array.isArray(data)).toBe(true);
  });

  test("create_issue creates a new issue", async () => {
    const resp = await sendAndReceive(proc, makeRequest("tools/call", {
      name: "create_issue",
      arguments: {
        title: "MCP test issue",
        description: "Created by MCP E2E test",
        priority: "high",
      },
    }));
    expect(resp.result.content[0].type).toBe("text");
    const data = JSON.parse(resp.result.content[0].text);
    expect(data.id).toBeDefined();
    expect(data.title).toBe("MCP test issue");
  });

  test("list_issues shows the created issue", async () => {
    const resp = await sendAndReceive(proc, makeRequest("tools/call", {
      name: "list_issues",
      arguments: { projectId },
    }));
    const data = JSON.parse(resp.result.content[0].text);
    const found = data.find((i: any) => i.title === "MCP test issue");
    expect(found).toBeDefined();
    expect(found.priority).toBe("high");
  });

  test("update_issue changes the status", async () => {
    // First find the issue
    const listResp = await sendAndReceive(proc, makeRequest("tools/call", {
      name: "list_issues",
      arguments: { projectId },
    }));
    const issues = JSON.parse(listResp.result.content[0].text);
    const issue = issues.find((i: any) => i.title === "MCP test issue");

    // Update it
    const resp = await sendAndReceive(proc, makeRequest("tools/call", {
      name: "update_issue",
      arguments: {
        issueId: issue.id,
        statusName: "In Progress",
        priority: "critical",
      },
    }));
    const data = JSON.parse(resp.result.content[0].text);
    expect(data.updated).toContain("statusId");
    expect(data.updated).toContain("priority");
  });

  test("get_issue returns issue with workspaces", async () => {
    const listResp = await sendAndReceive(proc, makeRequest("tools/call", {
      name: "list_issues",
      arguments: { projectId },
    }));
    const issues = JSON.parse(listResp.result.content[0].text);
    const issue = issues.find((i: any) => i.title === "MCP test issue");

    const resp = await sendAndReceive(proc, makeRequest("tools/call", {
      name: "get_issue",
      arguments: { issueId: issue.id },
    }));
    const data = JSON.parse(resp.result.content[0].text);
    expect(data.title).toBe("MCP test issue");
    expect(data.priority).toBe("critical");
    expect(data.statusName).toBe("In Progress");
    expect(Array.isArray(data.workspaces)).toBe(true);
  });

  test("list_workspaces returns array", async () => {
    const resp = await sendAndReceive(proc, makeRequest("tools/call", {
      name: "list_workspaces",
      arguments: {},
    }));
    const data = JSON.parse(resp.result.content[0].text);
    expect(Array.isArray(data)).toBe(true);
  });
});
