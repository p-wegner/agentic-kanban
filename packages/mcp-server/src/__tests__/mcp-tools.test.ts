import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { migrationFilesInOrder } from "./helpers/test-db.js";
import { startMcpServer, stopMcpServer } from "./helpers/server-process.js";
import { MCP_TOOL_DEFINITIONS } from "@agentic-kanban/shared/lib";

const MONOREPO_ROOT = resolve(import.meta.dirname, "../../../..");
const SHARED_DRIZZLE = resolve(MONOREPO_ROOT, "packages/shared/drizzle");

// This suite launches REAL server processes; see helpers/server-process.ts. The old
// inline `spawn("pnpm", …, "dev")` left a tsx/node grandchild alive after every run
// because proc.kill() only reached the pnpm shim (#46).
const SPAWN_HOOK_TIMEOUT_MS = 60_000;
const SPAWN_TEST_TIMEOUT_MS = 60_000;

// Read the migration order from the drizzle journal so this never goes stale as
// migrations are added (the old hardcoded list froze at 0024 and broke the suite).
function createTestDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  for (const file of migrationFilesInOrder()) {
    const sql = readFileSync(join(SHARED_DRIZZLE, file), "utf-8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      db.exec(stmt);
    }
  }
  db.close();
}

/** Seed a project with the standard status columns; optionally make it the active project. */
function seedProject(db: InstanceType<typeof DatabaseSync>, opts: { id: string; name: string; active?: boolean }): void {
  const now = new Date().toISOString();
  db.exec(`INSERT INTO projects (id, name, repo_path, repo_name, default_branch, created_at, updated_at)
    VALUES ('${opts.id}', '${opts.name}', '/tmp/${opts.id}', '${opts.name}', 'main', '${now}', '${now}')`);
  const statuses = ["Backlog", "Todo", "In Progress", "In Review", "AI Reviewed", "Done", "Cancelled"];
  statuses.forEach((name, i) => {
    db.exec(`INSERT INTO project_statuses (id, project_id, name, sort_order, is_default, created_at)
      VALUES ('${randomUUID()}', '${opts.id}', '${name}', ${i}, ${name === "Backlog" ? 1 : 0}, '${now}')`);
  });
  if (opts.active) {
    db.exec(`INSERT INTO preferences (key, value, updated_at) VALUES ('activeProjectId', '${opts.id}', '${now}')`);
  }
}

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

describe("MCP Server Tools", () => {
  let proc: ChildProcess;
  let projectId: string;
  let tmpDir: string;

  beforeAll(async () => {
    // Spawn the server against an isolated, seeded temp DB — never the real dev DB.
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-test-tools-"));
    const dbPath = join(tmpDir, "test.db");
    createTestDb(dbPath);
    const db = new DatabaseSync(dbPath);
    seedProject(db, { id: randomUUID(), name: "Default Project", active: true });
    db.close();

    proc = await startMcpServer(dbPath);

    const initResp = await sendAndReceive(proc, makeRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.1.0" },
    }));
    expect(initResp.result.serverInfo.name).toBe("agentic-kanban");

    proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }, SPAWN_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await stopMcpServer(proc);
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("the MCP_TOOL_DEFINITIONS catalog and the runtime tools/list stay in exact name- and description-parity", async () => {
    // Regression: mark_ready_for_merge was advertised in MCP_TOOL_DEFINITIONS (and the
    // review prompt told reviewers to call it) but was never wired into TOOL_REGISTRARS,
    // so every worktree review stranded its issue in "In Review" — the approval signal
    // referenced a tool that didn't exist over MCP.
    //
    // We assert NAME parity in BOTH directions (the catalog drives the Settings UI tool
    // browser, grouped by category; the runtime is what agents can actually call):
    //   - advertised ⊆ registered  → no catalog entry references a non-existent tool
    //     (the mark_ready class).
    //   - registered ⊆ advertised  → no runtime tool can ship without a UI catalog
    //     entry + category (so the tool browser never silently omits a real tool).
    //
    // We ALSO assert DESCRIPTION equality (#977). The old "catalog holds a terse UI
    // label, registrar holds the rich agent-facing text" split was a drift generator:
    // 74 of 91 descriptions had silently diverged, so the Settings tool browser lied
    // about what a tool does. The RUNTIME registration (server.tool(...) in
    // packages/mcp-server/src/tools/*) is the single source of truth — edit the
    // description there and copy it verbatim into MCP_TOOL_DEFINITIONS.
    const resp = await sendAndReceive(proc, makeRequest("tools/list"));
    const tools = resp.result.tools as { name: string; description?: string }[];
    const registered = new Set<string>(tools.map((t) => t.name));
    const advertised = new Set<string>(MCP_TOOL_DEFINITIONS.map((d) => d.name));

    const missing = [...advertised].filter((name) => !registered.has(name));
    expect(missing, `advertised in catalog but not registered at runtime: ${missing.join(", ")}`).toEqual([]);

    const uncatalogued = [...registered].filter((name) => !advertised.has(name));
    expect(
      uncatalogued,
      `registered at runtime but missing from MCP_TOOL_DEFINITIONS (add it + a category so the Settings tool browser shows it): ${uncatalogued.join(", ")}`,
    ).toEqual([]);

    expect(registered.has("mark_ready_for_merge")).toBe(true);

    const blankDescriptions = tools.filter((t) => !t.description || t.description.trim().length === 0).map((t) => t.name);
    expect(blankDescriptions, `tools shipped with an empty description: ${blankDescriptions.join(", ")}`).toEqual([]);

    const catalogDescriptions = new Map(MCP_TOOL_DEFINITIONS.map((d) => [d.name, d.description]));
    const descriptionDrift = tools
      .filter((t) => catalogDescriptions.has(t.name) && catalogDescriptions.get(t.name) !== t.description)
      .map((t) => `${t.name}:\n  runtime: ${JSON.stringify(t.description)}\n  catalog: ${JSON.stringify(catalogDescriptions.get(t.name))}`);
    expect(
      descriptionDrift,
      `catalog descriptions drifted from the runtime registration (runtime is the source of truth — ` +
        `copy the server.tool(...) description into MCP_TOOL_DEFINITIONS):\n${descriptionDrift.join("\n")}`,
    ).toEqual([]);
  });

  it("get_context returns project info", async () => {
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

  it("list_issues returns issues array", async () => {
    const resp = await sendAndReceive(proc, makeRequest("tools/call", {
      name: "list_issues",
      arguments: { projectId },
    }));
    expect(resp.result.content[0].type).toBe("text");
    const data = JSON.parse(resp.result.content[0].text);
    expect(Array.isArray(data)).toBe(true);
  });

  it("create_issue creates a new issue", async () => {
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

  it("list_issues shows the created issue", async () => {
    const resp = await sendAndReceive(proc, makeRequest("tools/call", {
      name: "list_issues",
      arguments: { projectId },
    }));
    const data = JSON.parse(resp.result.content[0].text);
    const found = data.find((i: any) => i.title === "MCP test issue");
    expect(found).toBeDefined();
    expect(found.priority).toBe("high");
  });

  it("update_issue changes the status", async () => {
    const listResp = await sendAndReceive(proc, makeRequest("tools/call", {
      name: "list_issues",
      arguments: { projectId },
    }));
    const issues = JSON.parse(listResp.result.content[0].text);
    const issue = issues.find((i: any) => i.title === "MCP test issue");

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

  it("get_issue returns issue with workspaces", async () => {
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

  it("list_workspaces returns array", async () => {
    const resp = await sendAndReceive(proc, makeRequest("tools/call", {
      name: "list_workspaces",
      arguments: {},
    }));
    const data = JSON.parse(resp.result.content[0].text);
    expect(Array.isArray(data)).toBe(true);
  });
});

describe("MCP active project resolution", () => {
  let proc: ChildProcess;
  let tmpDir: string;
  let dbPath: string;
  let firstProjectId: string;
  let secondProjectId: string;
  let secondStatusId: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-test-"));
    dbPath = join(tmpDir, "test.db");
    createTestDb(dbPath);

    // Seed two projects with statuses, set second as active
    const db = new DatabaseSync(dbPath);
    const now = new Date().toISOString();

    firstProjectId = randomUUID();
    secondProjectId = randomUUID();
    const firstStatusId = randomUUID();
    secondStatusId = randomUUID();

    db.exec(`INSERT INTO projects (id, name, repo_path, repo_name, default_branch, created_at, updated_at)
      VALUES ('${firstProjectId}', 'First Project', '/tmp/first', 'first', 'main', '${now}', '${now}')`);
    db.exec(`INSERT INTO project_statuses (id, project_id, name, sort_order, is_default, created_at)
      VALUES ('${firstStatusId}', '${firstProjectId}', 'Todo', 0, 1, '${now}')`);

    db.exec(`INSERT INTO projects (id, name, repo_path, repo_name, default_branch, created_at, updated_at)
      VALUES ('${secondProjectId}', 'Second Project', '/tmp/second', 'second', 'main', '${now}', '${now}')`);
    db.exec(`INSERT INTO project_statuses (id, project_id, name, sort_order, is_default, created_at)
      VALUES ('${secondStatusId}', '${secondProjectId}', 'Todo', 0, 1, '${now}')`);

    // Set activeProjectId to second project (not the first inserted)
    db.exec(`INSERT INTO preferences (key, value, updated_at) VALUES ('activeProjectId', '${secondProjectId}', '${now}')`);
    db.close();

    proc = await startMcpServer(dbPath);

    await sendAndReceive(proc, makeRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.1.0" },
    }));
    proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }, SPAWN_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await stopMcpServer(proc);
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("get_context with no projectId returns the active project, not the first inserted", async () => {
    const resp = await sendAndReceive(proc, makeRequest("tools/call", {
      name: "get_context",
      arguments: {},
    }));
    const data = JSON.parse(resp.result.content[0].text);
    expect(data.project).toBeDefined();
    expect(data.project.id).toBe(secondProjectId);
    expect(data.project.name).toBe("Second Project");
  });

  it("create_issue with no projectId creates in the active project", async () => {
    const resp = await sendAndReceive(proc, makeRequest("tools/call", {
      name: "create_issue",
      arguments: {
        title: "Active project issue",
        priority: "medium",
      },
    }));
    const data = JSON.parse(resp.result.content[0].text);
    expect(data.id).toBeDefined();
    expect(data.title).toBe("Active project issue");

    // Verify the issue landed in the second (active) project, not the first
    const listResp = await sendAndReceive(proc, makeRequest("tools/call", {
      name: "list_issues",
      arguments: { projectId: secondProjectId },
    }));
    const issues = JSON.parse(listResp.result.content[0].text);
    expect(issues.find((i: any) => i.title === "Active project issue")).toBeDefined();

    const firstListResp = await sendAndReceive(proc, makeRequest("tools/call", {
      name: "list_issues",
      arguments: { projectId: firstProjectId },
    }));
    const firstIssues = JSON.parse(firstListResp.result.content[0].text);
    expect(firstIssues.find((i: any) => i.title === "Active project issue")).toBeUndefined();
  });

  it("get_context returns error when no activeProjectId preference is set", async () => {
    const noActiveTmpDir = mkdtempSync(join(tmpdir(), "mcp-test-noactive-"));
    const noActiveDbPath = join(noActiveTmpDir, "test.db");
    createTestDb(noActiveDbPath);

    const noActiveProc = await startMcpServer(noActiveDbPath);

    try {
      await sendAndReceive(noActiveProc, makeRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.1.0" },
      }));
      noActiveProc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

      const resp = await sendAndReceive(noActiveProc, makeRequest("tools/call", {
        name: "get_context",
        arguments: {},
      }));
      expect(resp.result.content[0].text).toContain("No active project");
    } finally {
      await stopMcpServer(noActiveProc);
      try { rmSync(noActiveTmpDir, { recursive: true, force: true }); } catch {}
    }
  }, SPAWN_TEST_TIMEOUT_MS);

  it("create_issue returns error when no activeProjectId preference is set", async () => {
    const noActiveTmpDir = mkdtempSync(join(tmpdir(), "mcp-test-noactive2-"));
    const noActiveDbPath = join(noActiveTmpDir, "test.db");
    createTestDb(noActiveDbPath);

    const noActiveProc = await startMcpServer(noActiveDbPath);

    try {
      await sendAndReceive(noActiveProc, makeRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.1.0" },
      }));
      noActiveProc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

      const resp = await sendAndReceive(noActiveProc, makeRequest("tools/call", {
        name: "create_issue",
        arguments: { title: "Should fail" },
      }));
      expect(resp.result.content[0].text).toContain("No active project");
    } finally {
      await stopMcpServer(noActiveProc);
      try { rmSync(noActiveTmpDir, { recursive: true, force: true }); } catch {}
    }
  }, SPAWN_TEST_TIMEOUT_MS);

  it("regression: correct project is used when multiple projects exist and second is active", async () => {
    // Verify get_context still returns second project (not first) after issue creation
    const ctxResp = await sendAndReceive(proc, makeRequest("tools/call", {
      name: "get_context",
      arguments: {},
    }));
    const ctx = JSON.parse(ctxResp.result.content[0].text);
    expect(ctx.project.id).toBe(secondProjectId);

    // Verify issue created above appears in second project, not first
    const listResp = await sendAndReceive(proc, makeRequest("tools/call", {
      name: "list_issues",
      arguments: { projectId: secondProjectId },
    }));
    const issues = JSON.parse(listResp.result.content[0].text);
    const found = issues.find((i: any) => i.title === "Active project issue");
    expect(found).toBeDefined();

    // First project should have no issues
    const firstListResp = await sendAndReceive(proc, makeRequest("tools/call", {
      name: "list_issues",
      arguments: { projectId: firstProjectId },
    }));
    const firstIssues = JSON.parse(firstListResp.result.content[0].text);
    expect(firstIssues.find((i: any) => i.title === "Active project issue")).toBeUndefined();
  });
});
