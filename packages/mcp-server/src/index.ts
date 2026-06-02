#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { db, schema } from "./db.js";
import { eq } from "drizzle-orm";
import { registerGetContext } from "./tools/get-context.js";
import { registerListIssues } from "./tools/list-issues.js";
import { registerGetIssue } from "./tools/get-issue.js";
import { registerCreateIssue } from "./tools/create-issue.js";
import { registerCreateSubIssue } from "./tools/create-sub-issue.js";
import { registerAttachArtifact } from "./tools/attach-artifact.js";
import { registerUpdateIssue } from "./tools/update-issue.js";
import { registerDeleteIssue } from "./tools/delete-issue.js";
import { registerMoveIssue } from "./tools/move-issue.js";
import { registerListWorkspaces } from "./tools/list-workspaces.js";
import { registerStartWorkspace } from "./tools/start-workspace.js";
import { registerGetWorkspaceDiff } from "./tools/get-workspace-diff.js";
import { registerGetWorkspaceScorecard } from "./tools/get-workspace-scorecard.js";
import { registerMergeWorkspace } from "./tools/merge-workspace.js";
import { registerCloseWorkspace } from "./tools/close-workspace.js";
import { registerStopWorkspace } from "./tools/stop-workspace.js";
import { registerDeleteWorkspace } from "./tools/delete-workspace.js";
import { registerDeleteStatus } from "./tools/delete-status.js";
import { registerListTags } from "./tools/list-tags.js";
import { registerCreateTag } from "./tools/create-tag.js";
import { registerReadTerminal } from "./tools/read-terminal.js";
import { registerListSessions } from "./tools/list-sessions.js";
import { registerGetSessionTranscript } from "./tools/get-session-transcript.js";
import { registerSearchSessions } from "./tools/search-sessions.js";
import { registerGetSessionStats } from "./tools/get-session-stats.js";
import { registerGetDiffComments } from "./tools/get-diff-comments.js";
import { registerCreateDiffComment } from "./tools/create-diff-comment.js";
import { registerAddDependency } from "./tools/add-dependency.js";
import { registerAnalyzeDependencies } from "./tools/analyze-dependencies.js";
import { registerRemoveDependency } from "./tools/remove-dependency.js";
import { registerCreateIssuesBatch } from "./tools/create-issues-batch.js";
import { registerUpdateDependenciesBatch } from "./tools/update-dependencies-batch.js";
import { registerGetBoardStatus } from "./tools/get-board-status.js";
import { registerGetIssueSummary } from "./tools/get-issue-summary.js";
import { registerListAgentSkills } from "./tools/list-agent-skills.js";
import { registerGetAgentSkill } from "./tools/get-agent-skill.js";
import { registerCreateAgentSkill } from "./tools/create-agent-skill.js";
import { registerExportAgentSkills } from "./tools/export-agent-skills.js";
import { registerApproveToolUse } from "./tools/approve-tool-use.js";
import { registerRelaunchWorkspace } from "./tools/relaunch-workspace.js";
import { registerReviewWorkspace } from "./tools/review-workspace.js";
import { registerAskButler } from "./tools/ask-butler.js";
import { registerButlerInterrupt } from "./tools/butler-interrupt.js";
import { registerButlerSetModel } from "./tools/butler-set-model.js";
import { registerButlerSetProfile } from "./tools/butler-set-profile.js";
import { registerButlerState } from "./tools/butler-state.js";
import { registerProposeTransition } from "./tools/propose-transition.js";
import { registerClarifyOrPropose } from "./tools/clarify-or-propose.js";
import { registerAnalyzeTouchedFiles } from "./tools/analyze-touched-files.js";
import { registerCheckIssueOverlap } from "./tools/check-issue-overlap.js";
import {
  registerListWorkflowTemplates,
  registerGetWorkflowTemplate,
  registerCreateWorkflowTemplate,
  registerUpdateWorkflowTemplate,
  registerDeleteWorkflowTemplate,
} from "./tools/workflow-templates.js";
import { registerFindSimilarFailures } from "./tools/find-similar-failures.js";
import {
  registerOpenSpecListSpecs,
  registerShowSpec,
  registerValidateChange,
} from "./tools/openspec.js";
import { registerGetBoardRiskDigest } from "./tools/get-board-risk-digest.js";

const TOOL_REGISTRARS: Record<string, (server: McpServer) => void> = {
  get_context: registerGetContext,
  list_issues: registerListIssues,
  get_issue: registerGetIssue,
  create_issue: registerCreateIssue,
  create_sub_issue: registerCreateSubIssue,
  attach_artifact: registerAttachArtifact,
  update_issue: registerUpdateIssue,
  delete_issue: registerDeleteIssue,
  move_issue: registerMoveIssue,
  list_workspaces: registerListWorkspaces,
  start_workspace: registerStartWorkspace,
  get_workspace_diff: registerGetWorkspaceDiff,
  get_workspace_scorecard: registerGetWorkspaceScorecard,
  merge_workspace: registerMergeWorkspace,
  close_workspace: registerCloseWorkspace,
  stop_workspace: registerStopWorkspace,
  delete_workspace: registerDeleteWorkspace,
  delete_status: registerDeleteStatus,
  list_tags: registerListTags,
  create_tag: registerCreateTag,
  read_terminal: registerReadTerminal,
  list_sessions: registerListSessions,
  get_session_transcript: registerGetSessionTranscript,
  search_sessions: registerSearchSessions,
  get_session_stats: registerGetSessionStats,
  get_diff_comments: registerGetDiffComments,
  create_diff_comment: registerCreateDiffComment,
  add_dependency: registerAddDependency,
  analyze_dependencies: registerAnalyzeDependencies,
  remove_dependency: registerRemoveDependency,
  create_issues_batch: registerCreateIssuesBatch,
  update_dependencies_batch: registerUpdateDependenciesBatch,
  get_board_status: registerGetBoardStatus,
  get_issue_summary: registerGetIssueSummary,
  list_agent_skills: registerListAgentSkills,
  get_agent_skill: registerGetAgentSkill,
  create_agent_skill: registerCreateAgentSkill,
  export_agent_skills: registerExportAgentSkills,
  approve_tool_use: registerApproveToolUse,
  relaunch_workspace: registerRelaunchWorkspace,
  review_workspace: registerReviewWorkspace,
  ask_butler: registerAskButler,
  butler_interrupt: registerButlerInterrupt,
  butler_set_model: registerButlerSetModel,
  butler_set_profile: registerButlerSetProfile,
  butler_state: registerButlerState,
  propose_transition: registerProposeTransition,
  clarify_or_propose: registerClarifyOrPropose,
  analyze_touched_files: registerAnalyzeTouchedFiles,
  check_issue_overlap: registerCheckIssueOverlap,
  list_workflow_templates: registerListWorkflowTemplates,
  get_workflow_template: registerGetWorkflowTemplate,
  create_workflow_template: registerCreateWorkflowTemplate,
  update_workflow_template: registerUpdateWorkflowTemplate,
  delete_workflow_template: registerDeleteWorkflowTemplate,
  find_similar_failures: registerFindSimilarFailures,
  openspec_list_specs: registerOpenSpecListSpecs,
  show_spec: registerShowSpec,
  validate_change: registerValidateChange,
  get_board_risk_digest: registerGetBoardRiskDigest,
};

async function getDisabledTools(): Promise<Set<string>> {
  try {
    const rows = await db.select({ value: schema.preferences.value })
      .from(schema.preferences)
      .where(eq(schema.preferences.key, "disabled_mcp_tools"))
      .limit(1);
    if (rows.length > 0 && rows[0].value) {
      return new Set(rows[0].value.split(",").filter(Boolean));
    }
  } catch {}
  return new Set();
}

const server = new McpServer({
  name: "agentic-kanban",
  version: "0.0.1",
});

async function main() {
  const disabledTools = await getDisabledTools();

  let registered = 0;
  let skipped = 0;
  for (const [name, register] of Object.entries(TOOL_REGISTRARS)) {
    if (disabledTools.has(name)) {
      skipped++;
    } else {
      register(server);
      registered++;
    }
  }

  if (skipped > 0) {
    console.error(`Skipped ${skipped} disabled tool(s): ${[...disabledTools].filter(t => TOOL_REGISTRARS[t]).join(", ")}`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Agentic Kanban MCP server running on stdio (${registered} tools registered)`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
