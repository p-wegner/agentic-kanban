import { describe, it, expect, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { startMcpHttpServer, type McpHttpServerHandle } from "../http-transport.js";

const TOKEN = "a".repeat(64);

let handle: McpHttpServerHandle | null = null;

afterEach(async () => {
  await handle?.close();
  handle = null;
});

/** A minimal server standing in for the real 91-tool registration. */
function createTestServer(): McpServer {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  server.tool("ping", "returns pong", { value: z.string() }, async ({ value }) => ({
    content: [{ type: "text" as const, text: `pong:${value}` }],
  }));
  return server;
}

async function start(token = TOKEN) {
  // Port 0 — never guess a port. On Windows a guess in 30000-60000 flakes with
  // EACCES against reserved ranges.
  handle = await startMcpHttpServer({ createServer: createTestServer, token, port: 0, host: "127.0.0.1" });
  return handle;
}

function connect(port: number, token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  return { client: new Client({ name: "test-client", version: "1.0.0" }), transport };
}

describe("MCP HTTP transport — auth (#136)", () => {
  it("rejects a request with no token", async () => {
    const { port } = await start();
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong token of the same length", async () => {
    const { port } = await start();
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${"b".repeat(64)}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong token of a DIFFERENT length", async () => {
    // The length branch must not throw (timingSafeEqual requires equal lengths).
    const { port } = await start();
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer short",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("serves /health without a token, for reachability probes", async () => {
    const { port } = await start();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("MCP HTTP transport — protocol (#136)", () => {
  it("completes a full client handshake and lists tools", async () => {
    // Regression for the bug live verification caught: one SHARED server+transport
    // answered a bare tools/list fine, but a real client's initialize ->
    // notifications/initialized sequence returned 500 and the Claude CLI reported
    // the server as "failed". A fresh pair per request is what makes this pass.
    const { port } = await start();
    const { client, transport } = connect(port, TOKEN);

    await client.connect(transport);
    const tools = await client.listTools();

    expect(tools.tools.map((t) => t.name)).toContain("ping");
    await client.close();
  });

  it("can actually call a tool over HTTP", async () => {
    const { port } = await start();
    const { client, transport } = connect(port, TOKEN);
    await client.connect(transport);

    const result = await client.callTool({ name: "ping", arguments: { value: "board" } });

    expect(JSON.stringify(result.content)).toContain("pong:board");
    await client.close();
  });

  it("serves repeated independent clients (per-request pairs do not leak state)", async () => {
    const { port } = await start();
    for (let i = 0; i < 3; i++) {
      const { client, transport } = connect(port, TOKEN);
      await client.connect(transport);
      expect((await client.listTools()).tools).toHaveLength(1);
      await client.close();
    }
  });
});
