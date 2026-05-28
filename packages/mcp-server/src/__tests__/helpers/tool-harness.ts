import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { vi } from "vitest";
import { createTestDb, type TestDb } from "./test-db.js";
import type { ToolDeps } from "../../tools/deps.js";
import * as schema from "@agentic-kanban/shared/schema";

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;

/**
 * A minimal stand-in for McpServer.tool() that captures the handler a registrar
 * passes, so a test can invoke it directly with arguments — no stdio transport,
 * no real MCP server process.
 */
export function createToolHarness(): { server: McpServer; getHandler: () => ToolHandler } {
  let handler: ToolHandler | undefined;
  const server = {
    tool: (_name: string, _desc: string, _schema: unknown, h: ToolHandler) => {
      handler = h;
    },
  } as unknown as McpServer;
  return {
    server,
    getHandler: () => {
      if (!handler) throw new Error("Tool registrar did not register a handler");
      return handler;
    },
  };
}

/** Build a ToolDeps backed by a fresh in-memory DB plus spy side effects. */
export function createTestDeps(overrides: Partial<ToolDeps> = {}): { deps: ToolDeps; db: TestDb } {
  const { db } = createTestDb();
  const deps: ToolDeps = {
    db,
    schema,
    notifyBoard: vi.fn(),
    getDiffShortstat: vi.fn(async () => ({ filesChanged: 0, insertions: 0, deletions: 0 })),
    ...overrides,
  };
  return { deps, db };
}

/** Register a tool with test deps and return its invocable handler. */
export function setupTool(
  register: (server: McpServer, deps: ToolDeps) => void,
  overrides: Partial<ToolDeps> = {},
): { invoke: ToolHandler; db: TestDb; deps: ToolDeps } {
  const { server, getHandler } = createToolHarness();
  const { deps, db } = createTestDeps(overrides);
  register(server, deps);
  return { invoke: getHandler(), db, deps };
}

/** Parse the JSON text payload of a tool result. */
export function parseResult(result: { content: { type: string; text: string }[] }): any {
  return JSON.parse(result.content[0].text);
}
