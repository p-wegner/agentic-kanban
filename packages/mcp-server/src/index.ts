#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerListIssues } from "./tools/list-issues.js";

const server = new McpServer({
  name: "agentic-kanban",
  version: "0.0.1",
});

registerListIssues(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Agentic Kanban MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
