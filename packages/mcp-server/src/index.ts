#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerGetContext } from "./tools/get-context.js";
import { registerListIssues } from "./tools/list-issues.js";
import { registerGetIssue } from "./tools/get-issue.js";
import { registerCreateIssue } from "./tools/create-issue.js";
import { registerUpdateIssue } from "./tools/update-issue.js";
import { registerDeleteIssue } from "./tools/delete-issue.js";
import { registerMoveIssue } from "./tools/move-issue.js";
import { registerListWorkspaces } from "./tools/list-workspaces.js";
import { registerStartWorkspace } from "./tools/start-workspace.js";
import { registerGetWorkspaceDiff } from "./tools/get-workspace-diff.js";
import { registerMergeWorkspace } from "./tools/merge-workspace.js";
import { registerCloseWorkspace } from "./tools/close-workspace.js";
import { registerStopWorkspace } from "./tools/stop-workspace.js";
import { registerDeleteWorkspace } from "./tools/delete-workspace.js";
import { registerListTags } from "./tools/list-tags.js";
import { registerCreateTag } from "./tools/create-tag.js";
import { registerReadTerminal } from "./tools/read-terminal.js";
import { registerListSessions } from "./tools/list-sessions.js";
import { registerGetSessionStats } from "./tools/get-session-stats.js";
import { registerGetDiffComments } from "./tools/get-diff-comments.js";
import { registerCreateDiffComment } from "./tools/create-diff-comment.js";
import { registerAddDependency } from "./tools/add-dependency.js";
import { registerRemoveDependency } from "./tools/remove-dependency.js";
import { registerGetBoardStatus } from "./tools/get-board-status.js";
import { registerListAgentSkills } from "./tools/list-agent-skills.js";
import { registerGetAgentSkill } from "./tools/get-agent-skill.js";
import { registerCreateAgentSkill } from "./tools/create-agent-skill.js";
import { registerExportAgentSkills } from "./tools/export-agent-skills.js";

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
registerDeleteIssue(server);
registerMoveIssue(server);
registerListWorkspaces(server);
registerStartWorkspace(server);
registerGetWorkspaceDiff(server);
registerMergeWorkspace(server);
registerCloseWorkspace(server);
registerStopWorkspace(server);
registerDeleteWorkspace(server);
registerListTags(server);
registerCreateTag(server);
registerReadTerminal(server);
registerListSessions(server);
registerGetSessionStats(server);
registerGetDiffComments(server);
registerCreateDiffComment(server);
registerAddDependency(server);
registerRemoveDependency(server);
registerGetBoardStatus(server);
registerListAgentSkills(server);
registerGetAgentSkill(server);
registerCreateAgentSkill(server);
registerExportAgentSkills(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Agentic Kanban MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
