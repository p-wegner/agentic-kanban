// @covers mcp-server.resilience.stay-up [error, risk, regression]
//
// The MCP server is the machine-facing front door for the autonomous loop (Builder,
// Conductor, Smith). If one bad tool call crashed the process, the agent's MCP client
// would report `server "agentic-kanban" is not connected` and EVERY subsequent board op
// would fail — a single throwing handler must not take the whole session down.
//
// Resilience here is enforced at two layers:
//   1. The MCP SDK's per-tool dispatch wraps each registered callback in a try/catch and
//      turns an awaited throw into an `isError` tool *result* (the connection stays open).
//   2. index.ts adds process-level `uncaughtException`/`unhandledRejection` handlers for
//      stray async rejections that escape (1) — see the comment block at index.ts.
//
// This test asserts at the SDK dispatch seam (layer 1) WITHOUT spawning the real stdio
// process: it stands up a real `McpServer` + `Client` over an in-memory transport pair —
// the exact same dispatch machinery index.ts connects to `StdioServerTransport` — registers
// tools with the project's real `server.tool(name, desc, schema, handler)` shape (the same
// call every `register*` registrar makes), drives a throwing tool, asserts the call returns
// an `isError` result (not an unhandled rejection / closed connection), and then proves the
// server STAYED UP by calling a second, good tool that still succeeds.
//
// Mutation note: if the dispatch try/catch were removed so the throw propagated instead of
// becoming an `isError` result, the throwing `callTool` would reject (or tear the connection
// down) and BOTH the isError assertion and the subsequent good-call assertion go RED.
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/**
 * Register a deliberately-throwing tool and a healthy tool using the SAME
 * `server.tool(name, description, schema, handler)` signature every real registrar
 * in src/tools/*.ts uses. The throwing handler simulates a registrar whose dependency
 * (e.g. a drizzle query) blew up at call time.
 */
function buildServerWithThrowingTool(): McpServer {
  const server = new McpServer({ name: "agentic-kanban-test", version: "0.0.0" });

  server.tool(
    "explode",
    "A tool whose handler throws, simulating a failed dependency mid-call",
    {},
    async () => {
      throw new Error("boom: simulated dependency failure inside a tool handler");
    },
  );

  server.tool(
    "ping",
    "A healthy tool that proves the server is still serving requests",
    {},
    async () => ({ content: [{ type: "text" as const, text: "pong" }] }),
  );

  return server;
}

async function connectClient(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

describe("MCP server resilience — a throwing tool handler does not crash the server", () => {
  it("returns an isError result for a throwing tool, and the NEXT good tool call still succeeds", async () => {
    const server = buildServerWithThrowingTool();
    const client = await connectClient(server);

    try {
      // 1) The bad call: a tool handler throws. This must NOT reject as an unhandled
      //    error nor tear down the connection — the SDK dispatch converts it into a
      //    structured isError tool result and keeps the session alive.
      const bad = (await client.callTool({ name: "explode", arguments: {} })) as {
        isError?: boolean;
        content?: { type: string; text?: string }[];
      };

      expect(bad.isError).toBe(true);
      // Error surfaces as content the agent can read, not a process crash.
      const badText = (bad.content ?? []).map((c) => c.text ?? "").join("\n");
      expect(badText).toMatch(/boom|error/i);

      // 2) Proof the server STAYED UP: a subsequent, unrelated good call still works.
      const good = (await client.callTool({ name: "ping", arguments: {} })) as {
        isError?: boolean;
        content?: { type: string; text?: string }[];
      };

      expect(good.isError).toBeFalsy();
      expect((good.content ?? [])[0]?.text).toBe("pong");

      // And the catalog is still queryable — the connection is fully live, not half-dead.
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(["explode", "ping"]),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});
