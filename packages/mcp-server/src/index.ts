#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerGetContext } from "./tools/get-context.js";
import { registerListIssues } from "./tools/list-issues.js";
import { registerGetIssue } from "./tools/get-issue.js";
import { registerCreateIssue } from "./tools/create-issue.js";
import { registerUpdateIssue } from "./tools/update-issue.js";
import { registerListWorkspaces } from "./tools/list-workspaces.js";
import { registerStartWorkspace } from "./tools/start-workspace.js";
import { registerGetWorkspaceDiff } from "./tools/get-workspace-diff.js";

const server = new McpServer({
  name: "agentic-kanban",
  version: "0.0.1",
});

// Register all tools
registerGetContext(server);
registerListIssues(server);
registerGetIssue(server);
registerCreateIssue(server);
registerUpdateIssue(server);
registerListWorkspaces(server);
registerStartWorkspace(server);
registerGetWorkspaceDiff(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Agentic Kanban MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
