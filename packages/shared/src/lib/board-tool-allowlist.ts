/**
 * Which board MCP tools an agent working on a ticket may call (#1761). One constant for the
 * remote fleet bridge AND host builders, so isolation cannot diverge by placement.
 *
 * Pure string policy, safe on either side of the wire.
 *
 * The board owns merging, marking ready, moving status, preferences, starting or deleting work;
 * a builder gets its own ticket context, its own voice (`add_comment`) and `create_issue` for
 * out-of-scope findings.
 */
export const REMOTE_BOARD_TOOLS: readonly string[] = [
  "get_issue",
  "list_issues",
  "create_issue",
  "get_board_status",
  // #799 — the one WRITE that is a builder's own voice rather than a board decision.
  "add_comment",
];

/**
 * A HOST builder: the remote set plus what only a host session can use. `propose_transition` is
 * the workflow's own exit (a remote worker's card moves on a clean exit instead), and
 * `approve_tool_use` is the `--permission-prompt-tool` the board wires into Claude launches.
 */
export const BUILDER_BOARD_TOOLS: readonly string[] = [...REMOTE_BOARD_TOOLS, "propose_transition", "approve_tool_use"];

/** A reviewer additionally reads the diff and scorecard it is judging. */
export const REVIEW_BOARD_TOOLS: readonly string[] = [
  ...BUILDER_BOARD_TOOLS,
  "get_workspace_diff",
  "get_workspace_scorecard",
];

/** Env var carrying the comma-separated allowlist to the stdio MCP server (absent = every tool). */
export const MCP_ALLOWED_TOOLS_ENV = "KANBAN_MCP_ALLOWED_TOOLS";
