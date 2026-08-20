// @covers mcp-server.govern.disabled-tools [permission,config,api]
//
// The disabled_mcp_tools preference is the ONLY authority knob on the MCP surface
// (single-user, unauthenticated stdio). index.ts:198 (`getDisabledTools`) reads the
// pref and the registration loop (index.ts:221) skips any tool whose name is listed,
// so a disabled tool must NEVER appear in tools/list and must NOT be callable for the
// session. This spawns the real server process against a seeded temp DB — exercising
// the actual gate, not a re-implementation — and asserts both the positive (a disabled
// tool vanishes + its call is refused) and the control (a non-disabled tool stays live).
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

const MONOREPO_ROOT = resolve(import.meta.dirname, "../../../..");
const SHARED_DRIZZLE = resolve(MONOREPO_ROOT, "packages/shared/drizzle");

// Real server launch — see helpers/server-process.ts. Not vitest's 10s default, which
// measures machine load rather than the gate under test (#46).
const SPAWN_HOOK_TIMEOUT_MS = 60_000;

// The two tools we declare disabled for this session, and one control that stays live.
// NOTE: getDisabledTools (index.ts) now trims + lowercases each entry, so the gate accepts
// a human-written comma-list (surrounding spaces, mixed case). The clean-list happy path is
// covered here; the whitespace/case hardening is asserted by the second describe block below.
const DISABLED = ["delete_issue", "delete_workspace"] as const;
const CONTROL = "get_context";

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

describe("MCP disabled_mcp_tools governance gate", () => {
  let proc: ChildProcess;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-test-disabled-"));
    const dbPath = join(tmpDir, "test.db");
    createTestDb(dbPath);

    const db = new DatabaseSync(dbPath);
    seedProject(db, { id: randomUUID(), name: "Default Project", active: true });
    // The authority knob: mark two tools disabled (comma-separated, the format
    // getDisabledTools() parses at index.ts:205).
    const now = new Date().toISOString();
    db.exec(`INSERT INTO preferences (key, value, updated_at)
      VALUES ('disabled_mcp_tools', '${DISABLED.join(",")}', '${now}')`);
    db.close();

    // Spawn the server as a SINGLE node process (node --import tsx) rather than via
    // `pnpm dev`. `pnpm` would fork a tsx/node grandchild that proc.kill() can't reach
    // on Windows, orphaning a process that holds DB_URL open and making rmSync fail.
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
    // Kill the (single) server process and AWAIT its exit before removing the temp DB —
    // otherwise the still-open DB_URL handle makes rmSync fail. We do NOT swallow rmSync
    // errors: a failure here means we leaked a live process and must surface, not hide.
    await stopMcpServer(proc);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a tool listed in disabled_mcp_tools is absent from tools/list, while a non-listed tool stays exposed", async () => {
    const resp = await sendAndReceive(proc, makeRequest("tools/list"));
    const tools = resp.result.tools as { name: string }[];
    const registered = new Set<string>(tools.map((t) => t.name));

    // Positive: every disabled tool must have vanished from the advertised surface.
    for (const name of DISABLED) {
      expect(registered.has(name), `disabled tool '${name}' should NOT be in tools/list`).toBe(false);
    }
    // Control: a tool NOT in the disabled list remains exposed — proves the gate is
    // selective, not just "the server dropped some tools".
    expect(registered.has(CONTROL), `non-disabled tool '${CONTROL}' should stay exposed`).toBe(true);
    // Sanity: the server still registered a meaningful surface.
    expect(registered.size).toBeGreaterThan(10);
  });

  it("calling a disabled tool fails with the SDK's 'tool not found' signature (it is unregistered, not merely a missing-row error)", async () => {
    // We call delete_issue with a syntactically-valid but nonexistent issue id. This is
    // the case that makes a naive error||isError check a FALSE-CONFIDENCE smoke test:
    // a LIVE delete_issue would ALSO fail for a missing row (`mcpError("Issue <id> not
    // found")`, no isError flag) — so "it errored" proves nothing about the gate.
    const resp = await sendAndReceive(proc, makeRequest("tools/call", {
      name: DISABLED[0],
      arguments: { issueId: randomUUID() },
    }));
    const text: string = resp.result.content[0].text;

    // Discriminators that hold ONLY for an UNREGISTERED tool (gate active), proven from
    // the SDK source: the high-level McpServer catches the unknown-tool McpError and
    // returns it as `{ isError: true, text: "MCP error -32602: Tool <name> not found" }`.
    //   - isError === true            → a LIVE delete_issue's missing-row mcpError() does
    //                                    NOT set isError, so this fails if the tool stayed enabled.
    //   - /Tool .* not found/i        → the SDK's unknown-tool phrasing; a LIVE delete_issue
    //                                    says "Issue <id> not found" ("Issue", not "Tool").
    expect(resp.error, "unknown tool is surfaced as an isError result, not a protocol error here").toBeUndefined();
    expect(resp.result.isError, `expected isError result for unregistered tool, got: ${JSON.stringify(resp.result)}`).toBe(true);
    expect(text, `expected the SDK 'Tool ... not found' signature, got: ${text}`).toMatch(/tool\s+.*\bnot found\b/i);
    expect(text).toContain(DISABLED[0]);
    // Guard against the live-tool failure mode masquerading as a gate refusal.
    expect(text, "must NOT be the live delete_issue missing-row error").not.toMatch(/^Issue\s/i);
  });

  it("a non-disabled tool remains callable in the same session", async () => {
    const resp = await sendAndReceive(proc, makeRequest("tools/call", {
      name: CONTROL,
      arguments: {},
    }));
    expect(resp.error, `control tool '${CONTROL}' should not error: ${JSON.stringify(resp.error)}`).toBeUndefined();
    const data = JSON.parse(resp.result.content[0].text);
    expect(data.project).toBeDefined();
    expect(data.project.name).toBe("Default Project");
  });
});

// Ticket #926: the gate must normalize each pref entry (trim surrounding whitespace, apply
// a case-insensitive policy) before matching. A pref a human types as a comma list with
// spaces, or with the wrong case, must STILL disable the tools — otherwise a tool the user
// believes is off stays callable, a silent security gap on the sole MCP authority knob.
describe("MCP disabled_mcp_tools gate normalizes whitespace and case", () => {
  let proc: ChildProcess;
  let tmpDir: string;

  // Deliberately messy: leading/trailing space around one entry, mixed-case on the other.
  // Both must end up disabled. `delete_workspace` is written `Delete_Workspace`.
  const RAW_PREF = "delete_issue , Delete_Workspace";
  const EXPECTED_DISABLED = ["delete_issue", "delete_workspace"] as const;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-test-disabled-norm-"));
    const dbPath = join(tmpDir, "test.db");
    createTestDb(dbPath);

    const db = new DatabaseSync(dbPath);
    seedProject(db, { id: randomUUID(), name: "Default Project", active: true });
    const now = new Date().toISOString();
    db.exec(`INSERT INTO preferences (key, value, updated_at)
      VALUES ('disabled_mcp_tools', '${RAW_PREF}', '${now}')`);
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
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("disables both 'delete_issue' (whitespace-padded) and 'Delete_Workspace' (mixed case)", async () => {
    const resp = await sendAndReceive(proc, makeRequest("tools/list"));
    const tools = resp.result.tools as { name: string }[];
    const registered = new Set<string>(tools.map((t) => t.name));

    for (const name of EXPECTED_DISABLED) {
      expect(registered.has(name), `'${name}' should be disabled despite messy pref formatting`).toBe(false);
    }
    // Control: a tool not named in the pref stays exposed, proving the gate is still selective.
    expect(registered.has(CONTROL), `non-disabled tool '${CONTROL}' should stay exposed`).toBe(true);
    expect(registered.size).toBeGreaterThan(10);
  });

  it("refuses a call to the mixed-case-named tool (it is genuinely unregistered)", async () => {
    const resp = await sendAndReceive(proc, makeRequest("tools/call", {
      name: "delete_workspace",
      arguments: { workspaceId: randomUUID() },
    }));
    expect(resp.error).toBeUndefined();
    expect(resp.result.isError, `expected isError for unregistered tool, got: ${JSON.stringify(resp.result)}`).toBe(true);
    const text: string = resp.result.content[0].text;
    expect(text, `expected the SDK 'Tool ... not found' signature, got: ${text}`).toMatch(/tool\s+.*\bnot found\b/i);
    expect(text).toContain("delete_workspace");
  });
});
