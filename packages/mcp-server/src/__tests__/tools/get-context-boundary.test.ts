// @covers mcp-server.orient.context [boundary]
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { migrationFilesInOrder } from "../helpers/test-db.js";

// This file lives one level deeper (__tests__/tools) than mcp-tools.test.ts, so the
// hop count to the monorepo root is +1 ( tools -> __tests__ -> src -> mcp-server ->
// packages -> root ).
const MONOREPO_ROOT = resolve(import.meta.dirname, "../../../../..");
const SHARED_DRIZZLE = resolve(MONOREPO_ROOT, "packages/shared/drizzle");

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
function seedProject(
  db: InstanceType<typeof DatabaseSync>,
  opts: { id: string; name: string; active?: boolean },
): void {
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

/** Set the activeProjectId preference to an arbitrary value (may dangle). */
function setActiveProjectPref(db: InstanceType<typeof DatabaseSync>, value: string): void {
  const now = new Date().toISOString();
  db.exec(`INSERT INTO preferences (key, value, updated_at) VALUES ('activeProjectId', '${value}', '${now}')`);
}

let messageId = 0;
function makeRequest(method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id: ++messageId, method, params });
}

function sendAndReceive(proc: ChildProcess, request: string): Promise<any> {
  return new Promise((resolveP, reject) => {
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
              resolveP(msg);
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

function startServer(dbPath: string): Promise<ChildProcess> {
  const proc = spawn("pnpm", ["--filter", "@agentic-kanban/mcp-server", "dev"], {
    cwd: MONOREPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, DB_URL: `file:${dbPath}` },
  });
  return new Promise<ChildProcess>((resolveP, reject) => {
    const timeout = setTimeout(() => reject(new Error("MCP server didn't start")), 10000);
    proc.stderr!.on("data", (data: Buffer) => {
      if (data.toString().includes("running on stdio")) {
        clearTimeout(timeout);
        resolveP(proc);
      }
    });
  });
}

async function handshake(proc: ChildProcess): Promise<void> {
  await sendAndReceive(proc, makeRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.1.0" },
  }));
  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
}

// BOUNDARY of get_context: the documented partial in mcp-tools.test.ts asserts the
// "no active project pref" degraded error. These cases cover the two OTHER boundaries
// the tool must survive WITHOUT crashing the stdio session:
//   1. active project exists but the board is EMPTY (zero issues, zero workspaces)
//   2. activeProjectId points at a project row that no longer exists (stale/dangling pref)
describe("get_context boundary — empty board", () => {
  let proc: ChildProcess;
  let tmpDir: string;
  let projectId: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-getctx-empty-"));
    const dbPath = join(tmpDir, "test.db");
    createTestDb(dbPath);
    const db = new DatabaseSync(dbPath);
    projectId = randomUUID();
    // Active project, statuses present, but NO issues and NO workspaces.
    seedProject(db, { id: projectId, name: "Empty Board Project", active: true });
    db.close();

    proc = await startServer(dbPath);
    await handshake(proc);
  });

  afterAll(() => {
    if (proc) proc.kill();
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  it("returns a well-formed degraded context (zeroed counts) instead of crashing on an empty board", async () => {
    const resp = await sendAndReceive(proc, makeRequest("tools/call", {
      name: "get_context",
      arguments: {},
    }));

    // Must not be a JSON-RPC protocol error — the session survived.
    expect(resp.error).toBeUndefined();
    expect(resp.result).toBeDefined();
    expect(resp.result.content[0].type).toBe("text");

    const data = JSON.parse(resp.result.content[0].text);
    // The project resolves and its status columns are reported even with no issues.
    expect(data.project).toBeDefined();
    expect(data.project.id).toBe(projectId);
    expect(Array.isArray(data.statuses)).toBe(true);
    expect(data.statuses).toContain("Backlog");
    // The boundary: empty board => zeroed aggregates, not undefined / not a throw.
    expect(data.totalIssues).toBe(0);
    expect(data.activeWorkspaces).toBe(0);
    expect(data.issueCounts).toEqual({});
  });
});

describe("get_context boundary — stale active project pref", () => {
  let proc: ChildProcess;
  let tmpDir: string;
  const danglingId = randomUUID();

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-getctx-stale-"));
    const dbPath = join(tmpDir, "test.db");
    createTestDb(dbPath);
    const db = new DatabaseSync(dbPath);
    // No projects registered; activeProjectId points at a non-existent project id
    // (the state left behind after a DB wipe / project deletion).
    setActiveProjectPref(db, danglingId);
    db.close();

    proc = await startServer(dbPath);
    await handshake(proc);
  });

  afterAll(() => {
    if (proc) proc.kill();
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  it("returns a graceful 'not found' error (no crash) when the active project no longer exists", async () => {
    const resp = await sendAndReceive(proc, makeRequest("tools/call", {
      name: "get_context",
      arguments: {},
    }));

    // The pref resolves (so it is NOT the "No active project" message), but the
    // project row is gone — requireEntity must produce a graceful text error.
    expect(resp.error).toBeUndefined();
    expect(resp.result).toBeDefined();
    const text = resp.result.content[0].text;
    expect(text).toContain("not found");
    expect(text).toContain(danglingId);
    // Distinguish from the already-covered "no active project pref" boundary.
    expect(text).not.toContain("No active project");
  });
});
