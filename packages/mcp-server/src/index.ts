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
import { registerGetFleetFriction } from "./tools/get-fleet-friction.js";
import { registerGetDiffComments } from "./tools/get-diff-comments.js";
import { registerCreateDiffComment } from "./tools/create-diff-comment.js";
import { registerAddDependency } from "./tools/add-dependency.js";
import { registerAnalyzeDependencies } from "./tools/analyze-dependencies.js";
import { registerRemoveDependency } from "./tools/remove-dependency.js";
import { registerCreateIssuesBatch } from "./tools/create-issues-batch.js";
import { registerUpdateDependenciesBatch } from "./tools/update-dependencies-batch.js";
import { registerContractCoupledIssues } from "./tools/contract-coupled-issues.js";
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
import { registerMarkReadyForMerge } from "./tools/mark-ready-for-merge.js";
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
import { registerExportHandoffBundle } from "./tools/export-handoff-bundle.js";
import {
  registerStartDrive,
  registerListDrives,
  registerGetDrive,
  registerFinishDrive,
} from "./tools/drives.js";
import { registerRegisterProject } from "./tools/register-project.js";
import { registerCreateProject } from "./tools/create-project.js";
import { registerListProjects } from "./tools/list-projects.js";
import { registerUnregisterProject } from "./tools/unregister-project.js";
import { registerAddProjectRepo } from "./tools/add-project-repo.js";
import { registerListProjectRepos } from "./tools/list-project-repos.js";
import { registerRemoveProjectRepo } from "./tools/remove-project-repo.js";
import { registerCleanupProject } from "./tools/cleanup-project.js";
import { registerGetPreference } from "./tools/get-preference.js";
import { registerSetPreference } from "./tools/set-preference.js";
import { registerInstallSkill } from "./tools/install-skill.js";
import { registerInitProject } from "./tools/init-project.js";
import { registerSessionHistory } from "./tools/session-history.js";
import { registerAnalyzeSession } from "./tools/analyze-session.js";
import { registerRecentSessions } from "./tools/recent-sessions.js";
import { registerBackfillFriction } from "./tools/backfill-friction.js";
import { registerSessionReviewEffectiveness } from "./tools/session-review-effectiveness.js";
import { registerReviewerFixes } from "./tools/reviewer-fixes.js";
import { registerButlerEnsure } from "./tools/butler-ensure.js";
import { registerButlerStop } from "./tools/butler-stop.js";
import { registerButlerList } from "./tools/butler-list.js";
import { registerGetButlerSkill, registerSetButlerSkill } from "./tools/butler-skill.js";
import { registerLaunchWorkspace } from "./tools/launch-workspace.js";
import { registerWaitWorkspace } from "./tools/wait-workspace.js";
import { registerDriveReviewEffectiveness } from "./tools/drive-review-effectiveness.js";

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
  get_fleet_friction: registerGetFleetFriction,
  get_diff_comments: registerGetDiffComments,
  create_diff_comment: registerCreateDiffComment,
  add_dependency: registerAddDependency,
  analyze_dependencies: registerAnalyzeDependencies,
  remove_dependency: registerRemoveDependency,
  create_issues_batch: registerCreateIssuesBatch,
  update_dependencies_batch: registerUpdateDependenciesBatch,
  contract_coupled_issues: registerContractCoupledIssues,
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
  mark_ready_for_merge: registerMarkReadyForMerge,
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
  export_handoff_bundle: registerExportHandoffBundle,
  start_drive: registerStartDrive,
  list_drives: registerListDrives,
  get_drive: registerGetDrive,
  finish_drive: registerFinishDrive,
  drive_review_effectiveness: registerDriveReviewEffectiveness,
  register_project: registerRegisterProject,
  create_project: registerCreateProject,
  list_projects: registerListProjects,
  unregister_project: registerUnregisterProject,
  add_project_repo: registerAddProjectRepo,
  list_project_repos: registerListProjectRepos,
  remove_project_repo: registerRemoveProjectRepo,
  cleanup_project: registerCleanupProject,
  get_preference: registerGetPreference,
  set_preference: registerSetPreference,
  install_skill: registerInstallSkill,
  init_project: registerInitProject,
  session_history: registerSessionHistory,
  analyze_session: registerAnalyzeSession,
  recent_sessions: registerRecentSessions,
  backfill_friction: registerBackfillFriction,
  session_review_effectiveness: registerSessionReviewEffectiveness,
  reviewer_fixes: registerReviewerFixes,
  butler_ensure: registerButlerEnsure,
  butler_stop: registerButlerStop,
  butler_list: registerButlerList,
  get_butler_skill: registerGetButlerSkill,
  set_butler_skill: registerSetButlerSkill,
  launch_workspace: registerLaunchWorkspace,
  wait_workspace: registerWaitWorkspace,
};

// Parse the `disabled_mcp_tools` preference into a normalized lookup set.
//
// This is the ONLY authority knob on the (unauthenticated, single-user) MCP surface, so
// the parse must be forgiving of how a human writes the pref. We:
//   - trim() every entry, so `"delete_issue, delete_workspace"` (the natural way to write
//     a comma list) disables BOTH, not just the first.
//   - lowercase every entry, applying a CASE-INSENSITIVE policy: tool names registered in
//     TOOL_REGISTRARS are all lowercase snake_case, so `"Delete_Issue"` must match
//     `delete_issue`. Callers MUST compare lowercased tool names against this set
//     (see main() — `name` keys are already lowercase).
// Dropping the trim/lowercase here is a silent security gap: a tool the user believes is
// disabled stays callable.
function normalizeDisabledEntry(entry: string): string {
  return entry.trim().toLowerCase();
}

async function getDisabledTools(): Promise<Set<string>> {
  try {
    const rows = await db.select({ value: schema.preferences.value })
      .from(schema.preferences)
      .where(eq(schema.preferences.key, "disabled_mcp_tools"))
      .limit(1);
    if (rows.length > 0 && rows[0].value) {
      return new Set(rows[0].value.split(",").map(normalizeDisabledEntry).filter(Boolean));
    }
  } catch {}
  return new Set();
}

/**
 * Build a fully-registered MCP server.
 *
 * A FACTORY rather than a module-level singleton because `McpServer` and a
 * transport are 1:1 — the HTTP transport (#136) needs a fresh pair per request in
 * stateless mode, so it cannot share one instance the way stdio does. Registration
 * is just closure creation, so calling this per request is cheap.
 */
export function createConfiguredServer(disabledTools: Set<string>): {
  server: McpServer;
  registered: number;
  skipped: number;
} {
  const server = new McpServer({ name: "agentic-kanban", version: "0.0.1" });
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
  return { server, registered, skipped };
}

async function main() {
  const disabledTools = await getDisabledTools();
  const { server, registered, skipped } = createConfiguredServer(disabledTools);

  if (skipped > 0) {
    console.error(`Skipped ${skipped} disabled tool(s): ${[...disabledTools].filter(t => TOOL_REGISTRARS[t]).join(", ")}`);
  }

  // HTTP mode (#136): serve over the network so a CONTAINERIZED builder can reach
  // the board. Stdio remains the default and the host path — a stdio config
  // describes a command the container cannot run, and the DB binding is a
  // native-Windows better-sqlite3, so path translation is a dead end.
  //
  // The token comes from the environment, never a flag: argv is world-readable in
  // the process list on both Windows and Linux.
  if (process.argv.includes("--http")) {
    const token = process.env.KANBAN_MCP_TOKEN;
    if (!token) {
      console.error(
        "Refusing to start MCP over HTTP without KANBAN_MCP_TOKEN — this endpoint " +
          "exposes the full board tool surface off-loopback.",
      );
      process.exit(1);
    }
    const portArg = process.argv[process.argv.indexOf("--http") + 1];
    const port = portArg && /^\d+$/.test(portArg) ? Number(portArg) : 0;

    const { startMcpHttpServer } = await import("./http-transport.js");
    const handle = await startMcpHttpServer({
      createServer: () => createConfiguredServer(disabledTools).server,
      token,
      port,
    });
    // The board parses this line to learn the OS-assigned port. Keep the format.
    console.error(`MCP_HTTP_PORT=${handle.port}`);
    console.error(`Agentic Kanban MCP server running on http (${registered} tools registered)`);
    return;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Agentic Kanban MCP server running on stdio (${registered} tools registered)`);
}

// Keep the stdio transport alive when a tool handler throws asynchronously. The MCP SDK
// wraps tool callbacks in try/catch and returns isError results for awaited throws, but a
// stray async rejection (e.g. a drizzle "Failed query: select ..." in an un-awaited promise
// or timer callback) escapes that and would otherwise crash the process — the agent's MCP
// client then reports `server "agentic-kanban" is not connected` and every board op fails.
// Mirror the main server's resilience: log to stderr (never stdout — that is the JSON-RPC
// stream) and stay up. (console.error writes to stderr, so it is safe here.)
process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException in MCP server:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandledRejection in MCP server:", reason);
});

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
